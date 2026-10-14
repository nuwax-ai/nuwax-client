import { describe, expect, it, vi } from 'vitest';
import type { Koffi } from './koffi';
import { createDarwinWindowReader, selectDarwinWindows } from './darwin';
import { createWin32WindowReader, selectWin32Windows } from './win32';
import { createX11WindowReader, selectX11Windows } from './linux';
import { createNativeWindowLister } from './index';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/nonexistent/app' }, screen: {} }));

/** A koffi double whose functions are plain JS implementations keyed by symbol name. */
function fakeKoffi(symbols: Record<string, (...args: any[]) => any>, extra: Partial<Koffi> = {}): Koffi & { loaded: string[] } {
  const loaded: string[] = [];
  return {
    loaded,
    load(path) {
      loaded.push(path);
      return { func: (...definition: unknown[]) => {
        const name = definition.find((part) => typeof part === 'string' && part in symbols) as string | undefined;
        if (!name) throw new Error(`unexpected symbol ${String(definition[0])}`);
        return symbols[name];
      } };
    },
    struct: (name) => name, pointer: (type) => type, out: (type) => type, proto: (definition) => definition,
    register: () => 'handler', unregister: () => undefined,
    decode: (pointer) => pointer as number[],
    ...extra,
  };
}

describe('macOS window list', () => {
  it('keeps on-screen application windows in front-to-back order and releases the copied list', () => {
    const list = [
      { kCGWindowLayer: 25, kCGWindowAlpha: 1, kCGWindowBounds: { x: 0, y: 0, width: 1440, height: 24 } },
      { kCGWindowLayer: 0, kCGWindowAlpha: 1, kCGWindowBounds: { x: 100, y: 80, width: 800, height: 600 } },
      { kCGWindowLayer: 0, kCGWindowAlpha: 0, kCGWindowBounds: { x: 0, y: 0, width: 300, height: 300 } },
      { kCGWindowLayer: 0, kCGWindowAlpha: 1, kCGWindowBounds: { x: -1200, y: 40, width: 600, height: 400 } },
    ];
    const released: unknown[] = [];
    const read = createDarwinWindowReader(fakeKoffi({
      CGWindowListCopyWindowInfo: (options: number, relative: number) => { expect([options, relative]).toEqual([17, 0]); return list; },
      CFArrayGetCount: (array: unknown[]) => array.length,
      CFArrayGetValueAtIndex: (array: unknown[], index: number) => array[index],
      // Values are boxed like CFTypeRefs: a CFNumber holding 0 is still a non-null pointer.
      CFDictionaryGetValue: (dictionary: Record<string, unknown>, key: string) => key in dictionary ? { boxed: dictionary[key] } : null,
      CFNumberGetValue: (value: { boxed: number }, type: number, out: number[]) => { expect(type).toBe(13); out[0] = value.boxed; return true; },
      CGRectMakeWithDictionaryRepresentation: (bounds: { boxed: object }, rect: object) => { Object.assign(rect, bounds.boxed); return true; },
      CFStringCreateWithCString: (_allocator: null, value: string) => value,
      CFRelease: (value: unknown) => released.push(value),
    }));
    expect(read()).toEqual([
      { bounds: { x: 100, y: 80, width: 800, height: 600 }, space: 'dip' },
      { bounds: { x: -1200, y: 40, width: 600, height: 400 }, space: 'dip' },
    ]);
    expect(released).toEqual([list]);
  });

  it('drops windows with missing numbers or bounds', () => {
    expect(selectDarwinWindows([
      { layer: Number.NaN, alpha: 1, bounds: { x: 0, y: 0, width: 10, height: 10 } },
      { layer: 0, alpha: 1, bounds: null },
      { layer: 0, alpha: 1, bounds: { x: 0, y: 0, width: 0, height: 10 } },
    ])).toEqual([]);
  });
});

