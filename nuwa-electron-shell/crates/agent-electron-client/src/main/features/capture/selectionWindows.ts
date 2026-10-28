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
import type { CaptureMenuAction } from '@shared/features/capture/contract';
import { CaptureModeSwitch } from './modeSwitch';
import { isValidCaptureCrop, isTrustedCaptureFrame } from './windowSecurity';
import { recordingBorderBounds, recordingControlBounds } from './windowGeometry';
import { usesCapturePortal } from './linuxEnvironment';
import { resolveCaptureWindowPolicy, type CaptureSelectorWindowPolicy, type CaptureWindowPolicy } from './platforms/windowing';
import { desktopSource, portalSource, type CaptureSourceStrategy } from './platforms/sources';
import { createNativeWindowLister, physicalDisplayBounds, projectWindowsToDisplay, type NativeWindowInfo, type NativeWindowLister } from './windowRegions';

export interface CaptureWindows extends StillEngine {
  select(mode: 'record', signal: AbortSignal): Promise<CaptureSelection | null>;
  selectPrepared(mode: 'still', image: CaptureWindowImage, signal: AbortSignal): Promise<StillCapture | null>;
  selectPrepared(mode: 'record', image: CaptureWindowImage, signal: AbortSignal): Promise<CaptureSelection | null>;
  /** Applied to windows opened for the next capture; active windows keep their initial language. */
  setLabels(labels: Partial<CaptureWindowLabels>): void;
  setActions(action: CaptureMenuAction, actions: CaptureMenuAction[]): void;
  createRecordingControls(selection: CaptureSelection, onAction: (action: RecordingAction, error?: Error) => void): RecordingControls;
  dispose(): void;
}
export interface CaptureWindowOptions {
  preloadPath?: string;
  labels?: Partial<CaptureWindowLabels>;
  log?: { error(...args: unknown[]): void };
  platform?: NodeJS.Platform;
  portal?: boolean;
  windowPolicy?: CaptureWindowPolicy;
  sourceStrategy?: CaptureSourceStrategy;
  capturePortalFrame?: (signal: AbortSignal) => Promise<CaptureWindowImage>;
  captureWindowFrame?: (sourceId: string, sourceSize: CaptureSize, signal: AbortSignal) => Promise<{ png: Buffer; width: number; height: number; hdrToneMapped: boolean }>;
  /** Desktop windows for hover detection; defaults to the native list on the host OS, never for portal sources. */
  listWindows?: NativeWindowLister;
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
  hiddenForRecording?: boolean;
  selectorPolicy?: CaptureSelectorWindowPolicy;
  shown?: boolean;
}

