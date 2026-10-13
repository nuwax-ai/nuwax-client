import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAPTURE_WINDOW_CHANNELS as CH, type CaptureSelection } from '@shared/features/capture/windowContract';
import { createCaptureService } from './captureService';
import { createNativeImageEncoder } from './stillEncoder';

const mock = vi.hoisted(() => {
  const { EventEmitter } = require('node:events');
  const windows: Array<any> = [];
  let nextId = 0;
  let focusedId: number | null = null;
  const timeline: string[] = [];
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const requests: Array<{ width: number; height: number }> = [];
  const windowSources: Array<{ id: string; name: string; thumbnail: unknown }> = [];
  const settings: { loadError: Error | null } = { loadError: null };
  class FakeWindow extends EventEmitter {
    destroyed = false;
    bounds: { x: number; y: number; width: number; height: number };
    webContents = Object.assign(new EventEmitter(), { id: ++nextId, mainFrame: { url: '' }, isDestroyed: () => this.destroyed, setWindowOpenHandler: vi.fn(), send: vi.fn() });
    constructor(readonly options: { title: string; x: number; y: number; width: number; height: number }) {
      super(); windows.push(this);
      // Model Windows' initial work-area clamp (40px taskbar on this display).
      this.bounds = { x: options.x, y: options.y, width: options.width, height: Math.min(options.height, 760) };
    }
    setBounds(bounds: typeof this.bounds) { this.bounds = { ...bounds }; }
    getContentBounds() { return { ...this.bounds }; }
    isDestroyed() { return this.destroyed; }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); }
    loadURL(url: string) { this.webContents.mainFrame.url = url; return settings.loadError ? Promise.reject(settings.loadError) : Promise.resolve(); }
    setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {} setIgnoreMouseEvents() {} setFocusable() {} show() { focusedId = this.webContents.id; timeline.push('show'); } focus() { focusedId = this.webContents.id; } showInactive() { timeline.push('inactive'); } setContentProtection() {}
  }
  const display = { id: 1, size: { width: 1200, height: 800 }, scaleFactor: 2, bounds: { x: 0, y: 0, width: 1200, height: 800 }, workArea: { x: 0, y: 0, width: 1200, height: 760 } };
  const thumbnail = { isEmpty: () => false, getSize: () => ({ width: 2400, height: 1600 }), toDataURL: () => 'data:image/png;base64,fixture' };
  const displays = [display];
  const cursor = { x: 20, y: 20 };
  return { windows, settings, FakeWindow, display, displays, cursor, thumbnail, timeline, handlers, requests, windowSources, focused: () => focusedId, log: { error: vi.fn() } };
});
vi.mock('electron', () => ({
  BrowserWindow: mock.FakeWindow,
  desktopCapturer: { getSources: async (options: { types: string[]; thumbnailSize: { width: number; height: number } }) => {
    mock.timeline.push(options.types.includes('screen') ? 'freeze' : 'catalog');
    if (!options.types.includes('screen')) return mock.windowSources;
    mock.requests.push(options.thumbnailSize);
    return mock.displays.map((display) => ({ id: `screen:${display.id}`, display_id: String(display.id), thumbnail: { ...mock.thumbnail, getSize: () => ({ width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) }) } }));
  } },
  screen: { getAllDisplays: () => mock.displays, getDisplayMatching: () => mock.display, getCursorScreenPoint: () => mock.cursor, getDisplayNearestPoint: () => mock.displays.find(display => mock.cursor.x >= display.bounds.x && mock.cursor.x < display.bounds.x + display.bounds.width) ?? mock.display },
  ipcMain: { handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => mock.handlers.set(channel, listener), removeHandler: (channel: string) => mock.handlers.delete(channel), on: vi.fn(), removeListener: vi.fn() },
  nativeImage: { createFromDataURL: () => mock.thumbnail },
}));
import { createCaptureWindows, type CaptureWindows } from './selectionWindows';
let windows: CaptureWindows;
const service = () => createCaptureService({
  platform: 'darwin', getPermission: () => 'granted', getDisplays: () => [], stillEngine: windows, stillEncoder: createNativeImageEncoder(),
  results: { put: vi.fn(), putFile: vi.fn(), readChunk: () => null, release: vi.fn(), releaseAll: vi.fn(), copyTo: () => false }, log: { warn: vi.fn(), error: vi.fn() },
});
beforeEach(() => { mock.windows.length = 0; mock.displays.splice(0, mock.displays.length, mock.display); mock.cursor.x = 20; mock.cursor.y = 20; mock.timeline.length = 0; mock.handlers.clear(); mock.requests.length = 0; mock.windowSources.length = 0; mock.settings.loadError = null; vi.clearAllMocks(); windows = createCaptureWindows({ log: mock.log }); });
afterEach(() => windows.dispose());

