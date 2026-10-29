import { describe, expect, it } from 'vitest';
import { isTrustedCaptureFrame, isValidCaptureCrop } from './windowSecurity';

describe('native capture window trust', () => {
  const url = 'data:text/html;charset=utf-8,owned-document';
  const frame = { url };
  const contents = { isDestroyed: () => false, mainFrame: frame };
  it('accepts only the exact owned contents and its current main frame', () => {
    expect(isTrustedCaptureFrame({ sender: contents, senderFrame: frame }, contents, url)).toBe(true);
    expect(isTrustedCaptureFrame({ sender: {}, senderFrame: frame }, contents, url)).toBe(false);
    expect(isTrustedCaptureFrame({ sender: contents, senderFrame: { url } }, contents, url)).toBe(false);
    expect(isTrustedCaptureFrame({ sender: contents, senderFrame: null }, contents, url)).toBe(false);
  });
  it('rejects navigated or destroyed windows even if other identity checks match', () => {
    expect(isTrustedCaptureFrame({ sender: contents, senderFrame: frame }, contents, 'data:text/html,other')).toBe(false);
    const destroyed = { isDestroyed: () => true, mainFrame: frame };
    expect(isTrustedCaptureFrame({ sender: destroyed, senderFrame: frame }, destroyed, url)).toBe(false);
  });
});
describe('pixel crop validation', () => {
  const size = { width: 2560, height: 1440 };
  it('accepts a whole screen and single-pixel edge crops', () => {
    expect(isValidCaptureCrop({ x: 0, y: 0, ...size }, size)).toBe(true);
    expect(isValidCaptureCrop({ x: 2559, y: 1439, width: 1, height: 1 }, size)).toBe(true);
  });
  it.each([
    null, {}, { x: -1, y: 0, width: 20, height: 20 }, { x: 0, y: 0, width: 0, height: 20 },
    { x: 2550, y: 0, width: 20, height: 20 }, { x: 0, y: 1430, width: 20, height: 20 },
    { x: 0.1, y: 0, width: 20, height: 20 }, { x: NaN, y: 0, width: 20, height: 20 },
  ])('rejects invalid or out-of-bounds crop %#', (value) => expect(isValidCaptureCrop(value, size)).toBe(false));
});
