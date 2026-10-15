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
  const settings: { loadError: Error | null; clampOnShow: boolean } = { loadError: null, clampOnShow: false };
  class FakeWindow extends EventEmitter {
    destroyed = false;
    fullScreen = false;
    bounds: { x: number; y: number; width: number; height: number };
    webContents = Object.assign(new EventEmitter(), { id: ++nextId, mainFrame: { url: '' }, isDestroyed: () => this.destroyed, setWindowOpenHandler: vi.fn(), send: vi.fn() });
    constructor(readonly options: { title: string; x: number; y: number; width: number; height: number }) {
      super(); windows.push(this);
      // Model Windows' initial work-area clamp (40px taskbar on this display).
      this.bounds = { x: options.x, y: options.y, width: options.width, height: Math.min(options.height, 760) };
    }
    setBounds = vi.fn((bounds: typeof this.bounds) => { this.bounds = { ...bounds }; });
    setPosition = vi.fn((x: number, y: number) => { this.bounds = { ...this.bounds, x, y }; timeline.push('position'); });
    getContentBounds() { return { ...this.bounds }; }
    isFullScreen() { return this.fullScreen; }
    setFullScreen = vi.fn((enabled: boolean) => {
      this.fullScreen = enabled;
      setTimeout(() => { if (!this.destroyed) { this.bounds = {x:this.options.x,y:this.options.y,width:this.options.width,height:this.options.height}; this.emit('enter-full-screen'); } },30);
    });
    isDestroyed() { return this.destroyed; }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); }
    loadURL(url: string) { this.webContents.mainFrame.url = url; return settings.loadError ? Promise.reject(settings.loadError) : Promise.resolve(); }
    setAlwaysOnTop = vi.fn(); setVisibleOnAllWorkspaces = vi.fn(); setIgnoreMouseEvents() {} setFocusable() {} show() { if (settings.clampOnShow) this.bounds = {...this.bounds,x:this.options.x + 66,y:this.options.y + 32,height:this.options.height - 32}; focusedId = this.webContents.id; timeline.push('show'); } focus() { focusedId = this.webContents.id; } showInactive() { if (settings.clampOnShow) this.bounds = {...this.bounds,x:this.options.x + 66,y:this.options.y + 32,height:this.options.height - 32}; timeline.push('inactive'); } setContentProtection = vi.fn(); hide = vi.fn();
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
import { resolveCaptureWindowPolicy } from './platforms/windowing';
import { portalSource } from './platforms/sources';
let windows: CaptureWindows;
const service = () => createCaptureService({
  platform: 'darwin', getPermission: () => 'granted', getDisplays: () => [], stillEngine: windows, stillEncoder: createNativeImageEncoder(),
  results: { put: vi.fn(), putFile: vi.fn(), readChunk: () => null, release: vi.fn(), releaseAll: vi.fn(), copyTo: () => false }, log: { warn: vi.fn(), error: vi.fn() },
});
beforeEach(() => { mock.windows.length = 0; mock.displays.splice(0, mock.displays.length, mock.display); mock.cursor.x = 20; mock.cursor.y = 20; mock.timeline.length = 0; mock.handlers.clear(); mock.requests.length = 0; mock.windowSources.length = 0; mock.settings.loadError = null; mock.settings.clampOnShow = false; vi.clearAllMocks(); windows = createCaptureWindows({ platform: 'win32', portal: false, log: mock.log }); });
afterEach(() => windows.dispose());

