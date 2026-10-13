import { randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ScratchDir } from "../_kit/scratchDir";
import type { RecordCapture, RecordEngine } from "./captureService";
import type { CaptureSelection, CaptureWindowImage, RecordingAction, RecordingControls } from "@shared/features/capture/windowContract";
import {
  DEFAULT_RECORDING_DURATION_MS, RECORDING_SNAPSHOT_LIMIT, type RecordingConfig,
} from "@shared/features/capture/recordingContract";
import { createRecordingSink, payloadBuffer } from "./recordingSink";
import { recordingFormats, transcodeGeometry, transcodeRecording, validateCaptureEncodingGeometry, type CaptureFfmpegResource } from "./transcode";
import { CaptureCanceledError, CaptureRecordingError } from './captureErrors';
import { openRecordingWindow, deferred, canceled, dimensions as recordingDimensions, type PrivateRecordingSession } from './recordingSession';
import { resolveCapturePlatform, type CapturePlatformAdapter } from './platforms';
import { portalRecordingConfig } from './platforms/sources';

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(canceled()); return; }
    const abort = () => { clearTimeout(timer); reject(canceled()); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export interface CaptureSourceStillDeps { scratch: ScratchDir; preloadPath?: string }

function snapshotFrame(data: unknown, rawWidth: unknown, rawHeight: unknown) {
  const size = recordingDimensions(rawWidth, rawHeight);
  const png = payloadBuffer(data, RECORDING_SNAPSHOT_LIMIT);
  if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
    png.readUInt32BE(16) !== size.width || png.readUInt32BE(20) !== size.height) throw new Error('invalid snapshot PNG');
  return { png: Buffer.from(png), ...size, hdrToneMapped: false as const };
}

function portalImage(frame: ReturnType<typeof snapshotFrame>, config: RecordingConfig): CaptureWindowImage {
  const sourceSize = { width: frame.width, height: frame.height };
  return { dataUrl: `data:image/png;base64,${frame.png.toString('base64')}`, ...sourceSize,
    selection: { sourceId: config.sourceId, sourceKind: config.sourceKind, coordinateSpace: 'source',
      sourceSize, crop: { x: 0, y: 0, ...sourceSize }, hdrToneMapped: false } };
}

export function createCaptureSourceStill(deps: CaptureSourceStillDeps) {
  return (sourceId: string, sourceSize: { width: number; height: number }, signal: AbortSignal) => captureSourceStill(sourceId, sourceSize, signal, deps);
}

/** Snapshot of the source granted by the portal, independent of the recording encoder. */
export function createCapturePortalFrame(deps: CaptureSourceStillDeps) {
  return async (signal: AbortSignal): Promise<CaptureWindowImage> => {
    const config = portalRecordingConfig('snapshot');
    const frame = await acquireSnapshot(config, signal, deps);
    return portalImage(frame, config);
  };
}

/** Full-resolution window frame. Source size is advisory for windows; track size is authoritative. */
export async function captureSourceStill(sourceId: string, sourceSize: { width: number; height: number },
  signal: AbortSignal, deps: CaptureSourceStillDeps): Promise<{ png: Buffer; width: number; height: number; hdrToneMapped: false }> {
  return acquireSnapshot({ sourceId, sourceKind: sourceId.startsWith('screen:') ? 'screen' : 'window', sourceSize, fps: 30, mode: 'snapshot' }, signal, deps);
}

