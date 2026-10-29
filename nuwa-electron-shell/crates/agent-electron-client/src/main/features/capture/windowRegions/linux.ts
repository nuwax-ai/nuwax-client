import type { Koffi } from './koffi';
import type { NativeWindowInfo } from './types';

/** Extents are [left, right, top, bottom] CARD32 values as stored by the window manager or GTK. */
export interface X11Window {
  /** Client area in root coordinates, physical pixels. */
  client: { x: number; y: number; width: number; height: number } | null;
  frameExtents: number[] | null;
  gtkFrameExtents: number[] | null;
  desktop: number | null;
  hidden: boolean;
  desktopType: boolean;
}

const ALL_DESKTOPS = 0xffffffff;

/** Topmost first. Server-side decorations are added; client-side (GTK) shadows are removed. */
export function selectX11Windows(windows: readonly X11Window[], currentDesktop: number | null): NativeWindowInfo[] {
  const selected: NativeWindowInfo[] = [];
  for (const window of windows) {
    if (!window.client || window.hidden || window.desktopType) continue;
    if (window.desktop !== null && currentDesktop !== null && window.desktop !== ALL_DESKTOPS && window.desktop !== currentDesktop) continue;
    let { x, y, width, height } = window.client;
    const frame = window.frameExtents?.length === 4 ? window.frameExtents : null;
    const gtk = window.gtkFrameExtents?.length === 4 ? window.gtkFrameExtents : null;
    if (frame) { x -= frame[0]; y -= frame[2]; width += frame[0] + frame[1]; height += frame[2] + frame[3]; }
    if (gtk) { x += gtk[0]; y += gtk[2]; width -= gtk[0] + gtk[1]; height -= gtk[2] + gtk[3]; }
    if (width > 0 && height > 0) selected.push({ bounds: { x, y, width, height }, space: 'physical' });
  }
  return selected;
}

const card32 = (value: number | bigint) => Number(BigInt(value) & 0xffffffffn);
const MAX_WINDOWS = 4096;

/** EWMH stacking order through Xlib; errors from windows destroyed mid-scan are absorbed by a scoped handler. */
export function createX11WindowReader(koffi: Koffi): () => NativeWindowInfo[] {
  const x11 = koffi.load('libX11.so.6');
  const ulong = koffi.out(koffi.pointer('unsigned long'));
  const int = koffi.out(koffi.pointer('int'));
  const uint = koffi.out(koffi.pointer('unsigned int'));
  const XOpenDisplay = x11.func('XOpenDisplay', 'void *', ['str']);
  const XCloseDisplay = x11.func('XCloseDisplay', 'int', ['void *']);
  const XDefaultRootWindow = x11.func('XDefaultRootWindow', 'unsigned long', ['void *']);
  const XInternAtom = x11.func('XInternAtom', 'unsigned long', ['void *', 'str', 'int']);
  const XGetWindowProperty = x11.func('XGetWindowProperty', 'int', ['void *', 'unsigned long', 'unsigned long', 'long', 'long', 'int', 'unsigned long',
    ulong, int, ulong, ulong, koffi.out(koffi.pointer('void *'))]);
  const XFree = x11.func('XFree', 'int', ['void *']);
  const XGetGeometry = x11.func('XGetGeometry', 'int', ['void *', 'unsigned long', ulong, int, int, uint, uint, uint, uint]);
  const XTranslateCoordinates = x11.func('XTranslateCoordinates', 'int', ['void *', 'unsigned long', 'unsigned long', 'int', 'int', int, int, ulong]);
  const XErrorHandler = koffi.proto('int NuwaxCaptureXErrorHandler(void *display, void *event)');
  const XSetErrorHandler = x11.func('XSetErrorHandler', 'void *', ['void *']);
  return () => {
    const display = XOpenDisplay(null);
    if (!display) return [];
    const ignore = koffi.register(() => 0, koffi.pointer(XErrorHandler));
    const previous = XSetErrorHandler(ignore);
    try {
      const root = XDefaultRootWindow(display);
      const atom = (name: string) => XInternAtom(display, name, 0);
      const longs = (window: unknown, property: unknown): number[] | null => {
        const type = [0], format = [0], items = [0], after = [0], data = [null];
        if (XGetWindowProperty(display, window, property, 0, MAX_WINDOWS, 0, 0, type, format, items, after, data) !== 0 || !data[0]) return null;
        try { return format[0] === 32 ? Array.from(koffi.decode(data[0], 'unsigned long', Number(items[0])), card32) : null; }
        finally { XFree(data[0]); }
      };
      const stacking = longs(root, atom('_NET_CLIENT_LIST_STACKING'));
      if (!stacking) return [];
      const [frameAtom, gtkAtom, stateAtom, hiddenAtom, desktopAtom, typeAtom, desktopTypeAtom] = ['_NET_FRAME_EXTENTS', '_GTK_FRAME_EXTENTS',
        '_NET_WM_STATE', '_NET_WM_STATE_HIDDEN', '_NET_WM_DESKTOP', '_NET_WM_WINDOW_TYPE', '_NET_WM_WINDOW_TYPE_DESKTOP'].map(atom).map(Number);
      const windows: X11Window[] = [];
      // _NET_CLIENT_LIST_STACKING is bottom-to-top.
      for (const window of stacking.slice(-MAX_WINDOWS).reverse()) {
        const width = [0], height = [0], ignored = [0];
        const x = [0], y = [0], child = [0];
        const client = XGetGeometry(display, window, ignored, ignored, ignored, width, height, ignored, ignored) !== 0
          && XTranslateCoordinates(display, window, root, 0, 0, x, y, child) !== 0
          ? { x: x[0], y: y[0], width: width[0], height: height[0] } : null;
        windows.push({
          client,
          frameExtents: longs(window, frameAtom),
          gtkFrameExtents: longs(window, gtkAtom),
          desktop: longs(window, desktopAtom)?.[0] ?? null,
          hidden: longs(window, stateAtom)?.includes(hiddenAtom) ?? false,
          desktopType: longs(window, typeAtom)?.includes(desktopTypeAtom) ?? false,
        });
      }
      return selectX11Windows(windows, longs(root, atom('_NET_CURRENT_DESKTOP'))?.[0] ?? null);
    } finally {
      // Close while still absorbing errors so the final flush cannot reach a fatal default handler.
      XCloseDisplay(display);
      XSetErrorHandler(previous);
      koffi.unregister(ignore);
    }
  };
}
