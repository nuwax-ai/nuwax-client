import type { Koffi } from './koffi';
import type { NativeWindowInfo } from './types';

export interface Win32Window {
  iconic: boolean;
  cloaked: boolean;
  exStyle: number;
  className: string;
  /** DWM extended frame bounds (no drop shadow), physical pixels. */
  frame: { left: number; top: number; right: number; bottom: number } | null;
}

const WS_EX_TRANSPARENT = 0x20;
// The desktop itself is the full-screen fallback, not a window to highlight.
const SHELL_CLASSES = new Set(['Progman', 'WorkerW']);

export function selectWin32Windows(windows: readonly Win32Window[]): NativeWindowInfo[] {
  const selected: NativeWindowInfo[] = [];
  for (const window of windows) {
    const frame = window.frame;
    // Click-through overlays (game bars, screen annotators) would otherwise swallow every hover.
    if (!frame || window.iconic || window.cloaked || window.exStyle & WS_EX_TRANSPARENT || SHELL_CLASSES.has(window.className)) continue;
    if (frame.right <= frame.left || frame.bottom <= frame.top) continue;
    selected.push({ bounds: { x: frame.left, y: frame.top, width: frame.right - frame.left, height: frame.bottom - frame.top }, space: 'physical' });
  }
  return selected;
}

const GW_HWNDNEXT = 2;
const GWL_EXSTYLE = -20;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const DWMWA_CLOAKED = 14;
const MAX_WINDOWS = 4096;

/** Read-only Z-order walk; no callbacks, no process handles. Electron is per-monitor DPI aware, so rects are physical. */
export function createWin32WindowReader(koffi: Koffi): () => NativeWindowInfo[] {
  const user32 = koffi.load('user32.dll'), dwmapi = koffi.load('dwmapi.dll');
  const RECT = koffi.struct('NuwaxCaptureRect', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });
  const GetTopWindow = user32.func('__stdcall', 'GetTopWindow', 'uintptr_t', ['uintptr_t']);
  const GetWindow = user32.func('__stdcall', 'GetWindow', 'uintptr_t', ['uintptr_t', 'uint32_t']);
  const IsWindowVisible = user32.func('__stdcall', 'IsWindowVisible', 'int', ['uintptr_t']);
  const IsIconic = user32.func('__stdcall', 'IsIconic', 'int', ['uintptr_t']);
  const GetWindowLongW = user32.func('__stdcall', 'GetWindowLongW', 'int32_t', ['uintptr_t', 'int']);
  const GetClassNameW = user32.func('__stdcall', 'GetClassNameW', 'int', ['uintptr_t', 'void *', 'int']);
  const GetWindowRect = user32.func('__stdcall', 'GetWindowRect', 'int', ['uintptr_t', koffi.out(koffi.pointer(RECT))]);
  const frameBounds = dwmapi.func('__stdcall', 'DwmGetWindowAttribute', 'int32_t', ['uintptr_t', 'uint32_t', koffi.out(koffi.pointer(RECT)), 'uint32_t']);
  const flag = dwmapi.func('__stdcall', 'DwmGetWindowAttribute', 'int32_t', ['uintptr_t', 'uint32_t', koffi.out(koffi.pointer('uint32_t')), 'uint32_t']);
  const className = Buffer.alloc(512);
  return () => {
    const windows: Win32Window[] = [];
    let handle = GetTopWindow(0);
    for (let count = 0; handle && count < MAX_WINDOWS; count++, handle = GetWindow(handle, GW_HWNDNEXT)) {
      if (!IsWindowVisible(handle)) continue;
      const frame = {} as NonNullable<Win32Window['frame']>;
      const hasFrame = frameBounds(handle, DWMWA_EXTENDED_FRAME_BOUNDS, frame, 16) === 0 || GetWindowRect(handle, frame) !== 0;
      const cloaked = [0];
      const length = GetClassNameW(handle, className, 256);
      windows.push({
        iconic: IsIconic(handle) !== 0,
        cloaked: flag(handle, DWMWA_CLOAKED, cloaked, 4) === 0 && cloaked[0] !== 0,
        exStyle: GetWindowLongW(handle, GWL_EXSTYLE),
        className: length > 0 ? className.toString('utf16le', 0, length * 2) : '',
        frame: hasFrame ? frame : null,
      });
    }
    return selectWin32Windows(windows);
  };
}