async function acquireSnapshot(config: RecordingConfig, signal: AbortSignal, deps: CaptureSourceStillDeps) {
  const id = randomBytes(16).toString("hex");
  const dir = deps.scratch.create(id);
  const complete = deferred<{ png: Buffer; width: number; height: number; hdrToneMapped: false }>();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  let failure: Error | undefined;
  const fail = (error: Error) => { failure ??= error; complete.reject(error); controller.abort(); };
  const timer = setTimeout(() => fail(new Error("Desktop snapshot timed out")), config.acquisition === 'portal' ? 60000 : 20000);
  let window: Awaited<ReturnType<typeof openRecordingWindow>> | undefined;
  try {
    window = await openRecordingWindow(dir, config, controller.signal, {
      fail,
      event(event) { if (event.type === "error") fail(event.canceled ? new CaptureCanceledError(event.message)
        : new CaptureRecordingError(event.permissionDenied ? "permission-denied" : "failed", event.message)); },
      async chunk() { throw new Error("snapshot window cannot write recording chunks"); },
      async snapshot(data, rawWidth, rawHeight) {
        complete.resolve(snapshotFrame(data, rawWidth, rawHeight));
      },
    }, deps.preloadPath);
    return await complete.promise;
  } catch (error) { throw failure ?? error;
  } finally { clearTimeout(timer); window?.dispose(); controller.abort(); signal.removeEventListener('abort', abort); deps.scratch.remove(id); }
}

export interface RecordingWindows {
  select(mode: "record", signal: AbortSignal): Promise<CaptureSelection | null>;
  selectPrepared?(mode: 'record', image: CaptureWindowImage, signal: AbortSignal): Promise<CaptureSelection | null>;
  createRecordingControls(selection: CaptureSelection, onAction: (action: RecordingAction, error?: Error) => void): RecordingControls;
}
export interface RecordEngineDeps extends CaptureSourceStillDeps {
  windows: RecordingWindows;
  ffmpeg: CaptureFfmpegResource | null;
  platform?: NodeJS.Platform;
  portal?: boolean;
  adapter?: CapturePlatformAdapter;
  powerSaveBlocker?: { start(type: 'prevent-display-sleep'): number; stop(id: number): void };
  log: { warn(...args: unknown[]): void; error(...args: unknown[]): void };
}

