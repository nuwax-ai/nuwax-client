import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { createHash, randomBytes } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ScratchDir } from "../_kit/scratchDir";
import type { RecordCapture, RecordEngine } from "./captureService";
import type { CaptureState, RecordOptions } from "@shared/features/capture/contract";
import type { CaptureSelection, RecordingAction, RecordingControls } from "@shared/features/capture/windowContract";
import {
  DEFAULT_RECORDING_DURATION_MS, RECORDING_IPC, RECORDING_SNAPSHOT_LIMIT,
  type RecordingCommand, type RecordingConfig, type RecordingEvent,
} from "@shared/features/capture/recordingContract";
import { recordingScript } from "@renderer/features/capture/recordingPage";
import { createRecordingSink, payloadBuffer } from "./recordingSink";
import { CaptureRecordingError, recordingFormats, transcodeRecording, type CaptureFfmpegResource } from "./transcode";

interface PrivateRecordingSession {
  window: BrowserWindow;
  url: string;
  config: RecordingConfig;
  configured: boolean;
  event(event: RecordingEvent): void | Promise<void>;
  chunk(sequence: unknown, data: unknown): Promise<void>;
  snapshot(data: unknown, width: unknown, height: unknown): Promise<void>;
  fail(error: Error): void;
}

const sessions = new Map<number, PrivateRecordingSession>();
let handlersInstalled = false;

/** Both WebContents identity and the current main document must match this round's window. */
function sessionFor(event: IpcMainInvokeEvent): PrivateRecordingSession {
  const entry = sessions.get(event.sender.id);
  if (!entry || entry.window.isDestroyed() || event.sender !== entry.window.webContents ||
    event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== entry.url) {
    throw new Error("untrusted capture recording window");
  }
  return entry;
}

function dimensions(width: unknown, height: unknown): { width: number; height: number } {
  if (typeof width !== "number" || typeof height !== "number" ||
    !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
    width < 1 || height < 1 || width > 16384 || height > 16384) throw new Error("invalid recording frame dimensions");
  return { width, height };
}

function installHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  ipcMain.handle(RECORDING_IPC.CONFIG, event => {
    const session = sessionFor(event);
    if (session.configured) throw new Error("recording configuration was already consumed");
    session.configured = true;
    return session.config;
  });
  ipcMain.handle(RECORDING_IPC.EVENT, async (event, raw: unknown) => {
    const session = sessionFor(event);
    try {
      if (!session.configured || !raw || typeof raw !== "object") throw new Error("invalid recording event");
      const value = raw as Record<string, unknown>;
      if (value.type === "ready") {
        const size = dimensions(value.width, value.height);
        if (typeof value.mime !== "string" || !/^video\/webm(?:;codecs=vp[89])?$/.test(value.mime)) throw new Error("invalid recorder MIME");
        await session.event({ type: "ready", ...size, mime: value.mime });
      } else if (value.type === "error") {
        if (typeof value.message !== "string" || value.message.length > 2048) throw new Error("invalid recorder error");
        await session.event({ type: "error", message: value.message, permissionDenied: value.permissionDenied === true });
      } else if (["started", "paused", "resumed", "stopped"].includes(String(value.type))) {
        await session.event({ type: value.type as "started" | "paused" | "resumed" | "stopped" });
      } else throw new Error("unknown recording event");
    } catch (error) { session.fail(asError(error)); throw error; }
  });
  ipcMain.handle(RECORDING_IPC.CHUNK, async (event, sequence: unknown, data: unknown) => {
    const session = sessionFor(event);
    try { await session.chunk(sequence, data); } catch (error) { session.fail(asError(error)); throw error; }
  });
  ipcMain.handle(RECORDING_IPC.SNAPSHOT, async (event, data: unknown, width: unknown, height: unknown) => {
    const session = sessionFor(event);
    try { await session.snapshot(data, width, height); } catch (error) { session.fail(asError(error)); throw error; }
  });
}

function uninstallUnusedHandlers() {
  if (sessions.size || !handlersInstalled) return;
  handlersInstalled = false;
  for (const channel of [RECORDING_IPC.CONFIG, RECORDING_IPC.EVENT, RECORDING_IPC.CHUNK, RECORDING_IPC.SNAPSHOT]) ipcMain.removeHandler(channel);
}

