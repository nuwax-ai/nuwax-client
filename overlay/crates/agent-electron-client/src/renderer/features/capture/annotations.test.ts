import { describe, expect, it } from 'vitest';
import { createAnnotationHistory, createAnnotationPainter, type CaptureAnnotation } from './annotations';
import { buildCaptureWindowHtml } from './windowHtml';

describe('annotation history', () => {
  it('preserves order across undo/redo and clears redo when a new operation is drawn', () => {
    const h = createAnnotationHistory<string>(); h.push('rectangle'); h.push('pen');
    expect(h.undo()).toBe(true); expect(h.values()).toEqual(['rectangle']);
    expect(h.redo()).toBe(true); expect(h.values()).toEqual(['rectangle', 'pen']);
    h.undo(); h.push('mosaic'); expect(h.redo()).toBe(false); expect(h.values()).toEqual(['rectangle', 'mosaic']);
    h.clear(); expect(h.canUndo()).toBe(false); expect(h.canRedo()).toBe(false);
  });
  it('returns a copy so consumers cannot mutate the operation order', () => {
    const h = createAnnotationHistory<number>(); h.push(1); h.values().push(2); expect(h.values()).toEqual([1]);
  });
  it('undoes edits and deletion in place without changing the draw order', () => {
    const h = createAnnotationHistory<string>(); h.push('text'); h.push('mosaic');
    h.replace(0, 'edited text'); expect(h.values()).toEqual(['edited text', 'mosaic']);
    h.undo(); expect(h.values()).toEqual(['text', 'mosaic']);
    h.redo(); expect(h.values()).toEqual(['edited text', 'mosaic']);
    h.replace(0, null); expect(h.values()).toEqual(['mosaic']);
    h.undo(); expect(h.values()).toEqual(['edited text', 'mosaic']);
    h.replace(0, 'another edit'); expect(h.canRedo()).toBe(false);
    expect(h.replace(-1, 'invalid')).toBe(false); expect(h.replace(10, null)).toBe(false);
  });
  it('can restore the last deleted annotation and treats unchanged replacements as a no-op', () => {
    const h = createAnnotationHistory<string>(); h.push('text');
    expect(h.replace(0, 'text')).toBe(false);
    h.replace(0, null); expect(h.canUndo()).toBe(true); expect(h.values()).toEqual([]);
    h.undo(); expect(h.values()).toEqual(['text']); h.undo(); expect(h.values()).toEqual([]);
  });
});

describe('annotation selection and editing geometry', () => {
  const ctx = { save() {}, restore() {}, font: '', measureText(text: string) { return { width: text.length * parseFloat(this.font) * 0.6 }; } } as CanvasRenderingContext2D;
  const painter = createAnnotationPainter();
  const annotation = (tool: CaptureAnnotation['tool']): CaptureAnnotation => ({ tool, color: '#ff0000', width: 4, points: [{ x: 100, y: 80 }, { x: 300, y: 180 }] });
  it.each(['rectangle', 'ellipse', 'mosaic'] as const)('selects the interior of %s but not distant points', tool => {
    expect(painter.hitTest(ctx, annotation(tool), { x: 200, y: 130 }, 5)).toBe(true);
    expect(painter.hitTest(ctx, annotation(tool), { x: 400, y: 130 }, 5)).toBe(false);
  });
  it.each(['arrow', 'pen'] as const)('selects %s strokes rather than their empty bounding-box corners', tool => {
    expect(painter.hitTest(ctx, annotation(tool), { x: 200, y: 130 }, 5)).toBe(true);
    expect(painter.hitTest(ctx, annotation(tool), { x: 110, y: 170 }, 5)).toBe(false);
  });
  it('measures text with its independent font size', () => {
    const text = { ...annotation('text'), points: [{ x: 100, y: 80 }], text: 'Text', fontSize: 40 };
    expect(painter.bounds(ctx, text)).toEqual({ x: 100, y: 80, width: 96, height: 48 });
    expect(painter.hitTest(ctx, text, { x: 190, y: 110 }, 0)).toBe(true);
    expect(painter.bounds(ctx, { ...text, width: 20 })).toEqual(painter.bounds(ctx, text));
  });
  it.each(['rectangle', 'ellipse', 'pen', 'mosaic'] as const)('resizes %s without mutating the old operation or its style', tool => {
    const original = annotation(tool);
    const resized = painter.resize(ctx, original, { x: 200, y: 300, width: 400, height: 200 });
    expect(resized.points).toEqual([{ x: 200, y: 300 }, { x: 600, y: 500 }]);
    expect(original.points).toEqual([{ x: 100, y: 80 }, { x: 300, y: 180 }]);
    expect(resized.width).toBe(4); expect(resized.color).toBe('#ff0000');
  });
});
describe('annotation geometry', () => {
  it('normalizes reverse rectangle drags and preserves physical pixels', () => {
    const calls: unknown[][] = [];
    const ctx = new Proxy({}, { get: (_target, key) => (...args: unknown[]) => calls.push([key, ...args]), set: () => true }) as CanvasRenderingContext2D;
    createAnnotationPainter().draw(ctx, { tool: 'rectangle', points: [{ x: 120, y: 80 }, { x: 30, y: 20 }], width: 4, color: '#ff0000' });
    expect(calls).toContainEqual(['rect', 30, 20, 90, 60]);
    expect(calls).toContainEqual(['stroke']);
  });
  it('embeds a self-contained runtime behind a restrictive CSP', () => {
    const html = buildCaptureWindowHtml('testnonce');
    expect(html).toContain("default-src 'none'"); expect(html).toContain("script-src 'nonce-testnonce'");
    expect(html).toContain('NuwaxCaptureWindow'); expect(html).not.toContain('https://');
    const match = html.match(/<script nonce="testnonce">([\s\S]*)<\/script>/);
    expect(match).not.toBeNull();
    expect(() => new Function(match![1])).not.toThrow();
  });
});
