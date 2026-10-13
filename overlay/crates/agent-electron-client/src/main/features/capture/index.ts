/** Native capture owns its windows, file results and both narrowly trusted entry points. */
import { app, BrowserWindow, dialog, powerMonitor, screen } from "electron";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import path from "node:path";
import {
  CAPTURE_IPC, HOST_CAPTURE_IPC, HOST_CAPTURE_SAVE_IPC,
  type CaptureChannels, type CaptureCapabilities, type CaptureResult, type CaptureSuccess,
} from "@shared/features/capture/contract";
import { DEFAULT_CAPTURE_WINDOW_LABELS, type CaptureWindowLabels } from "@shared/features/capture/windowContract";
import { unavailableCapabilities } from "@shared/features/capture/unavailable";
import type { DesktopFeature, FeatureContext, FeatureHandle } from "../_kit/types";
import type { TrustedIpc } from "../_kit/trustedIpc";
import { createCaptureService, type CaptureService } from "./captureService";
import { getAllDisplays, getScreenPermission } from "./electronDeps";
import { createResultStore, type ResultStore } from "./results";
import { createNativeImageEncoder } from "./stillEncoder";
import { createCaptureWindows } from "./selectionWindows";
import { createCaptureSourceStill, createCapturePortalFrame, createRecordEngine } from "./recorder";
import { resolveCaptureFfmpeg } from "./encodingResources";
import { captureBackendAvailable } from './linuxEnvironment';
import { resolveCapturePlatform } from './platforms';
export { configureCaptureBackend } from './linuxEnvironment';

const SCRATCH_TTL_MS = 24 * 60 * 60 * 1000;
const UNTRUSTED: CaptureResult = { success: false, code: "untrusted" };
const EXTENSIONS: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
  "video/mp4": "mp4", "video/webm": "webm", "image/gif": "gif",
};