const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error));
const canceled = () => new Error("capture was canceled");
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Acquisition can fail while loadFile is still awaiting. Mark handled until the owner awaits it.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(canceled()); return; }
    const abort = () => { clearTimeout(timer); reject(canceled()); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export interface CaptureSourceStillDeps { scratch: ScratchDir; preloadPath?: string }

async function openRecordingWindow(dir: string, config: RecordingConfig, signal: AbortSignal,
  callbacks: Pick<PrivateRecordingSession, "event" | "chunk" | "snapshot" | "fail">,
  preloadPath = join(__dirname, "..", "preload", "captureRecording.js")) {
  const html = join(dir, "recording.html");
  const hash = createHash("sha256").update(recordingScript).digest("base64");
  await writeFile(html, `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; media-src blob:; connect-src 'none'; img-src blob: data:;"><title>Capture engine</title></head><body style="margin:0;overflow:hidden"><script>${recordingScript}</script></body></html>`, { mode: 0o600 });
  if (signal.aborted) throw canceled();
  const window = new BrowserWindow({ width: 32, height: 32, show: false, frame: false, skipTaskbar: true,
    webPreferences: { preload: preloadPath, contextIsolation: true, sandbox: true, nodeIntegration: false,
      webSecurity: true, backgroundThrottling: false, partition: `capture-recorder-${randomBytes(16).toString("hex")}` } });
  const url = pathToFileURL(html).href;
  const entry: PrivateRecordingSession = { window, url, config, configured: false, ...callbacks };
  sessions.set(window.webContents.id, entry);
  installHandlers();
  const id = window.webContents.id;
  const interrupted = deferred<void>();
  let disposed = false;
  const send = (command: RecordingCommand) => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(RECORDING_IPC.COMMAND, command);
  };
  const onAbort = () => {
    const error = canceled();
    send("cancel"); callbacks.fail(error); interrupted.reject(error); dispose();
  };
  const onClosed = () => {
    if (!disposed) {
      const error = new Error("Capture engine window closed"); callbacks.fail(error); interrupted.reject(error);
    }
  };
  window.on("closed", onClosed);
  window.webContents.on("render-process-gone", (_event, details) => {
    const error = new Error(`Capture renderer exited: ${details.reason}`); callbacks.fail(error); interrupted.reject(error);
  });
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.webContents.on("will-attach-webview", event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const session = window.webContents.session;
  session.setPermissionCheckHandler((contents, permission, _origin, details) =>
    contents === window.webContents && permission === "media" && details.isMainFrame === true && contents.mainFrame.url === url);
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(contents === window.webContents && permission === "media" && details.isMainFrame === true && contents.mainFrame.url === url);
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", onAbort);
    sessions.delete(id);
    uninstallUnusedHandlers();
    session.setPermissionCheckHandler(null);
    session.setPermissionRequestHandler(null);
    if (!window.isDestroyed()) window.destroy();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([window.loadFile(html), interrupted.promise]);
    if (signal.aborted) onAbort();
    return { window, send, dispose };
  } catch (error) { dispose(); throw error; }
}

export function createCaptureSourceStill(deps: CaptureSourceStillDeps) {
  return (sourceId: string, sourceSize: { width: number; height: number }, signal: AbortSignal) => captureSourceStill(sourceId, sourceSize, signal, deps);
}

/** Full-resolution window frame. Source size is advisory for windows; track size is authoritative. */
export async function captureSourceStill(sourceId: string, sourceSize: { width: number; height: number },
  signal: AbortSignal, deps: CaptureSourceStillDeps): Promise<{ png: Buffer; width: number; height: number; hdrToneMapped: false }> {
  const id = randomBytes(16).toString("hex");
  const dir = deps.scratch.create(id);
  const complete = deferred<{ png: Buffer; width: number; height: number; hdrToneMapped: false }>();
  const timer = setTimeout(() => complete.reject(new Error("Desktop snapshot timed out")), 20000);
  let window: Awaited<ReturnType<typeof openRecordingWindow>> | undefined;
  try {
    window = await openRecordingWindow(dir, { sourceId, sourceKind: sourceId.startsWith("screen:") ? "screen" : "window",
      sourceSize, fps: 30, mode: "snapshot" }, signal, {
      fail: complete.reject,
      event(event) { if (event.type === "error") complete.reject(new CaptureRecordingError(event.permissionDenied ? "permission-denied" : "failed", event.message)); },
      async chunk() { throw new Error("snapshot window cannot write recording chunks"); },
      async snapshot(data, rawWidth, rawHeight) {
        const size = dimensions(rawWidth, rawHeight);
        const png = payloadBuffer(data, RECORDING_SNAPSHOT_LIMIT);
        if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
          png.readUInt32BE(16) !== size.width || png.readUInt32BE(20) !== size.height) throw new Error("invalid snapshot PNG");
        complete.resolve({ png: Buffer.from(png), ...size, hdrToneMapped: false });
      },
    }, deps.preloadPath);
    return await complete.promise;
  } finally { clearTimeout(timer); window?.dispose(); deps.scratch.remove(id); }
}