describe('native capture failure classification', () => {
  it.each(['load', 'renderer'])('%s failure returns failed rather than a user cancellation', async (reason) => {
    if (reason === 'load') mock.settings.loadError = new Error('capture document could not load');
    const pending = service().screenshot({ format: 'png' });
    const outcome = expect(pending).resolves.toMatchObject({ success: false, code: 'failed' });
    if (reason === 'renderer') {
      await vi.waitFor(() => expect(mock.windows).toHaveLength(1));
      mock.windows[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    }
    await outcome;
    expect(mock.log.error).toHaveBeenCalled();
    expect(mock.windows.every((window) => window.destroyed)).toBe(true);
  });
  it('an ordinary user window close remains a normal cancellation', async () => {
    const pending = service().screenshot({ format: 'png' });
    await vi.waitFor(() => expect(mock.windows).toHaveLength(1));
    mock.windows[0].destroy();
    expect(await pending).toEqual({ success: false, code: 'canceled' });
    expect(mock.log.error).not.toHaveBeenCalled();
  });
  it('control renderer failures notify the recorder with an Error and avoid a duplicate ordinary cancel', () => {
    const onAction = vi.fn();
    const selection: CaptureSelection = { sourceId: 'screen:1', sourceKind: 'screen', sourceSize: { width: 2400, height: 1600 }, crop: { x: 300, y: 300, width: 800, height: 600 }, displayBounds: mock.display.bounds, displayId: '1', hdrToneMapped: false };
    const controls = windows.createRecordingControls(selection, onAction);
    mock.windows[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith('cancel', expect.any(Error));
    expect(mock.log.error).toHaveBeenCalled();
    controls.dispose();
  });
});

describe('multi-display selector focus', () => {
  it('restores full display pixels before initialization despite the native work-area clamp', async () => {
    const abort = new AbortController();
    const pending = windows.captureStill(abort.signal);
    await vi.waitFor(() => expect(mock.windows).toHaveLength(1));
    expect(mock.windows[0].getContentBounds()).toEqual(mock.display.bounds);
    expect(mock.windows[0].getContentBounds().height).toBeGreaterThan(mock.display.workArea.height);
    abort.abort(); expect(await pending).toBeNull();
  });
  it.each(['preferred-first', 'preferred-last'])('keeps the cursor display focused when loading %s', async (order) => {
    mock.displays.push({ ...mock.display, id: 2, bounds: { ...mock.display.bounds, x: 1200 } });
    const abort = new AbortController();
    const pending = windows.captureStill(abort.signal);
    await vi.waitFor(() => expect(mock.windows).toHaveLength(2));
    const [preferred, other] = mock.windows;
    const ordered = order === 'preferred-first' ? [preferred, other] : [other, preferred];
    for (const window of ordered) window.webContents.emit('did-finish-load');
    expect(mock.focused()).toBe(preferred.webContents.id);
    expect(mock.timeline.slice(0, 3)).toEqual(['freeze', 'freeze', 'catalog']);
    expect(preferred.options.title).toBe('截图');
    const key = { preventDefault: vi.fn() };
    preferred.webContents.emit('before-input-event', key, { type: 'keyDown', key: 'Escape' });
    expect(key.preventDefault).toHaveBeenCalled(); expect(await pending).toBeNull();
  });
  it('focuses a secondary display under the cursor and uses its localized selector title', async () => {
    mock.displays.push({ ...mock.display, id: 2, bounds: { ...mock.display.bounds, x: 1200 } });
    mock.cursor.x = 1300; windows.setLabels({ screenshot: 'Screenshot' });
    const abort = new AbortController(); const pending = windows.captureStill(abort.signal);
    await vi.waitFor(() => expect(mock.windows).toHaveLength(2));
    mock.windows[1].webContents.emit('did-finish-load'); mock.windows[0].webContents.emit('did-finish-load');
    expect(mock.focused()).toBe(mock.windows[1].webContents.id);
    expect(mock.windows[1].options.title).toBe('Screenshot');
    abort.abort(); expect(await pending).toBeNull();
  });
});


describe('capture sources on arbitrary displays', () => {
  it('keeps countdown, recording and paused controls beside the chosen secondary-screen region', async () => {
    const second = { ...mock.display, id: 2, bounds: { x: -1280, y: -256, width: 1280, height: 1024 }, workArea: { x: -1280, y: -232, width: 1280, height: 960 } };
    mock.displays.push(second);
    // getDisplayMatching mock deliberately returns the primary display: the
    // persisted selected display id must be authoritative, not cursor/focus.
    const selected: CaptureSelection = { sourceId: 'screen:2', sourceKind: 'screen', displayId: '2', displayBounds: second.bounds,
      sourceSize: { width: 1600, height: 1280 }, crop: { x: 250, y: 125, width: 625, height: 375 }, hdrToneMapped: false };
    const onAction = vi.fn();
    const controls = windows.createRecordingControls(selected, onAction);
    const [control, border] = mock.windows;
    expect(border.options).toMatchObject({ roundedCorners: false, hasShadow: false, frame: false });
    const placement = { x: -1020, y: 156, width: 440, height: 60 };
    expect(control.options).toMatchObject(placement);
    for (const state of ['countdown', 'recording', 'paused'] as const) {
      controls.update({ state, elapsedMs: 1000 });
      expect(control.options).toMatchObject(placement);
      expect(border.webContents.send).toHaveBeenLastCalledWith(CH.state, { state, elapsedMs: 1000 });
    }
    controls.update({ state: 'encoding', elapsedMs: 1000 });
    expect(border.destroyed).toBe(true); expect(control.destroyed).toBe(false);
    expect(onAction).not.toHaveBeenCalled();
    controls.dispose(); expect(mock.windows.every(window => window.destroyed)).toBe(true);
    await Promise.resolve(); expect(onAction).not.toHaveBeenCalled();
  });
  const layouts = [
    { x: -1280, y: -256, width: 1280, height: 1024, scale: 1.25 },
    { x: 200, y: -1200, width: 900, height: 1200, scale: 1.5 },
    { x: 1200, y: 100, width: 1536, height: 864, scale: 1.25 },
  ];
  it.each(layouts)('selects the secondary source at ($x,$y) with scale $scale', async (layout) => {
    const second = { ...mock.display, id: 2, size: { width: layout.width, height: layout.height }, bounds: { x: layout.x, y: layout.y, width: layout.width, height: layout.height }, scaleFactor: layout.scale };
    mock.displays.push(second);
    const pending = windows.select('record', new AbortController().signal);
    await vi.waitFor(() => expect(mock.windows).toHaveLength(2));
    const owned = mock.windows[1]; const event = { sender: owned.webContents, senderFrame: owned.webContents.mainFrame };
    const config = mock.handlers.get(CH.init)!(event) as { image: { selection: CaptureSelection } };
    const frame = { width: Math.round(layout.width * layout.scale), height: Math.round(layout.height * layout.scale) };
    expect(mock.requests).toContainEqual(frame);
    expect(config.image.selection.sourceId).toBe('screen:2');
    expect(config.image.selection.sourceSize).toEqual(frame);
    const crop = { x: 125, y: 75, width: 625, height: 375 };
    expect(mock.handlers.get(CH.finish)!(event, { crop })).toBe(true);
    expect(await pending).toMatchObject({ sourceId: 'screen:2', displayId: '2', displayBounds: second.bounds, sourceSize: frame, crop });
    expect(mock.windows.every((window) => window.destroyed)).toBe(true);
  });
  it('selects a window from any display without substituting thumbnail dimensions', async () => {
    mock.displays.push({ ...mock.display, id: 2, bounds: { ...mock.display.bounds, x: -1200 } });
    mock.windowSources.push({ id: 'window:fixture', name: 'Synthetic app', thumbnail: mock.thumbnail });
    windows.dispose();
    const capture = vi.fn(async () => ({ png: Buffer.from('fixture-window-png'), width: 1664, height: 936, hdrToneMapped: false }));
    windows = createCaptureWindows({ log: mock.log, captureWindowFrame: capture });
    const pending = windows.select('record', new AbortController().signal);
    await vi.waitFor(() => expect(mock.windows).toHaveLength(2));
    const owned = mock.windows[1]; const event = { sender: owned.webContents, senderFrame: owned.webContents.mainFrame };
    expect(await mock.handlers.get(CH.source)!(event, 'screen:1')).toBeNull();
    const image = await mock.handlers.get(CH.source)!(event, 'window:fixture') as { selection: CaptureSelection };
    expect(image.selection.sourceSize).toEqual({ width: 1664, height: 936 });
    expect(mock.handlers.get(CH.finish)!(event, { crop: { x: 0, y: 0, width: 1664, height: 936 } })).toBe(true);
    expect(await pending).toMatchObject({ sourceKind: 'window', sourceId: 'window:fixture', sourceSize: { width: 1664, height: 936 } });
  });
  it('Escape on any non-primary selector cancels every display in the same round', async () => {
    mock.displays.push({ ...mock.display, id: 2, bounds: { ...mock.display.bounds, x: -1200 } });
    const pending = windows.select('record', new AbortController().signal);
    await vi.waitFor(() => expect(mock.windows).toHaveLength(2));
    mock.windows[1].webContents.emit('before-input-event', { preventDefault: vi.fn() }, { type: 'keyDown', key: 'Escape' });
    expect(await pending).toBeNull(); expect(mock.windows.every((window) => window.destroyed)).toBe(true);
  });
});
