import { describe, expect, it } from 'vitest';
import type { CaptureSelection } from '@shared/features/capture/windowContract';
import { toEvenSize } from './geometry';
import { recordingBorderBounds, recordingControlBounds, selectionDesktopRect } from './windowGeometry';
import { placeCaptureToolbar } from '@shared/features/capture/windowPlacement';
const selection: CaptureSelection = { sourceId: 'screen:1', sourceKind: 'screen', sourceSize: { width: 3200, height: 1800 }, crop: { x: 400, y: 300, width: 800, height: 600 }, displayBounds: { x: -1600, y: -200, width: 1600, height: 900 }, displayId: '1', hdrToneMapped: false };
describe('native recording window placement', () => {
  it('uses actual pixel ratios and negative desktop coordinates', () => {
    expect(selectionDesktopRect(selection)).toEqual({ x: -1400, y: -50, width: 400, height: 300 });
  });
  it('places the border outside the captured region', () => {
    expect(recordingBorderBounds(selection)).toEqual({ x: -1404, y: -54, width: 408, height: 308 });
  });
  it('anchors below and aligned to the selected region on its own display', () => {
    expect(recordingControlBounds(selection, selection.displayBounds)).toEqual({ x: -1440, y: 262, width: 440, height: 60 });
  });
  it('falls back to accessible controls for a whole-screen single-monitor recording', () => {
    const full = { ...selection, crop: { x: 0, y: 0, ...selection.sourceSize } };
    expect(recordingControlBounds(full, selection.displayBounds)).toEqual({ x: -1020, y: 628, width: 440, height: 60 });
  });
  it('uses the display where a window source was chosen without inventing real window bounds', () => {
    expect(recordingControlBounds({ ...selection, sourceKind: 'window' }, selection.displayBounds)).toEqual({ x: -1020, y: 628, width: 440, height: 60 });
  });
  const area = { x: 0, y: 28, width: 1280, height: 732 };
  it('flips above a bottom-edge region and keeps clear of the Dock', () => {
    expect(placeCaptureToolbar({ x: 700, y: 540, width: 500, height: 200 }, area, { width: 440, height: 60 })).toEqual({ x: 760, y: 468, width: 440, height: 60 });
  });
  it.each([{ x: 12, expectedX: 324 }, { x: 950, expectedX: 498 }])('uses adjacent free space for a tall region %#', ({ x, expectedX }) => {
    expect(placeCaptureToolbar({ x, y: 40, width: 300, height: 708 }, area, { width: 440, height: 60 })).toEqual({ x: expectedX, y: 364, width: 440, height: 60 });
  });
  it('clamps a wide annotation toolbar inside a narrow portrait work area', () => {
    const placed = placeCaptureToolbar({ x: -520, y: -1100, width: 480, height: 1000 }, { x: -540, y: -1172, width: 540, height: 1132 }, { width: 660, height: 100 });
    expect(placed.x).toBe(-528); expect(placed.width).toBe(516);
    expect(placed.y).toBeGreaterThanOrEqual(-1160);
    expect(placed.y + placed.height).toBeLessThanOrEqual(-52);
  });
});


describe('recording borders with mixed DPI and odd video crop dimensions', () => {
  const variants = [
    { bounds: { x: -1600, y: -200, width: 1600, height: 900 }, pixels: { width: 3200, height: 1800 } },
    { bounds: { x: 200, y: -1200, width: 900, height: 1200 }, pixels: { width: 1350, height: 1800 } },
    { bounds: { x: -1280, y: -256, width: 1280, height: 1024 }, pixels: { width: 1600, height: 1280 } },
    { bounds: { x: 100, y: 800, width: 1501, height: 901 }, pixels: { width: 2203, height: 1352 } },
  ];
  it.each(variants)('keeps border strokes beyond encoder crop expansion on every edge %#', ({ bounds, pixels }) => {
    for (const crop of [
      { x: 401, y: 301, width: 801, height: 601 },
      { x: pixels.width - 801, y: pixels.height - 601, width: 801, height: 601 },
      { x: 0, y: 0, width: 801, height: 601 },
    ]) {
      const selected = { ...selection, displayBounds: bounds, sourceSize: pixels, crop };
      const aligned = toEvenSize(crop, pixels).rect;
      const encoded = selectionDesktopRect({ ...selected, crop: aligned });
      const border = recordingBorderBounds(selected);
      expect(border.x + 3).toBeLessThanOrEqual(encoded.x);
      expect(border.y + 3).toBeLessThanOrEqual(encoded.y);
      expect(border.x + border.width - 3).toBeGreaterThanOrEqual(encoded.x + encoded.width);
      expect(border.y + border.height - 3).toBeGreaterThanOrEqual(encoded.y + encoded.height);
    }
  });
  it.each([
    { x: -1920, y: 0, width: 1920, height: 1080 },
    { x: 0, y: -1200, width: 900, height: 1200 },
    { x: 0, y: 900, width: 1600, height: 900 },
  ])('keeps full-screen controls on the selected display for negative and vertical layouts %#', (area) => {
    const full = { ...selection, displayBounds: area, crop: { x: 0, y: 0, ...selection.sourceSize } };
    const control = recordingControlBounds(full, area);
    expect(control.x).toBeGreaterThanOrEqual(area.x); expect(control.y).toBeGreaterThanOrEqual(area.y);
    expect(control.x + control.width).toBeLessThanOrEqual(area.x + area.width);
    expect(control.y + control.height).toBeLessThanOrEqual(area.y + area.height);
  });
});