export interface RecordingWindows {
  select(mode: "record", signal: AbortSignal): Promise<CaptureSelection | null>;
  createRecordingControls(selection: CaptureSelection, onAction: (action: RecordingAction, error?: Error) => void): RecordingControls;
}
export interface RecordEngineDeps extends CaptureSourceStillDeps {
  windows: RecordingWindows;
  ffmpeg: CaptureFfmpegResource | null;
  platform?: NodeJS.Platform;
  log: { warn(...args: unknown[]): void; error(...args: unknown[]): void };
}

export function createRecordEngine(deps: RecordEngineDeps): RecordEngine & { dispose(): void; stop(): void } {
  const platform = deps.platform ?? process.platform;
  const active = new Set<AbortController>();
  let stopAction: (() => void) | undefined;
  const formats = recordingFormats(deps.ffmpeg, platform);
  return {
    formats: () => ({ video: [...formats.video], gif: formats.gif }),
    dispose() { for (const controller of active) controller.abort(); },
    stop() { stopAction?.(); },
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
      let state: "starting" | "ready" | "recording" | "paused" | "stopping" | "stopped" = "starting";
      let runningSince = 0;
      let activeMs = 0;
      let firstStartedAt = 0;
      let fatalError: Error | undefined;
      const now = () => performance.now();
      const elapsed = () => Math.round(activeMs + (state === "recording" ? now() - runningSince : 0));
      const ready = deferred<{ width: number; height: number }>();
      const done = deferred<void>();
      const fail = (error: Error) => {
        // Only user/session cancellation is a normal null result. Internal failures abort
        // devices and the encoder too, while preserving their failure for the parent service.
        if (!signal.aborted) { fatalError = error; controller.abort(); }
        ready.reject(error); done.reject(error);
      };
      const durationLimit = options.maxDurationMs ?? DEFAULT_RECORDING_DURATION_MS;
      const action = (command: RecordingAction, error?: Error) => {
        if (error) { fail(error); return; }
        if (command === "cancel") { controller.abort(); return; }
        if (command === "stop") {
          if (!["recording", "paused"].includes(state)) return;
          if (state === "recording") activeMs += now() - runningSince;
          state = "stopping";
          controls?.update({ state: "encoding", elapsedMs: Math.round(activeMs) });
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
      try {
        const selection = await deps.windows.select("record", signal);
        if (!selection || signal.aborted) return null;
        dir = deps.scratch.create(id);
        sink = await createRecordingSink(join(dir, "source.webm"));
        controls = deps.windows.createRecordingControls(selection, action);
        controls.setContentProtection(true);
        acquisitionTimer = setTimeout(() => fail(new Error("Desktop recording acquisition timed out")), 20000);
        engineWindow = await openRecordingWindow(dir, { sourceId: selection.sourceId, sourceKind: selection.sourceKind,
          sourceSize: selection.sourceSize, fps: options.fps ?? 30, mode: "record" }, signal, {
          fail,
          async chunk(sequence, data) {
            if (!sink || !["recording", "paused", "stopping"].includes(state) || signal.aborted) throw new Error("recording session is not accepting chunks");
            await sink.append(sequence, data);
          },
          async snapshot() { throw new Error("recording window cannot submit snapshots"); },
          async event(event) {
            if (event.type === "error") { fail(new CaptureRecordingError(event.permissionDenied ? "permission-denied" : "failed", event.message)); return; }
            if (event.type === "ready") {
              if (state !== "starting") throw new Error("duplicate recorder ready event");
              state = "ready"; ready.resolve({ width: event.width, height: event.height }); return;
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
        }, deps.preloadPath);
        const actualSize = await ready.promise;
        clearTimeout(acquisitionTimer);
        for (let countdown = 3; countdown >= 1; countdown--) {
          controls.update({ state: "countdown", elapsedMs: 0, countdown });
          await wait(1000, signal);
        }
        if (signal.aborted) throw fatalError ?? canceled();
        acquisitionTimer = setTimeout(() => fail(new Error("Desktop recorder did not start")), 20000);
        engineWindow.send("start");
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
        engineWindow.dispose(); engineWindow = undefined;
        if (signal.aborted) throw fatalError ?? canceled();
        if (!sink.bytes) throw new CaptureRecordingError("failed", "No desktop recording frames were written");
        onState("encoding"); controls.update({ state: "encoding", elapsedMs: Math.round(activeMs) });
        const crop = selection.sourceKind === "window" ? { x: 0, y: 0, ...actualSize } : selection.crop;
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
        clearInterval(tick); clearTimeout(acquisitionTimer); clearTimeout(stopTimer);
        engineWindow?.dispose(); controls?.dispose();
        await sink?.close().catch(error => deps.log.warn("[Capture] recording writer cleanup failed", error));
        parentSignal.removeEventListener("abort", abort);
        active.delete(controller);
        if (stopAction === stopThisSession) stopAction = undefined;
        if (!keepResult) deps.scratch.remove(id);
      }
    },
  };
}
