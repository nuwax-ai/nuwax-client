import { BrowserWindow, desktopCapturer, ipcMain, nativeImage, screen, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  CAPTURE_WINDOW_CHANNELS as CH, DEFAULT_CAPTURE_WINDOW_LABELS,
  type CaptureRect, type CaptureSelection, type CaptureSize, type CaptureWindowConfiguration,
  type CaptureWindowImage, type CaptureWindowLabels, type CaptureWindowSource,
  type RecordingAction, type RecordingControls, type RecordingControlState,
} from '@shared/features/capture/windowContract';
import { buildCaptureWindowHtml } from '../../../renderer/features/capture/windowHtml';
import type { StillCapture, StillEngine } from './captureService';
import { isValidCaptureCrop, isTrustedCaptureFrame } from './windowSecurity';
import { recordingBorderBounds, recordingControlBounds } from './windowGeometry';

export interface CaptureWindows extends StillEngine {
  select(mode: 'record', signal: AbortSignal): Promise<CaptureSelection | null>;
  /** Applied to windows opened for the next capture; active windows keep their initial language. */
  setLabels(labels: Partial<CaptureWindowLabels>): void;
  createRecordingControls(selection: CaptureSelection, onAction: (action: RecordingAction, error?: Error) => void): RecordingControls;
  dispose(): void;
}
export interface CaptureWindowOptions {
  preloadPath?: string;
  labels?: Partial<CaptureWindowLabels>;
  log?: { error(...args: unknown[]): void };
  captureWindowFrame?: (sourceId: string, sourceSize: CaptureSize, signal: AbortSignal) => Promise<{ png: Buffer; width: number; height: number; hdrToneMapped: boolean }>;
}
interface ManagedWindow {
  window: BrowserWindow;
  id: number;
  url: string;
  config: CaptureWindowConfiguration;
  sourceIds?: Set<string>;
  signal?: AbortSignal;
  finish?: (result: StillCapture | CaptureSelection | null) => void;
  onAction?: (action: RecordingAction, error?: Error) => void;
  fail?: (error: Error) => void;
  chosen?: CaptureWindowImage;
  loading?: boolean;
  rendererInitialized?: boolean;
}