describe('Linux portal source preview', () => {
  const image = { dataUrl: 'data:image/png;base64,frame', width: 100, height: 80,
    selection: { sourceId: 'screen:portal', sourceKind: 'screen' as const, sourceSize: {width:100,height:80},
      crop: {x:0,y:0,width:100,height:80}, coordinateSpace:'source' as const, hdrToneMapped:false } };
  it('selects a source-pixel region in an ordinary window without desktop enumeration or positioning', async () => {
    windows.dispose(); windows = createCaptureWindows({platform:'linux',portal:true,log:mock.log});
    const pending = windows.selectPrepared('record',image,new AbortController().signal);
    await vi.waitFor(() => expect(mock.windows).toHaveLength(1));
    const window = mock.windows[0]; const event = {sender:window.webContents,senderFrame:window.webContents.mainFrame};
    expect(mock.handlers.get(CH.init)!(event)).toMatchObject({recordingHint:expect.stringContaining('Ctrl+Alt+R')});
    expect(window.options).toMatchObject({frame:true,alwaysOnTop:false,resizable:true});
    expect(window.options).not.toHaveProperty('x'); expect(window.options).not.toHaveProperty('y');
    expect(window.setBounds).not.toHaveBeenCalled(); expect(window.setAlwaysOnTop).not.toHaveBeenCalled();
    expect(window.setVisibleOnAllWorkspaces).not.toHaveBeenCalled(); expect(mock.timeline).not.toContain('freeze');
    const crop = {x:10,y:12,width:50,height:40};
    expect(mock.handlers.get(CH.finish)!(event,{crop})).toBe(true);
    expect(await pending).toEqual({...image.selection,crop}); expect(window.destroyed).toBe(true);
  });
  it('hides Linux controls before capture without content protection or a border window', () => {
    windows.dispose(); windows = createCaptureWindows({platform:'linux',portal:true,log:mock.log});
    const controls = windows.createRecordingControls(image.selection,vi.fn());
    expect(mock.windows).toHaveLength(1); expect(mock.windows[0].options.frame).toBe(true);
    expect(mock.windows[0].setPosition).not.toHaveBeenCalled(); expect(mock.windows[0].setBounds).not.toHaveBeenCalled();
    controls.setContentProtection(true); expect(mock.windows[0].setContentProtection).not.toHaveBeenCalled();
    controls.hideForRecording?.(); expect(mock.windows[0].hide).toHaveBeenCalledOnce();
    mock.windows[0].webContents.emit('did-finish-load'); expect(mock.timeline).not.toContain('show');
    controls.dispose(); expect(mock.windows[0].destroyed).toBe(true);
  });
  it('closes the preview on cancellation and rejects a crop outside the granted source', async () => {
    windows.dispose(); windows = createCaptureWindows({platform:'linux',portal:true,log:mock.log});
    const abort = new AbortController(); const pending = windows.selectPrepared('record',image,abort.signal);
    await vi.waitFor(() => expect(mock.windows).toHaveLength(1));
    const window = mock.windows[0]; const event = {sender:window.webContents,senderFrame:window.webContents.mainFrame};
    expect(mock.handlers.get(CH.finish)!(event,{crop:{x:90,y:0,width:50,height:40}})).toBe(false);
    abort.abort(); expect(await pending).toBeNull(); expect(window.destroyed).toBe(true);
  });
  it('uses the injected source strategy for still acquisition independent of the host platform', async () => {
    windows.dispose();
    const capturePortalFrame = vi.fn(async () => image);
    windows = createCaptureWindows({ platform: 'win32', portal: false, sourceStrategy: portalSource, capturePortalFrame, log: mock.log });
    const abort = new AbortController();
    const pending = windows.captureStill(abort.signal);
    await vi.waitFor(() => expect(mock.windows).toHaveLength(1));
    const window = mock.windows[0];
    expect(capturePortalFrame).toHaveBeenCalledWith(abort.signal);
    expect(mock.timeline).not.toContain('freeze');
    expect(mock.handlers.get(CH.init)!({ sender: window.webContents, senderFrame: window.webContents.mainFrame })).toMatchObject({ kind: 'selection', mode: 'still', presentation: 'preview', image });
    abort.abort();
    expect(await pending).toBeNull();
    expect(window.destroyed).toBe(true);
  });
});

