import type { CaptureRect, CaptureSize } from '@shared/features/capture/windowContract';
import type { NativeWindowInfo } from './types';

export const MIN_REGION_PIXELS = 8;
export const MAX_REGIONS = 256;

export interface DisplayArea {
  /** The display in DIP, and the same display in the desktop's physical pixel space. */
  bounds: CaptureRect;
  physicalBounds: CaptureRect;
}

/** Desktop windows → integer rectangles in this display's frozen frame, clipped to it and still topmost first. */
export function projectWindowsToDisplay(windows: readonly NativeWindowInfo[], display: DisplayArea, frame: CaptureSize): CaptureRect[] {
  const regions: CaptureRect[] = [];
  for (const window of windows) {
    if (regions.length >= MAX_REGIONS) break;
    const area = window.space === 'dip' ? display.bounds : display.physicalBounds;
    if (!(area.width > 0 && area.height > 0)) continue;
    const left = Math.max(area.x, window.bounds.x), top = Math.max(area.y, window.bounds.y);
    const right = Math.min(area.x + area.width, window.bounds.x + window.bounds.width);
    const bottom = Math.min(area.y + area.height, window.bounds.y + window.bounds.height);
    // Negated so NaN geometry is skipped as well as empty intersections.
    if (!(right > left && bottom > top)) continue;
    const toX = (value: number) => Math.min(frame.width, Math.max(0, Math.round((value - area.x) * frame.width / area.width)));
    const toY = (value: number) => Math.min(frame.height, Math.max(0, Math.round((value - area.y) * frame.height / area.height)));
    const x = toX(left), y = toY(top), width = toX(right) - x, height = toY(bottom) - y;
    if (width < MIN_REGION_PIXELS || height < MIN_REGION_PIXELS) continue;
    regions.push({ x, y, width, height });
  }
  return regions;
}
