import type { CaptureRect } from '@shared/features/capture/windowContract';

/** A visible top-level window in desktop coordinates; macOS reports DIP, Windows and X11 physical pixels. */
export interface NativeWindowInfo {
  bounds: CaptureRect;
  space: 'dip' | 'physical';
}

/** Topmost window first. Null means desktop geometry is unavailable, not that the desktop is empty. */
export type NativeWindowLister = () => NativeWindowInfo[] | null;
