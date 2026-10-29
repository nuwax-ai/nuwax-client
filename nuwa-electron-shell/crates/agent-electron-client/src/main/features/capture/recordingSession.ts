/** One private document and session own a grant; every IPC request validates both identities. */
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { createHash, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RECORDING_IPC, type RecordingCommand, type RecordingConfig, type RecordingEvent } from '@shared/features/capture/recordingContract';
import { recordingScript } from '@renderer/features/capture/recordingPage';
import { installPortalRequest } from './portalRequest';
export interface PrivateRecordingSession {
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

export function dimensions(width: unknown, height: unknown): { width: number; height: number } {
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
        await session.event({ type: "error", message: value.message, permissionDenied: value.permissionDenied === true, canceled: value.canceled === true });
      } else if (["armed", "started", "paused", "resumed", "stopped"].includes(String(value.type))) {
        await session.event({ type: value.type as "armed" | "started" | "paused" | "resumed" | "stopped" });
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

export const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error));
export const canceled = () => new Error("capture was canceled");
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Acquisition can fail while loadFile is still awaiting. Mark handled until the owner awaits it.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

export async function openRecordingWindow(dir: string, config: RecordingConfig, signal: AbortSignal,
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
  const removePortalRequest = config.acquisition === 'portal' ? installPortalRequest(window, url, callbacks.fail) : undefined;
  session.setPermissionCheckHandler((contents, permission, _origin, details) =>
    contents === window.webContents && ["media", "display-capture"].includes(permission) && details.isMainFrame === true && contents.mainFrame.url === url);
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(contents === window.webContents && ["media", "display-capture"].includes(permission) && details.isMainFrame === true && contents.mainFrame.url === url);
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", onAbort);
    sessions.delete(id);
    uninstallUnusedHandlers();
    removePortalRequest?.();
    session.setPermissionCheckHandler(null);
    session.setPermissionRequestHandler(null);
    if (!window.isDestroyed()) window.destroy();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([window.loadFile(html), interrupted.promise]);
    if (signal.aborted) onAbort();
    if (config.acquisition === 'portal') {
      // executeJavaScript's userGesture is bound to the caller's current capture action.
      // The private handler still validates the exact document and permits only one request.
      void window.webContents.executeJavaScript('window.startNuwaxCapture()', true)
        .catch(error => { if (!disposed) callbacks.fail(asError(error)); });
    }
    return { window, config, send, dispose };
  } catch (error) { dispose(); throw error; }
}

export type RecordingSessionWindow = Awaited<ReturnType<typeof openRecordingWindow>>;
