import { describe, expect, it } from 'vitest';
import { MAX_REGIONS, projectWindowsToDisplay } from './project';
import type { NativeWindowInfo } from './types';

const dip = (x: number, y: number, width: number, height: number): NativeWindowInfo => ({ bounds: { x, y, width, height }, space: 'dip' });
const physical = (x: number, y: number, width: number, height: number): NativeWindowInfo => ({ bounds: { x, y, width, height }, space: 'physical' });

describe('projectWindowsToDisplay', () => {
  const retina = { bounds: { x: 0, y: 0, width: 1440, height: 900 }, physicalBounds: { x: 0, y: 0, width: 2880, height: 1800 } };

  it('maps macOS DIP windows onto a Retina frame and keeps topmost-first order', () => {
    expect(projectWindowsToDisplay([dip(100, 50, 400, 300), dip(0, 0, 1440, 900)], retina, { width: 2880, height: 1800 }))
      .toEqual([{ x: 200, y: 100, width: 800, height: 600 }, { x: 0, y: 0, width: 2880, height: 1800 }]);
  });

  it('clips a window that spans two displays to the part on each display', () => {
    const left = { bounds: { x: -1280, y: 0, width: 1280, height: 1024 }, physicalBounds: { x: -1280, y: 0, width: 1280, height: 1024 } };
    const spanning = dip(-200, 100, 600, 400);
    expect(projectWindowsToDisplay([spanning], left, { width: 1280, height: 1024 })).toEqual([{ x: 1080, y: 100, width: 200, height: 400 }]);
    expect(projectWindowsToDisplay([spanning], retina, { width: 2880, height: 1800 })).toEqual([{ x: 0, y: 200, width: 800, height: 800 }]);
  });

  it('maps physical windows on a 150% secondary display with a negative physical origin', () => {
    const scaled = { bounds: { x: -1280, y: -200, width: 1280, height: 720 }, physicalBounds: { x: -1920, y: -300, width: 1920, height: 1080 } };
    // A maximized Windows frame extends past the work area by its invisible resize border.
    expect(projectWindowsToDisplay([physical(-1928, -308, 1936, 1096), physical(-1500, 0, 300, 201)], scaled, { width: 1920, height: 1080 }))
      .toEqual([{ x: 0, y: 0, width: 1920, height: 1080 }, { x: 420, y: 300, width: 300, height: 201 }]);
  });

  it('uses the actual frame/display ratio for fractional scaling without drifting the right edge', () => {
    const fractional = { bounds: { x: 0, y: 0, width: 1536, height: 864 }, physicalBounds: { x: 0, y: 0, width: 1920, height: 1080 } };
    const [region] = projectWindowsToDisplay([dip(333, 111, 777, 555)], fractional, { width: 1920, height: 1080 });
    expect(region).toEqual({ x: 416, y: 139, width: 972, height: 694 });
    expect(region.x + region.width).toBe(Math.round((333 + 777) * 1.25));
  });

  it('drops off-display, tiny, empty and non-finite windows', () => {
    const windows = [dip(2000, 0, 300, 300), dip(10, 10, 3, 300), dip(10, 10, 0, 0), dip(Number.NaN, 0, 100, 100), dip(10, 10, 100, Number.POSITIVE_INFINITY)];
    expect(projectWindowsToDisplay(windows, retina, { width: 2880, height: 1800 })).toEqual([{ x: 20, y: 20, width: 200, height: 1780 }]);
  });

  it('caps the number of regions sent to the overlay', () => {
    const many = Array.from({ length: MAX_REGIONS + 10 }, (_, index) => dip(index, index, 100, 100));
    expect(projectWindowsToDisplay(many, retina, { width: 2880, height: 1800 })).toHaveLength(MAX_REGIONS);
  });
});
