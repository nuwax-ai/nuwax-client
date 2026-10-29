/**
 * 单元测试: tiers - 压缩档表与 maxBytes 逐级下探
 *
 * 覆盖：
 * - 档位单调：质量参数随档位降低而不增
 * - lowerQuality 链条与终点
 * - describeTiers 不泄漏内部编码参数
 * - fitToMaxBytes：无 maxBytes 只编码一次；达标即停；逐级下探；最低档仍超限如实标记；
 *   编码函数只收到档位（不可能缩放像素）
 */

import { describe, it, expect, vi } from "vitest";
import { CAPTURE_QUALITIES } from "@shared/features/capture/contract";
import {
  describeTiers,
  fitToMaxBytes,
  getTierParams,
  isCaptureQuality,
  lowerQuality,
} from "./tiers";

describe("tiers table", () => {
  it("每一档参数随档位降低单调不增", () => {
    for (let i = 1; i < CAPTURE_QUALITIES.length; i++) {
      const hi = getTierParams(CAPTURE_QUALITIES[i - 1]);
      const lo = getTierParams(CAPTURE_QUALITIES[i]);
      expect(lo.videoBitsPerPixel).toBeLessThan(hi.videoBitsPerPixel);
      expect(lo.gifMaxFps).toBeLessThanOrEqual(hi.gifMaxFps);
      expect(lo.gifColors).toBeLessThanOrEqual(hi.gifColors);
      expect(lo.vp9Crf).toBeGreaterThan(hi.vp9Crf);
      expect(lo.pngPaletteQuality).toBeLessThanOrEqual(hi.pngPaletteQuality);
    }
  });

  it("只有 lossless 档的静态图严格无损，且不走调色板", () => {
    expect(getTierParams("lossless").stillStrictlyLossless).toBe(true);
    expect(getTierParams("lossless").pngPalette).toBe(false);
    expect(getTierParams("lossless").stillQuality).toBeNull();
    for (const q of ["high", "medium", "low"] as const) {
      expect(getTierParams(q).stillStrictlyLossless).toBe(false);
      expect(getTierParams(q).stillQuality).not.toBeNull();
    }
  });

  it("describeTiers 覆盖全部档位且不含内部编码参数", () => {
    const d = describeTiers();
    expect(Object.keys(d)).toEqual([...CAPTURE_QUALITIES]);
    for (const q of CAPTURE_QUALITIES) {
      expect(d[q]).not.toHaveProperty("vp9Crf");
      expect(d[q]).not.toHaveProperty("pngPalette");
    }
  });

  it("isCaptureQuality 只认四个档位", () => {
    for (const q of CAPTURE_QUALITIES) expect(isCaptureQuality(q)).toBe(true);
    expect(isCaptureQuality("ultra")).toBe(false);
    expect(isCaptureQuality(undefined)).toBe(false);
    expect(isCaptureQuality(1)).toBe(false);
  });
});

describe("lowerQuality", () => {
  it("沿 lossless→high→medium→low 下探，low 之后为 null", () => {
    expect(lowerQuality("lossless")).toBe("high");
    expect(lowerQuality("high")).toBe("medium");
    expect(lowerQuality("medium")).toBe("low");
    expect(lowerQuality("low")).toBeNull();
  });
});

describe("fitToMaxBytes", () => {
  const sizes = { lossless: 1000, high: 600, medium: 300, low: 100 } as const;
  const encode = (q: keyof typeof sizes) =>
    Promise.resolve({ value: `v-${q}`, bytes: sizes[q] });

  it("没有 maxBytes 时只编码一次，沿用请求档位", async () => {
    const spy = vi.fn(encode);
    const out = await fitToMaxBytes("lossless", undefined, spy);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ quality: "lossless", bytes: 1000, exceedsMaxBytes: false });
  });

  it("请求档位已达标即停", async () => {
    const spy = vi.fn(encode);
    const out = await fitToMaxBytes("high", 600, spy);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(out.quality).toBe("high");
  });

  it("超限则逐级下探到第一个达标的档位", async () => {
    const spy = vi.fn(encode);
    const out = await fitToMaxBytes("lossless", 350, spy);
    expect(spy.mock.calls.map((c) => c[0])).toEqual(["lossless", "high", "medium"]);
    expect(out).toMatchObject({ quality: "medium", bytes: 300, exceedsMaxBytes: false });
  });

  it("最低档仍超限时如实标记 exceedsMaxBytes，而不是继续缩小任何别的东西", async () => {
    const spy = vi.fn(encode);
    const out = await fitToMaxBytes("lossless", 50, spy);
    expect(spy.mock.calls.map((c) => c[0])).toEqual(["lossless", "high", "medium", "low"]);
    expect(out).toMatchObject({ quality: "low", bytes: 100, exceedsMaxBytes: true });
  });

  it("encode 只会收到档位参数", async () => {
    const spy = vi.fn(encode);
    await fitToMaxBytes("high", 1, spy);
    for (const call of spy.mock.calls) expect(call).toHaveLength(1);
  });
});