describe('Windows window list', () => {
  const frame = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

  it('walks the Z order top-down using DWM frames and skips hidden, minimized, cloaked, click-through and shell windows', () => {
    const windows = new Map<number, { visible: boolean; iconic?: boolean; cloaked?: boolean; exStyle?: number; className: string; dwm?: ReturnType<typeof frame>; rect?: ReturnType<typeof frame> }>([
      [11, { visible: true, className: 'Chrome_WidgetWin_1', dwm: frame(0, 0, 1920, 1040) }],
      [12, { visible: false, className: 'Hidden', dwm: frame(0, 0, 100, 100) }],
      [13, { visible: true, iconic: true, className: 'Minimized', dwm: frame(0, 0, 100, 100) }],
      [14, { visible: true, cloaked: true, className: 'ApplicationFrameWindow', dwm: frame(0, 0, 800, 600) }],
      [15, { visible: true, exStyle: 0x80020, className: 'Overlay', dwm: frame(0, 0, 1920, 1080) }],
      [16, { visible: true, className: 'Notepad', rect: frame(2000, 100, 2600, 500) }],
      [17, { visible: true, className: 'WorkerW', dwm: frame(0, 0, 1920, 1080) }],
    ]);
    const order = [...windows.keys()];
    const read = createWin32WindowReader(fakeKoffi({
      GetTopWindow: (parent: number) => { expect(parent).toBe(0); return order[0]; },
      GetWindow: (handle: number, command: number) => { expect(command).toBe(2); return order[order.indexOf(handle) + 1] ?? 0; },
      IsWindowVisible: (handle: number) => Number(windows.get(handle)!.visible),
      IsIconic: (handle: number) => Number(windows.get(handle)!.iconic ?? false),
      GetWindowLongW: (handle: number, index: number) => { expect(index).toBe(-20); return windows.get(handle)!.exStyle ?? 0; },
      GetClassNameW: (handle: number, buffer: Buffer, capacity: number) => {
        const name = windows.get(handle)!.className;
        expect(capacity).toBe(256); buffer.write(name, 'utf16le'); return name.length;
      },
      GetWindowRect: (handle: number, out: object) => { const rect = windows.get(handle)!.rect; if (!rect) return 0; Object.assign(out, rect); return 1; },
      DwmGetWindowAttribute: (handle: number, attribute: number, out: any, size: number) => {
        const window = windows.get(handle)!;
        if (attribute === 9) { expect(size).toBe(16); if (!window.dwm) return -1; Object.assign(out, window.dwm); return 0; }
        expect([attribute, size]).toEqual([14, 4]); out[0] = window.cloaked ? 2 : 0; return 0;
      },
    }));
    expect(read()).toEqual([
      { bounds: { x: 0, y: 0, width: 1920, height: 1040 }, space: 'physical' },
      { bounds: { x: 2000, y: 100, width: 600, height: 400 }, space: 'physical' },
    ]);
  });

  it('stops on a cyclic Z order rather than hanging', () => {
    const read = createWin32WindowReader(fakeKoffi({
      GetTopWindow: () => 5, GetWindow: () => 5, IsWindowVisible: () => 0, IsIconic: () => 0, GetWindowLongW: () => 0,
      GetClassNameW: () => 0, GetWindowRect: () => 0, DwmGetWindowAttribute: () => -1,
    }));
    expect(read()).toEqual([]);
  });

  it('ignores windows without a usable frame', () => {
    expect(selectWin32Windows([
      { iconic: false, cloaked: false, exStyle: 0, className: 'A', frame: null },
      { iconic: false, cloaked: false, exStyle: 0, className: 'B', frame: frame(10, 10, 10, 50) },
    ])).toEqual([]);
  });
});