export const captureFeature: DesktopFeature = {
  id: "capture", products: ["nuwax"], enabledByDefault: true,
  register(ctx: FeatureContext): FeatureHandle {
    let service: CaptureService | null = null;
    let pendingService: Promise<CaptureService> | null = null;
    let results: ResultStore | null = null;
    let windows: ReturnType<typeof createCaptureWindows> | null = null;
    let recorder: ReturnType<typeof createRecordEngine> | null = null;
    let active: { sender: WebContents; channel: string } | null = null;
    let offState: (() => void) | null = null;
    let generation = 0;
    let disposed = false;
    const owners = new Map<string, { senderId: number; result: CaptureSuccess }>();
    const watched = new Map<number, { sender: WebContents; cleanup: () => void }>();
    const documentEpochs = new Map<number, number>();
    const currentLabels = (): CaptureWindowLabels => {
      const labels = { ...DEFAULT_CAPTURE_WINDOW_LABELS };
      for (const key of Object.keys(labels) as Array<keyof CaptureWindowLabels>) {
        const translated = ctx.translate?.(`Claw.Capture.${key}`);
        if (translated && translated !== `Claw.Capture.${key}`) labels[key] = translated;
      }
      return labels;
    };

    const clearSession = () => {
      generation++;
      service?.endSession();
      owners.clear();
      ctx.setRecordingStopAction?.(null);
      ctx.setRecordingPauseAction?.(null, false);
      for (const entry of watched.values()) entry.cleanup();
      watched.clear();
      documentEpochs.clear();
    };

    const watchSender = (sender: WebContents) => {
      if (watched.has(sender.id)) return;
      const end = () => {
        documentEpochs.set(sender.id, (documentEpochs.get(sender.id) ?? 0) + 1);
        if (active?.sender === sender) service?.cancel();
        for (const [id, owner] of owners) if (owner.senderId === sender.id) {
          service?.release(id); owners.delete(id);
        }
        watched.get(sender.id)?.cleanup();
        watched.delete(sender.id);
      };
      const navigation = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
        if (mainFrame && !inPlace) end();
      };
      sender.once("destroyed", end);
      sender.on("did-start-navigation", navigation);
      watched.set(sender.id, { sender, cleanup: () => {
        sender.removeListener("destroyed", end);
        sender.removeListener("did-start-navigation", navigation);
      } });
    };

    const getService = (): Promise<CaptureService> => {
      if (disposed) return Promise.reject(new Error("capture feature is disposed"));
      if (pendingService) return pendingService;
      pendingService = (async () => {
        ctx.scratch.sweep(SCRATCH_TTL_MS);
        const ffmpeg = await resolveCaptureFfmpeg();
        if (disposed) throw new Error("capture feature is disposed");
        const labels = currentLabels();
        const recordingPreload = path.join(__dirname, "..", "preload", "captureRecording.js");
        const adapter = resolveCapturePlatform();
        windows = createCaptureWindows({ windowPolicy: adapter.windows, sourceStrategy: adapter.source,
          preloadPath: path.join(__dirname, "..", "preload", "captureWindow.js"), labels,
          log: ctx.log,
          captureWindowFrame: createCaptureSourceStill({ scratch: ctx.scratch, preloadPath: recordingPreload }),
          capturePortalFrame: createCapturePortalFrame({ scratch: ctx.scratch, preloadPath: recordingPreload }),
        });
        recorder = createRecordEngine({ adapter, windows, scratch: ctx.scratch, log: ctx.log, ffmpeg, preloadPath: recordingPreload });
        results = createResultStore(ctx.scratch);
        service = createCaptureService({ platform: process.platform, getPermission: getScreenPermission,
          backendAvailable: () => captureBackendAvailable(app.commandLine),
          getDisplays: getAllDisplays, stillEngine: windows, stillEncoder: createNativeImageEncoder(),
          recordEngine: recorder, results, log: ctx.log });
        offState = service.onStateChange((state) => {
          const sender = active?.sender;
          if (sender && !sender.isDestroyed()) sender.send(active!.channel, state);
          ctx.setRecordingStopAction?.(state === "recording" || state === "paused" ? () => recorder?.stop() : null);
          ctx.setRecordingPauseAction?.(state === "recording" || state === "paused" ? () => recorder?.pauseOrResume() : null, state === 'paused');
          if (state === "idle") active = null;
        });
        return service;
      })().catch(error => { pendingService = null; throw error; });
      return pendingService;
    };

    const invokeCapture = async (event: IpcMainInvokeEvent, channels: CaptureChannels,
      kind: "screenshot" | "record", options: unknown): Promise<CaptureResult> => {
      const epoch = generation;
      watchSender(event.sender);
      const documentEpoch = documentEpochs.get(event.sender.id) ?? 0;
      const svc = await getService();
      if (disposed || generation !== epoch || event.sender.isDestroyed() ||
        (documentEpochs.get(event.sender.id) ?? 0) !== documentEpoch) return { success: false, code: "canceled" };
      windows?.setLabels(currentLabels());
      if (svc.getState() === "idle") active = { sender: event.sender, channel: channels.STATE_CHANGED };
      const result = await svc[kind](options);
      if (result.success) {
        if (disposed || generation !== epoch || event.sender.isDestroyed() ||
          (documentEpochs.get(event.sender.id) ?? 0) !== documentEpoch) {
          svc.release(result.resultId); return { success: false, code: "canceled" };
        }
        owners.set(result.resultId, { senderId: event.sender.id, result });
      }
      if (svc.getState() === "idle") active = null;
      return result;
    };

    const registerBridge = (ipc: TrustedIpc, channels: CaptureChannels) => {
      ipc.handle<IpcMainInvokeEvent, [], Promise<CaptureCapabilities> | CaptureCapabilities>(channels.GET_CAPABILITIES,
        async () => (await getService()).getCapabilities(), unavailableCapabilities(process.platform));
      ipc.handle<IpcMainInvokeEvent, [unknown], Promise<CaptureResult> | CaptureResult>(channels.SCREENSHOT,
        (event, options) => invokeCapture(event, channels, "screenshot", options), UNTRUSTED);
      ipc.handle<IpcMainInvokeEvent, [unknown], Promise<CaptureResult> | CaptureResult>(channels.RECORD,
        (event, options) => invokeCapture(event, channels, "record", options), UNTRUSTED);
      ipc.handle<IpcMainInvokeEvent, [], void>(channels.CANCEL, event => {
        if (active?.sender === event.sender) service?.cancel();
      }, undefined);
      ipc.handle<IpcMainInvokeEvent, [unknown, unknown, unknown], Uint8Array | null>(channels.READ_CHUNK,
        (event, id, offset, length) => {
          if (typeof id !== "string" || owners.get(id)?.senderId !== event.sender.id ||
            typeof offset !== "number" || typeof length !== "number") return null;
          try { const chunk = service?.readChunk(id, offset, length); return chunk ? new Uint8Array(chunk) : null; }
          catch { return null; }
        }, null);
      ipc.handle<IpcMainInvokeEvent, [unknown], void>(channels.RELEASE, (event, id) => {
        if (typeof id === "string" && owners.get(id)?.senderId === event.sender.id) {
          service?.release(id); owners.delete(id);
        }
      }, undefined);
    };
    registerBridge(ctx.ipc, CAPTURE_IPC);
    registerBridge(ctx.hostIpc, HOST_CAPTURE_IPC);
    ctx.hostIpc.handle<IpcMainInvokeEvent, [unknown], Promise<{ success: boolean; canceled?: boolean; error?: string }> | { success: boolean; error: string }>(
      HOST_CAPTURE_SAVE_IPC, async (event, id) => {
        if (typeof id !== "string") return { success: false, error: "invalid result" };
        const owner = owners.get(id);
        if (!owner || owner.senderId !== event.sender.id) return { success: false, error: "capture result expired" };
        const epoch = generation;
        const extension = EXTENSIONS[owner.result.mime];
        if (!extension) return { success: false, error: "unsupported capture file type" };
        try {
          const options = { defaultPath: `Nuwax-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`,
            filters: [{ name: extension.toUpperCase(), extensions: [extension] }] };
          const parent = BrowserWindow.fromWebContents(event.sender);
          const saved = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
          if (saved.canceled || !saved.filePath) return { success: false, canceled: true };
          if (generation !== epoch || owners.get(id) !== owner || event.sender.isDestroyed()) {
            return { success: false, error: "capture result expired" };
          }
          if (!results?.copyTo(id, saved.filePath)) return { success: false, error: "capture result expired" };
          return { success: true };
        } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
      }, { success: false, error: "untrusted sender" });

    const offSessionEnd = ctx.lifecycle.onSessionEnd(clearSession);
    const offQuit = ctx.lifecycle.onQuit(clearSession);
    const interrupt = () => clearSession();
    powerMonitor.on("lock-screen", interrupt);
    powerMonitor.on("suspend", interrupt);
    screen.on("display-removed", interrupt);
    return { async dispose() {
      disposed = true; clearSession();
      offSessionEnd(); offQuit(); offState?.();
      powerMonitor.removeListener("lock-screen", interrupt); powerMonitor.removeListener("suspend", interrupt);
      screen.removeListener("display-removed", interrupt);
      ctx.ipc.dispose(); ctx.hostIpc.dispose(); recorder?.dispose(); windows?.dispose();
      if (pendingService) await pendingService.catch(() => undefined);
    } };
  },
};
