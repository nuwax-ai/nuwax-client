import { screen, type Display } from 'electron';
import type { CaptureRect } from '@shared/features/capture/windowContract';
import { loadCaptureKoffi, type Koffi } from './koffi';
import { createDarwinWindowReader } from './darwin';
import { createWin32WindowReader } from './win32';
import { createX11WindowReader } from './linux';
import type { NativeWindowInfo, NativeWindowLister } from './types';
export { projectWindowsToDisplay } from './project';
export type { NativeWindowInfo, NativeWindowLister } from './types';

export interface NativeWindowListerOptions {
  platform: NodeJS.Platform;
  log: { warn?(...args: unknown[]): void; error(...args: unknown[]): void };
  loadKoffi?: () => Koffi | null;
}

const READERS: Partial<Record<NodeJS.Platform, (koffi: Koffi) => () => NativeWindowInfo[]>> = {
  darwin: createDarwinWindowReader, win32: createWin32WindowReader, linux: createX11WindowReader,
};

/**
 * Lazily binds the OS window list on first use. Any failure yields null so the selector
 * falls back to manual regions; capture itself never depends on window detection.
 */
export function createNativeWindowLister(options: NativeWindowListerOptions): NativeWindowLister {
  let reader: (() => NativeWindowInfo[]) | null | undefined;
  const warn = (message: string, error: unknown) => (options.log.warn ?? options.log.error).call(options.log, `[Capture] ${message}`, error);
  return () => {
    if (reader === undefined) {
      try {
        const koffi = (options.loadKoffi ?? loadCaptureKoffi)();
        const create = READERS[options.platform];
        reader = koffi && create ? create(koffi) : null;
      } catch (error) { reader = null; warn('window detection unavailable', error); }
    }
    if (!reader) return null;
    try { return reader(); }
    catch (error) { warn('window enumeration failed', error); return null; }
  };
}

/** The display in the same physical pixel space the OS reports window frames in. */
export function physicalDisplayBounds(display: Pick<Display, 'bounds' | 'scaleFactor'>, platform: NodeJS.Platform): CaptureRect {
  // Windows lays out mixed-DPI monitors non-linearly; only Electron's own conversion is exact.
  if (platform === 'win32' && typeof screen.dipToScreenRect === 'function') return screen.dipToScreenRect(null, display.bounds);
  const scale = display.scaleFactor;
  return { x: Math.round(display.bounds.x * scale), y: Math.round(display.bounds.y * scale),
    width: Math.round(display.bounds.width * scale), height: Math.round(display.bounds.height * scale) };
}
