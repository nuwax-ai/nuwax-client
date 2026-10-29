/**
 * 单元测试: hdr - 显示器 HDR / 广色域判定（临时判据）
 *
 * 覆盖：sRGB 屏、PQ/HLG/scRGB 传输函数判 HDR、Display P3 判广色域但非 HDR、
 * 缺失字段按 SDR 处理、summarizeDisplays 的形状与 anyHdr。
 * 真实 Electron 字符串由 Phase 0 核对后补进夹具。
 */

import { describe, it, expect } from "vitest";
import {
  anyHdr,
  classifyDisplayColor,
  summarizeDisplays,
  type DisplayLike,
} from "./hdr";

const display = (colorSpace: string | undefined, id = 1, scaleFactor = 1): DisplayLike => ({
  id,
  scaleFactor,
  colorSpace,
  depthPerComponent: 8,
});

describe("classifyDisplayColor", () => {
  it("sRGB 屏：既不是 HDR 也不是广色域", () => {
    expect(
      classifyDisplayColor(display("{primaries:BT709, transfer:SRGB, matrix:RGB, range:FULL}")),
    ).toEqual({ hdr: false, wideGamut: false });
  });

  it("PQ / HLG / scRGB 传输函数判为 HDR", () => {
    for (const cs of [
      "{primaries:BT2020, transfer:PQ, matrix:RGB, range:FULL}",
      "{primaries:BT2020, transfer:HLG, matrix:RGB, range:FULL}",
      "{primaries:BT709, transfer:LINEAR_HDR, matrix:RGB, range:FULL}",
      "scRGB linear",
    ]) {
      expect(classifyDisplayColor(display(cs)).hdr).toBe(true);
    }
  });

  it("Display P3 判为广色域，但不是 HDR", () => {
    expect(
      classifyDisplayColor(display("{primaries:P3, transfer:SRGB, matrix:RGB, range:FULL}")),
    ).toEqual({ hdr: false, wideGamut: true });
  });

  it("缺失或空的色彩空间按 SDR 处理", () => {
    expect(classifyDisplayColor(display(undefined))).toEqual({ hdr: false, wideGamut: false });
    expect(classifyDisplayColor(display(""))).toEqual({ hdr: false, wideGamut: false });
  });
});

describe("summarizeDisplays / anyHdr", () => {
  const displays = [
    display("{primaries:BT709, transfer:SRGB, matrix:RGB, range:FULL}", 1, 2),
    display("{primaries:BT2020, transfer:PQ, matrix:RGB, range:FULL}", 2, 1.5),
  ];

  it("id 转字符串，带上 hdr 与缩放", () => {
    expect(summarizeDisplays(displays)).toEqual([
      { id: "1", hdr: false, scale: 2 },
      { id: "2", hdr: true, scale: 1.5 },
    ]);
  });

  it("anyHdr：任一块是 HDR 即为 true", () => {
    expect(anyHdr(displays)).toBe(true);
    expect(anyHdr([displays[0]])).toBe(false);
    expect(anyHdr([])).toBe(false);
  });
});
