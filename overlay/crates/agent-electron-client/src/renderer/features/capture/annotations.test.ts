import { describe, expect, it } from 'vitest';
import { createAnnotationHistory, createAnnotationPainter } from './annotations';
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