/** One factory owns its IPC handlers and all windows; dispose is safe during any stage. */
export function createCaptureWindows(options: CaptureWindowOptions = {}): CaptureWindows {
  const platform = options.platform ?? process.platform;
  const portal = options.portal ?? usesCapturePortal(platform);
  const windowPolicy = options.windowPolicy ?? resolveCaptureWindowPolicy(platform, portal);
  const sourceStrategy = options.sourceStrategy ?? (portal ? portalSource : desktopSource);
  const listWindows: NativeWindowLister = options.listWindows
    ?? (!portal && platform === process.platform ? createNativeWindowLister({ platform, log: options.log ?? console }) : () => null);
  let labels = { ...DEFAULT_CAPTURE_WINDOW_LABELS, ...options.labels };
  const preloadPath = options.preloadPath ?? path.join(__dirname, '..', 'preload', 'captureWindow.js');
  const windows = new Map<number, ManagedWindow>();
  let disposed = false;
  let pending: ((result: null) => void) | null = null;
  let sourceCatalog: CaptureWindowSource[] = [];
  let action: CaptureMenuAction = 'screenshot';
  let actions: CaptureMenuAction[] = [];
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
    const preview = 'presentation' in config && config.presentation === 'preview';
    const selectorPolicy = windowPolicy.selectionWindow(config, bounds);
    const window = new BrowserWindow({
      ...(preview ? { width: bounds.width, height: bounds.height } : bounds), useContentSize: true, show: false,
      frame: preview, transparent: !preview && config.kind !== 'selection',
      resizable: preview && !controls, minimizable: preview, maximizable: preview && !controls, fullscreenable: false,
      ...selectorPolicy?.options,
      ...(platform === 'darwin' && !preview ? { type: 'panel' } : {}),
      skipTaskbar: !preview || controls, alwaysOnTop: !preview, hasShadow: preview && !controls, enableLargerThanScreen: !preview,
      roundedCorners: config.kind !== 'border',
      title: config.kind === 'selection' ? `${config.mode === 'still' ? labels.screenshot : labels.record}` : config.kind === 'controls' ? labels.record : '',
      backgroundColor: config.kind === 'selection' ? '#12161b' : '#00000000',
      webPreferences: { preload: preloadPath, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, devTools: false },
    });
    // Windows clamps initial window bounds to the work area, excluding the
    // taskbar. Restore the requested bounds before the renderer maps pixels,
    // otherwise a full-screen source is stretched into a shorter viewport.
    if (!preview) window.setBounds(bounds, false);
    const nonce = randomBytes(18).toString('hex');
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(buildCaptureWindowHtml(nonce))}`;
    const owned: ManagedWindow = { window, id: window.webContents.id, url, config, selectorPolicy };
    windows.set(window.webContents.id, owned);
    if (!preview) {
      window.setAlwaysOnTop(true, 'screen-saver');
      // macOS panels can cover fullscreen apps without demoting the whole app
      // to an accessory process (Electron otherwise calls DockHide here).
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, ...(platform === 'darwin' ? { skipTransformProcessType: true } : {}) });
    }
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
      if (owned.hiddenForRecording) return;
      if (activate && config.kind !== 'border') { window.show(); window.focus(); }
      else window.showInactive();
      owned.shown = true;
      selectorPolicy?.didShow(window);
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
    if (owned.selectorPolicy) return owned.selectorPolicy.waitUntilReady(owned.window, () => windows.has(owned.id), () => owned.shown === true).then(() => {
      if (!trusted(event)) return null;
      owned.rendererInitialized = true;
      return owned.config;
    }).catch(error => { failWindow(owned, error); return null; });
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
    const raw = payload as { crop?: unknown; png?: unknown; action?: unknown };
    const image = owned.chosen ?? owned.config.image;
    if (!isValidCaptureCrop(raw.crop, image.selection.sourceSize)) return false;
    const selection = { ...image.selection, crop: raw.crop as CaptureRect };
    const initialAction = owned.config.action ?? (owned.config.mode === 'record' ? 'mp4' : 'screenshot');
    const chosenAction = raw.action ?? initialAction;
    if (chosenAction !== initialAction && !owned.config.actions?.includes(chosenAction as CaptureMenuAction)) return false;
    if (chosenAction !== 'screenshot') {
      if (chosenAction === initialAction) owned.finish?.(selection);
      else owned.fail?.(new CaptureModeSwitch(chosenAction as CaptureMenuAction, selection));
      return true;
    }
    if (typeof raw.png !== 'string' || !raw.png.startsWith('data:image/png;base64,') || raw.png.length > 400 * 1024 * 1024) return false;
    const result = nativeImage.createFromDataURL(raw.png);
    if (result.isEmpty()) return false;
    const size = result.getSize();
    if (size.width !== selection.crop.width || size.height !== selection.crop.height) return false;
    const still = { image: result, hdrToneMapped: selection.hdrToneMapped };
    if (chosenAction === initialAction) owned.finish?.(still);
    else owned.fail?.(new CaptureModeSwitch('screenshot', still));
    return true;
  });
  const actionHandler = (event: IpcMainEvent, action: unknown) => {
    const owned = trusted(event);
    if (!owned || !['pause', 'resume', 'stop', 'cancel'].includes(String(action))) return;
    if (owned.config.kind === 'selection') { if (action === 'cancel') owned.finish?.(null); }
    else owned.onAction?.(action as RecordingAction);
  };
  ipcMain.on(CH.action, actionHandler);

  function recordingHint(mode: 'still' | 'record'): { recordingHint?: string } {
    const hint = mode === 'record' ? windowPolicy.recordingHint(labels) : undefined;
    return hint ? { recordingHint: hint } : {};
  }

  async function select(mode: 'still' | 'record', signal: AbortSignal): Promise<StillCapture | CaptureSelection | null> {
    if (signal.aborted || disposed) return null;
    if (pending) throw new Error('a capture selector is already open');
    const displays = screen.getAllDisplays();
    const preferredDisplayId = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id;
    // Freeze every display before any overlay exists, so the overlays cannot enter the screenshot.
    const requests = new Map<string, ReturnType<typeof desktopCapturer.getSources>>();
    const sizeFor = (display: Electron.Display) => ({ width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) });
    for (const display of displays) {
      const requested = sizeFor(display); const key = `${requested.width}x${requested.height}`;
      if (!requests.has(key)) requests.set(key, desktopCapturer.getSources({ types: ['screen'], thumbnailSize: requested }));
    }
    // Reuse equal-resolution requests without resampling mixed-DPI or native capture pixels.
    // All snapshots and window thumbnails finish before any selector can enter a captured frame.
    const [sourceGroups, allSources] = await Promise.all([
      Promise.all([...requests].map(async ([key, request]) => [key, await request] as const)),
      desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 480, height: 300 }, fetchWindowIcons: false }),
    ]);
    const sourcesBySize = new Map(sourceGroups);
    const frozen = displays.map((display) => {
      const requested = sizeFor(display);
      const source = sourcesBySize.get(`${requested.width}x${requested.height}`)?.find(entry => entry.display_id === String(display.id));
      if (!source || source.thumbnail.isEmpty()) throw new Error('screen capture returned no matching display');
      return { display, source, size: source.thumbnail.getSize() };
    });
    // Read the stacking order right after the freeze, before any overlay exists to appear in it.
    let desktopWindows: NativeWindowInfo[] | null = null;
    try { desktopWindows = listWindows(); } catch (error) { (options.log ?? console).error('[Capture] window detection failed', error); }
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
          const regions = desktopWindows
            ? { regions: projectWindowsToDisplay(desktopWindows, { bounds: display.bounds, physicalBounds: physicalDisplayBounds(display, platform) }, size) } : {};
          const owned = create({ kind: 'selection', mode, labels, ...(actions.length ? { action, actions: [...actions] } : {}), image: { dataUrl: source.thumbnail.toDataURL(), ...size, selection }, sources: sourceCatalog, workArea: display.workArea,
            ...regions, ...recordingHint(mode) }, display.bounds, false, display.id === preferredDisplayId);
          owned.signal = signal; owned.finish = finish; owned.fail = (error) => finish(null, error);
          owned.sourceIds = new Set([source.id, ...sourceCatalog.map((entry) => entry.id)]);
          sessionWindows.push(owned);
        }
        if (!sessionWindows.length || signal.aborted) finish(null);
      } catch (error) { finish(null, error); }
    });
  }

  function selectPrepared(mode: 'still' | 'record', image: CaptureWindowImage, signal: AbortSignal): Promise<StillCapture | CaptureSelection | null> {
    if (signal.aborted || disposed) return Promise.resolve(null);
    if (pending) throw new Error('a capture selector is already open');
    return new Promise((resolve, reject) => {
      let settled = false;
      let owned: ManagedWindow | undefined;
      const finish = (result: StillCapture | CaptureSelection | null, error?: Error) => {
        if (settled) return;
        settled = true; pending = null; signal.removeEventListener('abort', abort);
        if (owned) { owned.finish = undefined; owned.fail = undefined; close(owned); }
        if (error) reject(error); else resolve(result);
      };
      const abort = () => finish(null);
      pending = abort; signal.addEventListener('abort', abort, { once: true });
      try {
        // The compositor positions this ordinary window. Its local viewport is not a display.
        const viewport = { x: 0, y: 0, width: 1040, height: 740 };
        owned = create({ kind: 'selection', mode, labels, ...(actions.length ? { action, actions: [...actions] } : {}), image, sources: [], workArea: viewport, presentation: 'preview',
          ...recordingHint(mode) }, viewport);
        owned.signal = signal; owned.finish = finish; owned.fail = error => finish(null, error);
        owned.sourceIds = new Set([image.selection.sourceId]);
        if (signal.aborted) finish(null);
      } catch (raw) { finish(null, raw instanceof Error ? raw : new Error(String(raw))); }
    });
  }

  return {
    setActions(next, allowed) { action = next; actions = [...allowed]; },
    setLabels(next) { labels = { ...DEFAULT_CAPTURE_WINDOW_LABELS, ...next }; },
    captureStill: signal => sourceStrategy.acquireStill<StillCapture>({
      signal,
      select: () => select('still', signal) as Promise<StillCapture | null>,
      selectPrepared: image => selectPrepared('still', image, signal) as Promise<StillCapture | null>,
      capturePortalFrame: options.capturePortalFrame,
    }),
    select: (_mode, signal) => select('record', signal) as Promise<CaptureSelection | null>,
    selectPrepared: selectPrepared as CaptureWindows['selectPrepared'],
    createRecordingControls(selection, onAction) {
      const policy = windowPolicy.controls;
      const display = policy.associatedWithDesktop && selection.coordinateSpace !== 'source'
        ? screen.getAllDisplays().find((entry) => String(entry.id) === selection.displayId) ?? screen.getDisplayMatching(selection.displayBounds) : null;
      const controlBounds = display ? recordingControlBounds(selection, display.workArea) : { x: 0, y: 0, width: 440, height: 100 };
      const initial: RecordingControlState = { state: 'countdown', elapsedMs: 0, countdown: 3 };
      const presentation = policy.presentation === 'preview' ? { presentation: 'preview' as const } : {};
      const control = create({ kind: 'controls', labels, state: initial, ...presentation }, controlBounds, true);
      if (display && policy.presentation === 'preview') control.window.setPosition(controlBounds.x, controlBounds.y, false);
      control.onAction = onAction;
      const related = [control];
      if (policy.border && selection.coordinateSpace !== 'source' && selection.sourceKind === 'screen') {
        const border = create({ kind: 'border' }, recordingBorderBounds(selection));
        border.onAction = onAction;
        related.push(border);
      }
      if (policy.contentProtection) for (const owned of related) owned.window.setContentProtection(true);
      let closed = false;
      return {
        update(state) {
          if (closed || control.window.isDestroyed()) return;
          control.config = { kind: 'controls', labels, state, ...presentation };
          control.window.webContents.send(CH.state, state);
          if (policy.hideDuringRecording && state.state === 'encoding') { control.hiddenForRecording = false; control.window.show(); }
          for (const owned of related) {
            if (owned.config.kind !== 'border' || owned.window.isDestroyed()) continue;
            // Encoding no longer captures pixels; remove the live-area indicator.
            if (state.state === 'encoding') { owned.onAction = undefined; close(owned); }
            else owned.window.webContents.send(CH.state, state);
          }
        },
        hideForRecording() { if (policy.hideDuringRecording && !control.window.isDestroyed()) { control.hiddenForRecording = true; control.window.hide(); } },
        setContentProtection(enabled) { if (policy.contentProtection) for (const owned of related) if (!owned.window.isDestroyed()) owned.window.setContentProtection(enabled); },
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