describe('X11 window list', () => {
  const atoms = ['_NET_CLIENT_LIST_STACKING', '_NET_FRAME_EXTENTS', '_GTK_FRAME_EXTENTS', '_NET_WM_STATE', '_NET_WM_STATE_HIDDEN',
    '_NET_WM_DESKTOP', '_NET_WM_WINDOW_TYPE', '_NET_WM_WINDOW_TYPE_DESKTOP', '_NET_CURRENT_DESKTOP'];
  const atom = (name: string) => 100 + atoms.indexOf(name);

  function server(properties: Record<number, Record<string, number[]>>, geometry: Record<number, { x: number; y: number; width: number; height: number }>, options: { failGeometry?: boolean } = {}) {
    const calls: string[] = [];
    const symbols = {
      XOpenDisplay: (name: null) => { expect(name).toBeNull(); return 'display'; },
      XCloseDisplay: () => { calls.push('close'); return 0; },
      XDefaultRootWindow: () => 1,
      XInternAtom: (_display: string, name: string, onlyIfExists: number) => { expect(onlyIfExists).toBe(0); return atom(name); },
      XGetWindowProperty: (_d: string, window: number, property: number, _offset: number, _length: number, _delete: number, _type: number,
        type: number[], format: number[], items: number[], _after: number[], data: unknown[]) => {
        const value = properties[window]?.[atoms[property - 100]];
        type[0] = value ? 6 : 0; format[0] = value ? 32 : 0; items[0] = value?.length ?? 0; data[0] = value ?? null;
        return 0;
      },
      XFree: () => 1,
      XGetGeometry: (_d: string, window: number, _root: number[], _x: number[], _y: number[], width: number[], height: number[]) => {
        if (options.failGeometry) throw new Error('BadWindow');
        const g = geometry[window]; if (!g) return 0; width[0] = g.width; height[0] = g.height; return 1;
      },
      XTranslateCoordinates: (_d: string, window: number, root: number, _sx: number, _sy: number, x: number[], y: number[]) => {
        expect(root).toBe(1); const g = geometry[window]; if (!g) return 0; x[0] = g.x; y[0] = g.y; return 1;
      },
      XSetErrorHandler: (handler: unknown) => { calls.push(`handler:${String(handler)}`); return handler === 'handler' ? 'chromium' : null; },
    };
    return { calls, koffi: fakeKoffi(symbols, { register: () => { calls.push('register'); return 'handler'; }, unregister: () => { calls.push('unregister'); } }) };
  }

  it('reverses the stacking list, adds WM frames, removes GTK shadows and skips hidden, desktop and other-workspace windows', () => {
    const { koffi, calls } = server({
      1: { _NET_CLIENT_LIST_STACKING: [10, 11, 12, 13, 14, 15], _NET_CURRENT_DESKTOP: [1] },
      10: { _NET_WM_WINDOW_TYPE: [atom('_NET_WM_WINDOW_TYPE_DESKTOP')] },
      11: { _NET_FRAME_EXTENTS: [2, 2, 30, 2], _NET_WM_DESKTOP: [1] },
      12: { _NET_WM_STATE: [atom('_NET_WM_STATE_HIDDEN')], _NET_WM_DESKTOP: [1] },
      13: { _NET_WM_DESKTOP: [0] },
      14: { _GTK_FRAME_EXTENTS: [20, 20, 16, 24], _NET_WM_DESKTOP: [0xffffffff] },
      15: { _NET_WM_DESKTOP: [1] },
    }, {
      10: { x: 0, y: 0, width: 3840, height: 2160 }, 11: { x: 102, y: 130, width: 800, height: 600 }, 12: { x: 0, y: 0, width: 100, height: 100 },
      13: { x: 0, y: 0, width: 400, height: 400 }, 14: { x: 500, y: 500, width: 840, height: 640 },
    });
    expect(createX11WindowReader(koffi)()).toEqual([
      { bounds: { x: 520, y: 516, width: 800, height: 600 }, space: 'physical' },
      { bounds: { x: 100, y: 100, width: 804, height: 632 }, space: 'physical' },
    ]);
    expect(calls).toEqual(['register', 'handler:handler', 'close', 'handler:chromium', 'unregister']);
  });

  it('restores the previous error handler and closes the display even when a query throws', () => {
    const { koffi, calls } = server({ 1: { _NET_CLIENT_LIST_STACKING: [11] } }, {}, { failGeometry: true });
    expect(() => createX11WindowReader(koffi)()).toThrow('BadWindow');
    expect(calls).toEqual(['register', 'handler:handler', 'close', 'handler:chromium', 'unregister']);
  });

  it('treats a missing EWMH stacking list as no windows', () => {
    const { koffi } = server({ 1: {} }, {});
    expect(createX11WindowReader(koffi)()).toEqual([]);
  });

  it('keeps windows when the window manager publishes no workspace information', () => {
    expect(selectX11Windows([{ client: { x: 1, y: 2, width: 3, height: 4 }, frameExtents: null, gtkFrameExtents: [1, 1], desktop: null, hidden: false, desktopType: false }], null))
      .toEqual([{ bounds: { x: 1, y: 2, width: 3, height: 4 }, space: 'physical' }]);
  });
});

describe('createNativeWindowLister', () => {
  const log = () => ({ warn: vi.fn(), error: vi.fn() });

  it('reports unavailable without logging when no admitted module exists', () => {
    const logger = log();
    const list = createNativeWindowLister({ platform: 'darwin', log: logger, loadKoffi: () => null });
    expect(list()).toBeNull(); expect(list()).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('binds once, and a module that fails to load is reported once and stays disabled', () => {
    const logger = log();
    const loadKoffi = vi.fn(() => { throw new Error('dlopen failed'); });
    const list = createNativeWindowLister({ platform: 'linux', log: logger, loadKoffi });
    expect(list()).toBeNull(); expect(list()).toBeNull();
    expect(loadKoffi).toHaveBeenCalledOnce(); expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('reports a failed enumeration and tries again on the next capture', () => {
    const logger = log();
    let fail = true;
    const koffi = fakeKoffi({
      CGWindowListCopyWindowInfo: () => { if (fail) throw new Error('transient'); return []; },
      CFArrayGetCount: () => 0, CFArrayGetValueAtIndex: () => null, CFDictionaryGetValue: () => null, CFNumberGetValue: () => false,
      CGRectMakeWithDictionaryRepresentation: () => false, CFStringCreateWithCString: () => 'key', CFRelease: () => undefined,
    });
    const list = createNativeWindowLister({ platform: 'darwin', log: logger, loadKoffi: () => koffi });
    expect(list()).toBeNull(); expect(logger.warn).toHaveBeenCalledOnce();
    fail = false; expect(list()).toEqual([]);
    expect(koffi.loaded).toHaveLength(2);
  });

  it('has no reader for unsupported platforms', () => {
    expect(createNativeWindowLister({ platform: 'freebsd', log: log(), loadKoffi: () => fakeKoffi({}) })()).toBeNull();
  });
});
