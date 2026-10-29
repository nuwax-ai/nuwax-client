/**
 * 单元测试: geometry - 选区 DIP↔物理像素换算与偶数对齐
 *
 * 覆盖：
 * - normalizeSelection：任意拖拽方向规整、夹在显示器范围内、非法尺寸抛错
 * - dipRectToFramePixels：整数缩放(2x)、分数缩放(1.25x)无 1px 漂移、非整比例帧、
 *   越界夹取、选区至少 1px、非法尺寸抛错；属性：结果恒在帧内且宽高 ≥ 1
 * - toEvenSize：偶数不变；奇数优先右/下扩；右/下到头向左/上扩；整轴奇数才要求补边
 */

import { describe, it, expect } from "vitest";
import {
  dipRectToFramePixels,
  normalizeSelection,
  toEvenSize,
  type Rect,
} from "./geometry";

describe("normalizeSelection", () => {
  const bounds = { width: 1000, height: 600 };

  it("反向拖拽得到同一个矩形", () => {
    const a = normalizeSelection({ x: 100, y: 80 }, { x: 300, y: 200 }, bounds);
    const b = normalizeSelection({ x: 300, y: 200 }, { x: 100, y: 80 }, bounds);
    expect(a).toEqual({ x: 100, y: 80, width: 200, height: 120 });
    expect(b).toEqual(a);
  });

  it("夹在显示器范围内", () => {
    expect(
      normalizeSelection({ x: -50, y: -10 }, { x: 1200, y: 700 }, bounds),
    ).toEqual({ x: 0, y: 0, width: 1000, height: 600 });
  });

  it("显示器尺寸非法时抛错", () => {
    expect(() =>
      normalizeSelection({ x: 0, y: 0 }, { x: 1, y: 1 }, { width: 0, height: 10 }),
    ).toThrow(RangeError);
  });
});

describe("dipRectToFramePixels", () => {
  it("2x 缩放：坐标与尺寸都乘 2", () => {
    const out = dipRectToFramePixels(
      { x: 100, y: 50, width: 200, height: 100 },
      { width: 960, height: 540 },
      { width: 1920, height: 1080 },
    );
    expect(out).toEqual({ x: 200, y: 100, width: 400, height: 200 });
  });

  it("1.25x 分数缩放：按左右边分别取整，宽度不累计漂移", () => {
    const display = { width: 1536, height: 864 };
    const frame = { width: 1920, height: 1080 };
    // 逐像素扫一遍：相邻选区拼起来必须刚好覆盖整帧、不重叠不留缝
    let cursor = 0;
    for (let x = 0; x < 1536; x += 7) {
      const w = Math.min(7, 1536 - x);
      const out = dipRectToFramePixels({ x, y: 0, width: w, height: 864 }, display, frame);
      expect(out.x).toBe(cursor);
      cursor = out.x + out.width;
    }
    expect(cursor).toBe(1920);
  });

  it("帧与显示器比例不是整数时仍按实际比例换算", () => {
    const out = dipRectToFramePixels(
      { x: 0, y: 0, width: 1000, height: 600 },
      { width: 1000, height: 600 },
      { width: 1366, height: 768 },
    );
    expect(out).toEqual({ x: 0, y: 0, width: 1366, height: 768 });
  });

  it("越界选区夹在帧内", () => {
    const out = dipRectToFramePixels(
      { x: 900, y: 500, width: 500, height: 500 },
      { width: 1000, height: 600 },
      { width: 2000, height: 1200 },
    );
    expect(out.x + out.width).toBeLessThanOrEqual(2000);
    expect(out.y + out.height).toBeLessThanOrEqual(1200);
    expect(out).toEqual({ x: 1800, y: 1000, width: 200, height: 200 });
  });

  it("零面积选区至少保留 1px", () => {
    const out = dipRectToFramePixels(
      { x: 10, y: 10, width: 0, height: 0 },
      { width: 100, height: 100 },
      { width: 100, height: 100 },
    );
    expect(out.width).toBeGreaterThanOrEqual(1);
    expect(out.height).toBeGreaterThanOrEqual(1);
  });

  it("尺寸非法时抛错", () => {
    expect(() =>
      dipRectToFramePixels(
        { x: 0, y: 0, width: 1, height: 1 },
        { width: 100, height: 100 },
        { width: 0, height: 100 },
      ),
    ).toThrow(RangeError);
  });

  it("属性：任意选区的结果恒在帧内且宽高 ≥ 1", () => {
    const display = { width: 1440, height: 900 };
    const frame = { width: 2880, height: 1800 };
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 500; i++) {
      const sel: Rect = {
        x: rnd() * 1600 - 80,
        y: rnd() * 1000 - 50,
        width: rnd() * 1600,
        height: rnd() * 1000,
      };
      const out = dipRectToFramePixels(sel, display, frame);
      expect(out.x).toBeGreaterThanOrEqual(0);
      expect(out.y).toBeGreaterThanOrEqual(0);
      expect(out.width).toBeGreaterThanOrEqual(1);
      expect(out.height).toBeGreaterThanOrEqual(1);
      expect(out.x + out.width).toBeLessThanOrEqual(frame.width);
      expect(out.y + out.height).toBeLessThanOrEqual(frame.height);
    }
  });
});

describe("toEvenSize", () => {
  const frame = { width: 1920, height: 1080 };

  it("偶数宽高不调整", () => {
    const out = toEvenSize({ x: 10, y: 10, width: 100, height: 50 }, frame);
    expect(out).toEqual({
      rect: { x: 10, y: 10, width: 100, height: 50 },
      padRight: false,
      padBottom: false,
      adjusted: false,
    });
  });

  it("奇数优先向右/下多取 1px 真实内容", () => {
    const out = toEvenSize({ x: 10, y: 10, width: 101, height: 51 }, frame);
    expect(out.rect).toEqual({ x: 10, y: 10, width: 102, height: 52 });
    expect(out.padRight).toBe(false);
    expect(out.padBottom).toBe(false);
    expect(out.adjusted).toBe(true);
  });

  it("右/下已到帧边缘则向左/上多取 1px", () => {
    const out = toEvenSize({ x: 1819, y: 979, width: 101, height: 101 }, frame);
    expect(out.rect).toEqual({ x: 1818, y: 978, width: 102, height: 102 });
    expect(out.padRight).toBe(false);
    expect(out.padBottom).toBe(false);
  });

  it("整轴都是奇数且无处可扩时要求编码器补边，尺寸保持不变", () => {
    const odd = { width: 1921, height: 1081 };
    const out = toEvenSize({ x: 0, y: 0, width: 1921, height: 1081 }, odd);
    expect(out.rect).toEqual({ x: 0, y: 0, width: 1921, height: 1081 });
    expect(out.padRight).toBe(true);
    expect(out.padBottom).toBe(true);
    expect(out.adjusted).toBe(true);
  });

  it("属性：结果恒在帧内，且除补边外宽高为偶数", () => {
    const f = { width: 1001, height: 777 };
    for (let w = 1; w <= 60; w += 1) {
      for (const x of [0, 1, f.width - w, f.width - w - 1]) {
        if (x < 0) continue;
        const out = toEvenSize({ x, y: 0, width: w, height: 31 }, f);
        expect(out.rect.x).toBeGreaterThanOrEqual(0);
        expect(out.rect.x + out.rect.width).toBeLessThanOrEqual(f.width);
        if (!out.padRight) expect(out.rect.width % 2).toBe(0);
        if (!out.padBottom) expect(out.rect.height % 2).toBe(0);
      }
    }
  });
});