export function createRecordEngine(deps: RecordEngineDeps): RecordEngine & { dispose(): void; stop(): void; pauseOrResume(): void } {
  const platform = deps.platform ?? process.platform;
  const active = new Set<AbortController>();
  let stopAction: (() => void) | undefined;
  let pauseAction: (() => void) | undefined;
  const adapter = deps.adapter ?? resolveCapturePlatform(platform, deps);
  const formats = recordingFormats(deps.ffmpeg, platform);
  return {
    formats: () => ({ video: [...formats.video], gif: formats.gif }),
    dispose() { for (const controller of active) controller.abort(); },
    stop() { stopAction?.(); },
    pauseOrResume() { pauseAction?.(); },
    async record(options, parentSignal, onState) {
      if (!deps.ffmpeg || (options.output === "gif" ? !formats.gif : !formats.video.includes(options.output))) {
        throw new CaptureRecordingError("encoder-unavailable", `${options.output} encoder is unavailable`);
      }
      const controller = new AbortController();
      active.add(controller);
      const abort = () => controller.abort();
      parentSignal.addEventListener("abort", abort, { once: true });
      if (parentSignal.aborted) abort();
      const signal = controller.signal;
      const id = randomBytes(16).toString("hex");
      let dir = "";
      let keepResult = false;
      let controls: RecordingControls | undefined;
      let engineWindow: Awaited<ReturnType<typeof openRecordingWindow>> | undefined;
      let sink: Awaited<ReturnType<typeof createRecordingSink>> | undefined;
      let tick: ReturnType<typeof setInterval> | undefined;
      let acquisitionTimer: ReturnType<typeof setTimeout> | undefined;
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      let releasePower: (() => void) | undefined;
      let state: "starting" | "ready" | "recording" | "paused" | "stopping" | "stopped" = "starting";
      let runningSince = 0;
      let activeMs = 0;
      let firstStartedAt = 0;
      let fatalError: Error | undefined;
      const now = () => performance.now();
      const elapsed = () => Math.round(activeMs + (state === "recording" ? now() - runningSince : 0));
      const ready = deferred<{ width: number; height: number }>();
      const preview = deferred<CaptureWindowImage>();
      let snapshotConsumed = false;
      const done = deferred<void>();
      const armed = deferred<void>();
      const fail = (error: Error) => {
        // Only user/session cancellation is a normal null result. Internal failures abort
        // devices and the encoder too, while preserving their failure for the parent service.
        if (!signal.aborted) { fatalError = error; controller.abort(); }
        ready.reject(error); preview.reject(error); armed.reject(error); done.reject(error);
      };
      const durationLimit = options.maxDurationMs ?? DEFAULT_RECORDING_DURATION_MS;
      const action = (command: RecordingAction, error?: Error) => {
        if (error) { fail(error); return; }
        if (command === "cancel") { controller.abort(); return; }
        if (command === "stop") {
          if (!["recording", "paused"].includes(state)) return;
          if (state === "recording") activeMs += now() - runningSince;
          state = "stopping";
          // Encoding UI is shown only after the stream and final chunk are closed.
          engineWindow?.send("stop");
          clearInterval(tick);
          stopTimer = setTimeout(() => fail(new Error("MediaRecorder did not finish writing its last chunk")), 30000);
          return;
        }
        if (command === "pause" && state === "recording") engineWindow?.send("pause");
        if (command === "resume" && state === "paused") engineWindow?.send("resume");
      };
      const stopThisSession = () => {
        if (state === "starting" || state === "ready") action("cancel");
        else action("stop");
      };
      stopAction = stopThisSession;
      const pauseThisSession = () => action(state === 'paused' ? 'resume' : 'pause');
      pauseAction = pauseThisSession;
      try {
        dir = deps.scratch.create(id);
        sink = await createRecordingSink(join(dir, "source.webm"));
        const callbacks: Pick<PrivateRecordingSession, 'event' | 'chunk' | 'snapshot' | 'fail'> = {
          fail,
          async chunk(sequence, data) {
            if (!sink || !["recording", "paused", "stopping"].includes(state) || signal.aborted) throw new Error("recording session is not accepting chunks");
            await sink.append(sequence, data);
          },
          async snapshot(data, width, height) {
            if (!adapter.source.providesPreview || state !== 'starting' || snapshotConsumed) throw new Error('recording window cannot submit snapshots');
            snapshotConsumed = true;
            preview.resolve(portalImage(snapshotFrame(data, width, height), portalRecordingConfig('record')));
          },
          async event(event) {
            if (event.type === "error") { fail(event.canceled ? new CaptureCanceledError(event.message)
              : new CaptureRecordingError(event.permissionDenied ? "permission-denied" : "failed", event.message)); return; }
            if (event.type === "ready") {
              if (state !== "starting") throw new Error("duplicate recorder ready event");
              state = "ready"; clearTimeout(acquisitionTimer); ready.resolve({ width: event.width, height: event.height }); return;
            }
            if (event.type === "armed") {
              if (state !== "ready") throw new Error("unexpected recording frame arm event");
              armed.resolve(); return;
            }
            if (event.type === "started") {
              if (state !== "ready") throw new Error("unexpected recorder start event");
              state = "recording"; runningSince = now(); firstStartedAt = runningSince;
              clearTimeout(acquisitionTimer);
              onState("recording"); controls?.update({ state: "recording", elapsedMs: 0 }); return;
            }
            if (event.type === "paused") {
              if (state === "stopping") return;
              if (state !== "recording") throw new Error("unexpected recorder pause event");
              activeMs += now() - runningSince; state = "paused";
              onState("paused"); controls?.update({ state: "paused", elapsedMs: elapsed() }); return;
            }
            if (event.type === "resumed") {
              if (state === "stopping") return;
              if (state !== "paused") throw new Error("unexpected recorder resume event");
              state = "recording"; runningSince = now(); onState("recording"); return;
            }
            if (event.type === "stopped") {
              if (state !== "stopping") throw new Error("unexpected recorder stop event");
              state = "stopped"; await sink?.close(); done.resolve();
            }
          },
        };
        const acquired = await adapter.source.acquireRecording({
          signal, fps: options.fps ?? 30, framePipeline: adapter.framePipeline,
          windows: deps.windows, ready: ready.promise, preview: preview.promise,
          async open(config) {
            acquisitionTimer = setTimeout(() => fail(new Error('Desktop capture acquisition timed out')), adapter.source.acquisitionTimeoutMs);
            engineWindow = await openRecordingWindow(dir, config, signal, callbacks, deps.preloadPath);
            return engineWindow;
          },
        });
        if (!acquired || signal.aborted) return null;
        const { selection, size: actualSize } = acquired;
        controls = deps.windows.createRecordingControls(selection, action);
        controls.setContentProtection(true);
        clearTimeout(acquisitionTimer);
        validateCaptureEncodingGeometry(platform, options.output, transcodeGeometry(selection.crop, actualSize, options.output));
        releasePower = adapter.beginRecording();
        acquisitionTimer = setTimeout(() => fail(new Error("Desktop recorder frame preparation timed out")), 20000);
        engineWindow!.send("arm");
        for (let countdown = 3; countdown >= 1; countdown--) {
          controls.update({ state: "countdown", elapsedMs: 0, countdown });
          await wait(1000, signal);
        }
        if (signal.aborted) throw fatalError ?? canceled();
        clearTimeout(acquisitionTimer);
        acquisitionTimer = setTimeout(() => fail(new Error("Desktop recorder did not start")), 20000);
        await armed.promise;
        if (signal.aborted) throw fatalError ?? canceled();
        await controls.hideForRecording?.();
        engineWindow!.send("start");
        tick = setInterval(() => {
          if (state === "recording" || state === "paused") {
            const duration = elapsed(); controls?.update({ state, elapsedMs: duration });
            if (duration >= durationLimit) action("stop");
            // A pause cannot keep devices open indefinitely; bound the wall-clock session too.
            if (firstStartedAt && now() - firstStartedAt > Math.max(durationLimit * 2, 60000)) action("stop");
          }
        }, 100);
        await done.promise;
        clearInterval(tick); clearTimeout(stopTimer);
        engineWindow!.dispose(); engineWindow = undefined;
        if (signal.aborted) throw fatalError ?? canceled();
        if (!sink.bytes) throw new CaptureRecordingError("failed", "No desktop recording frames were written");
        onState("encoding"); controls.update({ state: "encoding", elapsedMs: Math.round(activeMs) });
        const crop = selection.crop;
        const encoded = await transcodeRecording(deps.ffmpeg, platform, join(dir, "source.webm"),
          join(dir, `result.${options.output}`), actualSize, crop, options, signal);
        if (signal.aborted) throw fatalError ?? canceled();
        await unlink(join(dir, "source.webm"));
        await unlink(join(dir, "recording.html"));
        if (signal.aborted) throw fatalError ?? canceled();
        keepResult = true;
        return { ...encoded, durationMs: Math.round(activeMs), hdrToneMapped: false,
          disposeFile: () => deps.scratch.remove(id) } as RecordCapture;
      } catch (error) {
        if (fatalError) throw fatalError;
        if (signal.aborted) return null;
        throw error;
      } finally {
        try { releasePower?.(); } catch (error) { deps.log.warn('[Capture] recording sleep blocker cleanup failed', error); }
        clearInterval(tick); clearTimeout(acquisitionTimer); clearTimeout(stopTimer);
        engineWindow?.dispose(); controls?.dispose();
        await sink?.close().catch(error => deps.log.warn("[Capture] recording writer cleanup failed", error));
        parentSignal.removeEventListener("abort", abort);
        active.delete(controller);
        if (stopAction === stopThisSession) stopAction = undefined;
        if (pauseAction === pauseThisSession) pauseAction = undefined;
        if (!keepResult) deps.scratch.remove(id);
      }
    },
  };
}