describe('Linux X11 selector native fullscreen', () => {
  it('places framed controls beside the chosen secondary-screen region before showing them', () => {
    windows.dispose(); windows = createCaptureWindows({ platform: 'linux', portal: false, log: mock.log });
    const second = { ...mock.display, id: 2, bounds: { x: -1280, y: -256, width: 1280, height: 1024 }, workArea: { x: -1280, y: -232, width: 1280, height: 960 } };
    mock.displays.push(second);
    // The matching fallback returns the primary display, so the persisted id
    // must anchor controls to the secondary display selected by the user.
    const selection: CaptureSelection = { sourceId: 'screen:2', sourceKind: 'screen', displayId: '2', displayBounds: second.bounds,
      sourceSize: { width: 1600, height: 1280 }, crop: { x: 250, y: 125, width: 625, height: 375 }, hdrToneMapped: false };
    const controls = windows.createRecordingControls(selection, vi.fn());
    expect(mock.windows).toHaveLength(1);
    const control = mock.windows[0];
    expect(control.options).toMatchObject({ frame: true, width: 440, height: 60, hasShadow: false });
    expect(control.options).not.toHaveProperty('x');
    expect(control.setPosition).toHaveBeenCalledOnce();
    expect(control.setPosition).toHaveBeenCalledWith(-1020, 156, false);
    expect(mock.timeline).toEqual(['position']);
    control.webContents.emit('did-finish-load');
    expect(mock.timeline).toEqual(['position', 'show']);
    for (const state of ['countdown', 'recording', 'paused', 'encoding'] as const) {
      controls.update({ state, elapsedMs: 1000 });
      expect(control.getContentBounds()).toMatchObject({ x: -1020, y: 156 });
    }
    expect(control.setPosition).toHaveBeenCalledOnce();
    expect(control.setContentProtection).not.toHaveBeenCalled();
    controls.hideForRecording?.(); expect(control.hide).toHaveBeenCalledOnce();
    controls.dispose(); expect(control.destroyed).toBe(true);
  });
  it.each(['screen', 'window'] as const)('does not position an X11 %s source preview without desktop coordinates', (sourceKind) => {
    windows.dispose(); windows = createCaptureWindows({ platform: 'linux', portal: false, log: mock.log });
    const selection: CaptureSelection = { coordinateSpace: 'source', sourceId: `${sourceKind}:granted`, sourceKind,
      sourceSize: { width: 640, height: 480 }, crop: { x: 0, y: 0, width: 640, height: 480 }, hdrToneMapped: false };
    const controls = windows.createRecordingControls(selection, vi.fn());
    expect(mock.windows).toHaveLength(1);
    expect(mock.windows[0].setPosition).not.toHaveBeenCalled();
    expect(mock.windows[0].setBounds).not.toHaveBeenCalled();
    controls.dispose();
  });
  it('waits out desktop panel/dock clamping before exposing physical-frame coordinates on every selected display', async () => {
    windows.dispose(); windows = createCaptureWindows({platform:'linux',portal:false,log:mock.log});
    mock.settings.clampOnShow = true;
    mock.displays.push({...mock.display,id:2,bounds:{x:-1200,y:-300,width:1200,height:800},workArea:{x:-1134,y:-268,width:1134,height:768}});
    const abort = new AbortController(); const selection = windows.select('record',abort.signal);
    await vi.waitFor(() => expect(mock.windows).toHaveLength(2));
    const initializations = mock.windows.map(window => {
      expect(window.options).toMatchObject({fullscreen:true,fullscreenable:true,frame:false});
      window.webContents.emit('did-finish-load');
      expect(window.getContentBounds().x).toBe(window.options.x + 66);
      return mock.handlers.get(CH.init)!({sender:window.webContents,senderFrame:window.webContents.mainFrame});
    });
    const configurations = await Promise.all(initializations);
    for (const [index,config] of configurations.entries()) {
      expect(mock.windows[index].getContentBounds()).toEqual(mock.displays[index].bounds);
      expect(config).toMatchObject({kind:'selection',image:{selection:{displayId:String(mock.displays[index].id),displayBounds:mock.displays[index].bounds}}});
    }
    abort.abort(); expect(await selection).toBeNull();
  });
  it('rejects failed native mapping within a bounded wait and closes all owned selectors', async () => {
    windows.dispose(); windows = createCaptureWindows({ platform: 'linux', portal: false, log: mock.log });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const pending = windows.select('record', new AbortController().signal);
      const failed = expect(pending).rejects.toThrow('could not cover the chosen display');
      await vi.advanceTimersByTimeAsync(0);
      const window = mock.windows[0];
      vi.spyOn(window, 'setFullScreen').mockImplementation(() => undefined);
      window.webContents.emit('did-finish-load');
      const initialized = mock.handlers.get(CH.init)!({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
      await vi.advanceTimersByTimeAsync(15020);
      await failed;
      expect(await initialized).toBeNull();
      expect(window.destroyed).toBe(true);
      expect(mock.log.error).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});

describe('capture window policy composition', () => {
  it.each(['darwin', 'win32'] as const)('preserves protected desktop controls for %s independent of the host OS', (platform) => {
    windows.dispose();
    windows = createCaptureWindows({ platform: 'linux', portal: false, windowPolicy: resolveCaptureWindowPolicy(platform, false), log: mock.log });
    const selection: CaptureSelection = { sourceId: 'screen:1', sourceKind: 'screen', sourceSize: { width: 2400, height: 1600 }, crop: { x: 300, y: 300, width: 800, height: 600 }, displayBounds: mock.display.bounds, displayId: '1', hdrToneMapped: false };
    const controls = windows.createRecordingControls(selection, vi.fn());
    expect(mock.windows).toHaveLength(2);
    for (const window of mock.windows) expect(window.setContentProtection).toHaveBeenCalledWith(true);
    expect(mock.windows[0].options).toMatchObject({ frame: false, alwaysOnTop: true, height: 60 });
    expect(mock.windows[0].setPosition).not.toHaveBeenCalled();
    controls.hideForRecording?.();
    expect(mock.windows[0].hide).not.toHaveBeenCalled();
    controls.dispose();
    expect(mock.windows.every(window => window.destroyed)).toBe(true);
  });
});

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


describe('hover window detection', () => {
  const init = (window: any) => mock.handlers.get(CH.init)!({ sender: window.webContents, senderFrame: window.webContents.mainFrame }) as { regions?: unknown };

  it('sends each display its own window regions in frozen-frame pixels, taken after the freeze', async () => {
    mock.displays.push({ ...mock.display, id: 2, scaleFactor: 1, size: { width: 1200, height: 800 }, bounds: { x: 1200, y: 0, width: 1200, height: 800 } });
    const listWindows = vi.fn(() => { mock.timeline.push('windows'); return [
      { bounds: { x: 100, y: 50, width: 400, height: 300 }, space: 'dip' as const },
      { bounds: { x: 1100, y: 0, width: 300, height: 200 }, space: 'dip' as const },
    ]; });
    windows.dispose(); windows = createCaptureWindows({ platform: 'darwin', portal: false, log: mock.log, listWindows });
    const abort = new AbortController(); const pending = windows.captureStill(abort.signal);
    await vi.waitFor(() => expect(mock.windows).toHaveLength(2));
    expect(mock.timeline.slice(0, 4)).toEqual(['freeze', 'freeze', 'windows', 'catalog']);
    expect(init(mock.windows[0]).regions).toEqual([{ x: 200, y: 100, width: 800, height: 600 }, { x: 2200, y: 0, width: 200, height: 400 }]);
    expect(init(mock.windows[1]).regions).toEqual([{ x: 0, y: 0, width: 200, height: 200 }]);
    expect(listWindows).toHaveBeenCalledOnce();
    abort.abort(); expect(await pending).toBeNull();
  });

  it('keeps the existing manual selector when detection is unavailable or throws', async () => {
    for (const listWindows of [() => null, () => { throw new Error('native failure'); }]) {
      mock.windows.length = 0; mock.log.error.mockClear();
      windows.dispose(); windows = createCaptureWindows({ platform: 'win32', portal: false, log: mock.log, listWindows });
      const abort = new AbortController(); const pending = windows.captureStill(abort.signal);
      await vi.waitFor(() => expect(mock.windows).toHaveLength(1));
      expect(init(mock.windows[0])).not.toHaveProperty('regions');
      abort.abort(); expect(await pending).toBeNull();
    }
    expect(mock.log.error).toHaveBeenCalledOnce();
  });

  it('never enumerates desktop windows for a portal source preview', async () => {
    const listWindows = vi.fn(() => []);
    windows.dispose(); windows = createCaptureWindows({ platform: 'linux', portal: true, log: mock.log, listWindows });
    const image = { dataUrl: 'data:image/png;base64,frame', width: 100, height: 80,
      selection: { sourceId: 'screen:portal', sourceKind: 'screen' as const, sourceSize: { width: 100, height: 80 },
        crop: { x: 0, y: 0, width: 100, height: 80 }, coordinateSpace: 'source' as const, hdrToneMapped: false } };
    const abort = new AbortController(); const pending = windows.selectPrepared('record', image, abort.signal);
    await vi.waitFor(() => expect(mock.windows).toHaveLength(1));
    expect(init(mock.windows[0])).not.toHaveProperty('regions');
    expect(listWindows).not.toHaveBeenCalled();
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
    expect(control.options).toMatchObject({ ...placement, hasShadow: false });
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
    windows = createCaptureWindows({ platform: 'win32', portal: false, log: mock.log, captureWindowFrame: capture });
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