/** One factory owns its IPC handlers and all windows; dispose is safe during any stage. */
export function createCaptureWindows(options: CaptureWindowOptions = {}): CaptureWindows {
  let labels = { ...DEFAULT_CAPTURE_WINDOW_LABELS, ...options.labels };
  const preloadPath = options.preloadPath ?? path.join(__dirname, '..', 'preload', 'captureWindow.js');
  const windows = new Map<number, ManagedWindow>();
  let disposed = false;
  let pending: ((result: null) => void) | null = null;
  let sourceCatalog: CaptureWindowSource[] = [];
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent): ManagedWindow | undefined => {
    const owned = windows.get(event.sender.id);
    if (!owned || !isTrustedCaptureFrame(event, owned.window.webContents, owned.url)) return undefined;
    return owned;
  };
  const close = (owned: ManagedWindow) => {
    windows.delete(owned.id);
    if (!owned.window.isDestroyed()) owned.window.destroy();
  };
  const failWindow = (owned: ManagedWindow, rawError: unknown) => {
    if (!windows.has(owned.id)) return;
    const error = rawError instanceof Error ? rawError : new Error(String(rawError));
    (options.log ?? console).error('[Capture] native window failed', error);
    if (owned.fail) owned.fail(error);
    else owned.onAction?.('cancel', error);
    owned.finish = undefined; owned.fail = undefined; owned.onAction = undefined;
    close(owned);
  };
  function create(config: CaptureWindowConfiguration, bounds: CaptureRect, controls = false, activate = true): ManagedWindow {
    if (disposed) throw new Error('capture windows have been disposed');
    const window = new BrowserWindow({
      ...bounds, useContentSize: true, show: false, frame: false, transparent: config.kind !== 'selection',
      resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, alwaysOnTop: true, hasShadow: controls, enableLargerThanScreen: true,
      roundedCorners: config.kind !== 'border',
      title: config.kind === 'selection' ? `${config.mode === 'still' ? labels.screenshot : labels.record}` : config.kind === 'controls' ? labels.record : '',
      backgroundColor: config.kind === 'selection' ? '#12161b' : '#00000000',
      webPreferences: { preload: preloadPath, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, devTools: false },
    });
    const nonce = randomBytes(18).toString('hex');
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(buildCaptureWindowHtml(nonce))}`;
    const owned: ManagedWindow = { window, id: window.webContents.id, url, config };
    windows.set(window.webContents.id, owned);
    window.setAlwaysOnTop(true, 'screen-saver');
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('will-frame-navigate', (event) => event.preventDefault());
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    window.webContents.on('page-title-updated', (event) => event.preventDefault());
    window.webContents.on('before-input-event', (event, input) => {
      // 初始化前提供退出兜底；初始化后由页面区分取消文字编辑和取消截图。
      if (config.kind === 'selection' && !owned.rendererInitialized && input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault(); owned.finish?.(null);
      }
    });
    window.webContents.on('render-process-gone', (_event, details) => { failWindow(owned, new Error(`Capture window renderer exited: ${details.reason}`)); });
    window.on('closed', () => { windows.delete(owned.id); owned.finish?.(null); owned.onAction?.('cancel'); });
    if (config.kind === 'border') { window.setIgnoreMouseEvents(true); window.setFocusable(false); }
    window.webContents.once('did-finish-load', () => {
      if (window.isDestroyed()) return;
      if (activate && config.kind !== 'border') { window.show(); window.focus(); }
      else window.showInactive();
    });
    // Defer navigation until the caller has installed this session's result/failure callbacks.
    queueMicrotask(() => {
      if (!windows.has(owned.id)) return;
      try { void window.loadURL(url).catch(error => failWindow(owned, error)); }
      catch (error) { failWindow(owned, error); }
    });
    return owned;
  }

  ipcMain.handle(CH.init, (event) => {
    const owned = trusted(event);
    if (!owned) return null;
    owned.rendererInitialized = true;
    return owned.config;
  });
  ipcMain.handle(CH.source, async (event, rawId: unknown) => {
    const owned = trusted(event);
    if (!owned || owned.config.kind !== 'selection' || owned.loading || typeof rawId !== 'string' || !owned.sourceIds?.has(rawId)) return null;
    if (rawId === owned.config.image.selection.sourceId) { owned.chosen = undefined; return owned.config.image; }
    if (!options.captureWindowFrame) return null;
    const source = sourceCatalog.find((entry) => entry.id === rawId);
    if (!source) return null;
    const thumbnail = nativeImage.createFromDataURL(source.thumbnail);
    owned.loading = true;
    try {
      const captured = await options.captureWindowFrame(rawId, thumbnail.getSize(), owned.signal!);
      if (owned.signal?.aborted || !windows.has(event.sender.id) || !trusted(event)) return null;
      if (captured.width < 1 || captured.height < 1 || captured.width > 32768 || captured.height > 32768) throw new Error('invalid captured window dimensions');
      const sourceSize = { width: captured.width, height: captured.height };
      const chosen: CaptureWindowImage = {
        dataUrl: `data:image/png;base64,${captured.png.toString('base64')}`,
        ...sourceSize,
        selection: { ...owned.config.image.selection, sourceId: rawId, sourceKind: 'window', sourceSize, crop: { x: 0, y: 0, ...sourceSize }, hdrToneMapped: captured.hdrToneMapped },
      };
      owned.chosen = chosen;
      return chosen;
    } finally { owned.loading = false; }
  });
  ipcMain.handle(CH.finish, (event, payload: unknown) => {
    const owned = trusted(event);
    if (!owned || owned.config.kind !== 'selection' || owned.signal?.aborted || !payload || typeof payload !== 'object') return false;
    const raw = payload as { crop?: unknown; png?: unknown };
    const image = owned.chosen ?? owned.config.image;
    if (!isValidCaptureCrop(raw.crop, image.selection.sourceSize)) return false;
    const selection = { ...image.selection, crop: raw.crop as CaptureRect };
    if (owned.config.mode === 'record') { owned.finish?.(selection); return true; }
    if (typeof raw.png !== 'string' || !raw.png.startsWith('data:image/png;base64,') || raw.png.length > 400 * 1024 * 1024) return false;
    const result = nativeImage.createFromDataURL(raw.png);
    if (result.isEmpty()) return false;
    const size = result.getSize();
    if (size.width !== selection.crop.width || size.height !== selection.crop.height) return false;
    owned.finish?.({ image: result, hdrToneMapped: selection.hdrToneMapped });
    return true;
  });
  const actionHandler = (event: IpcMainEvent, action: unknown) => {
    const owned = trusted(event);
    if (!owned || !['pause', 'resume', 'stop', 'cancel'].includes(String(action))) return;
    if (owned.config.kind === 'selection') { if (action === 'cancel') owned.finish?.(null); }
    else owned.onAction?.(action as RecordingAction);
  };
  ipcMain.on(CH.action, actionHandler);

  async function select(mode: 'still' | 'record', signal: AbortSignal): Promise<StillCapture | CaptureSelection | null> {
    if (signal.aborted || disposed) return null;
    if (pending) throw new Error('a capture selector is already open');
    const displays = screen.getAllDisplays();
    const preferredDisplayId = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id;
    // Freeze every display before any overlay exists, so the overlays cannot enter the screenshot.
    const frozen = await Promise.all(displays.map(async (display) => {
      const requested = { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) };
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: requested });
      const source = sources.find((entry) => entry.display_id === String(display.id));
      if (!source || source.thumbnail.isEmpty()) throw new Error('screen capture returned no matching display');
      const size = source.thumbnail.getSize();
      return { display, source, size };
    }));
    const allSources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 480, height: 300 }, fetchWindowIcons: false });
    sourceCatalog = allSources.filter((source) => !source.thumbnail.isEmpty()).map((source) => ({ id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL(), kind: 'window' }));
    if (signal.aborted || disposed) return null;
    return new Promise((resolve, reject) => {
      let settled = false;
      const sessionWindows: ManagedWindow[] = [];
      const finish = (result: StillCapture | CaptureSelection | null, failure?: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        pending = null;
        for (const owned of sessionWindows) { owned.finish = undefined; owned.fail = undefined; close(owned); }
        sourceCatalog = [];
        if (failure !== undefined) reject(failure); else resolve(result);
      };
      const abort = () => finish(null);
      pending = abort;
      signal.addEventListener('abort', abort, { once: true });
      try {
        for (const { display, source, size } of frozen) {
          const selection: CaptureSelection = {
            sourceId: source.id, sourceKind: 'screen', sourceSize: size, crop: { x: 0, y: 0, ...size },
            displayBounds: { ...display.bounds }, displayId: String(display.id), hdrToneMapped: false,
          };
          const owned = create({ kind: 'selection', mode, labels, image: { dataUrl: source.thumbnail.toDataURL(), ...size, selection }, sources: sourceCatalog, workArea: display.workArea }, display.bounds, false, display.id === preferredDisplayId);
          owned.signal = signal; owned.finish = finish; owned.fail = (error) => finish(null, error);
          owned.sourceIds = new Set([source.id, ...sourceCatalog.map((entry) => entry.id)]);
          sessionWindows.push(owned);
        }
        if (!sessionWindows.length || signal.aborted) finish(null);
      } catch (error) { finish(null, error); }
    });
  }

  return {
    setLabels(next) { labels = { ...DEFAULT_CAPTURE_WINDOW_LABELS, ...next }; },
    captureStill: (signal) => select('still', signal) as Promise<StillCapture | null>,
    select: (_mode, signal) => select('record', signal) as Promise<CaptureSelection | null>,
    createRecordingControls(selection, onAction) {
      const display = screen.getAllDisplays().find((entry) => String(entry.id) === selection.displayId) ?? screen.getDisplayMatching(selection.displayBounds);
      const controlBounds = recordingControlBounds(selection, display.workArea);
      const initial: RecordingControlState = { state: 'countdown', elapsedMs: 0, countdown: 3 };
      const control = create({ kind: 'controls', labels, state: initial }, controlBounds, true);
      control.onAction = onAction;
      const related = [control];
      if (selection.sourceKind === 'screen') {
        const border = create({ kind: 'border' }, recordingBorderBounds(selection));
        border.onAction = onAction;
        related.push(border);
      }
      for (const owned of related) owned.window.setContentProtection(true);
      let closed = false;
      return {
        update(state) {
          if (closed || control.window.isDestroyed()) return;
          control.config = { kind: 'controls', labels, state };
          control.window.webContents.send(CH.state, state);
          for (const owned of related) {
            if (owned.config.kind !== 'border' || owned.window.isDestroyed()) continue;
            // Encoding no longer captures pixels; remove the live-area indicator.
            if (state.state === 'encoding') { owned.onAction = undefined; close(owned); }
            else owned.window.webContents.send(CH.state, state);
          }
        },
        setContentProtection(enabled) { for (const owned of related) if (!owned.window.isDestroyed()) owned.window.setContentProtection(enabled); },
        dispose() { if (closed) return; closed = true; for (const owned of related) { owned.onAction = undefined; owned.fail = undefined; close(owned); } },
      };
    },
    dispose() {
      if (disposed) return; disposed = true; pending?.(null);
      for (const owned of [...windows.values()]) { owned.finish = undefined; owned.onAction = undefined; owned.fail = undefined; close(owned); }
      for (const channel of [CH.init, CH.source, CH.finish]) ipcMain.removeHandler(channel);
      ipcMain.removeListener(CH.action, actionHandler);
    },
  };
}
