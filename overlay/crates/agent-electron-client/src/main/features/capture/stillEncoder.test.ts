/**
 * 单元测试: stillEncoder - 静态图编码、默认格式、maxBytes 与「不缩放」
 *
 * 用假 NativeImage：JPEG 体积随质量单调下降，PNG 恒定。
 * 覆盖：默认格式选择；PNG 不随档位变化（单次编码、qualityUsed=lossless、maxBytes 如实超限）；
 * JPEG 逐级下探；JPEG 最低档仍超限；输出宽高恒等于输入（任何档位/格式）；非法格式。
 */

import { describe, it, expect, vi } from "vitest";
import { CAPTURE_QUALITIES } from "@shared/features/capture/contract";
import {
  createNativeImageEncoder,
  defaultStillFormat,
  encodeStill,
  type NativeImageLike,
} from "./stillEncoder";

function fakeImage(width = 1920, height = 1080): NativeImageLike & {
  toJPEG: ReturnType<typeof vi.fn>;
  toPNG: ReturnType<typeof vi.fn>;
} {
  return {
    getSize: () => ({ width, height }),
    toPNG: vi.fn(() => Buffer.alloc(5000)),
    // 质量越高体积越大：q * 10 字节
    toJPEG: vi.fn((q: number) => Buffer.alloc(q * 10)),
  };
}

describe("defaultStillFormat", () => {
  it("无损档默认 PNG，有损档默认 JPEG", () => {
    expect(defaultStillFormat("lossless")).toBe("png");
    for (const q of ["high", "medium", "low"] as const) {
      expect(defaultStillFormat(q)).toBe("jpeg");
    }
  });
});

describe("createNativeImageEncoder", () => {
  it("支持 png/jpeg，不支持 webp；只有 jpeg 随档位变化", () => {
    const e = createNativeImageEncoder();
    expect(e.supportedFormats()).toEqual(["png", "jpeg"]);
    expect(e.isQualityDependent("png")).toBe(false);
    expect(e.isQualityDependent("jpeg")).toBe(true);
  });

  it("webp 编码请求抛错（能力由 supportedFormats 对外声明）", () => {
    expect(() => createNativeImageEncoder().encode(fakeImage(), "webp", "high")).toThrow(
      /Unsupported/,
    );
  });
});

describe("encodeStill", () => {
  const encoder = createNativeImageEncoder();

  it("PNG：任何档位都只编码一次，qualityUsed 如实为 lossless", async () => {
    const img = fakeImage();
    const out = await encodeStill(img, { format: "png", compression: { quality: "low" } }, encoder);
    expect(img.toPNG).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ mime: "image/png", format: "png", qualityUsed: "lossless", exceedsMaxBytes: false });
  });

  it("PNG + maxBytes：无法靠换档达标，如实标记超限且不重复编码", async () => {
    const img = fakeImage();
    const out = await encodeStill(
      img,
      { format: "png", compression: { quality: "high", maxBytes: 100 } },
      encoder,
    );
    expect(img.toPNG).toHaveBeenCalledTimes(1);
    expect(out.exceedsMaxBytes).toBe(true);
  });

  it("JPEG：质量取自档位", async () => {
    const img = fakeImage();
    const out = await encodeStill(img, { format: "jpeg", compression: { quality: "medium" } }, encoder);
    expect(img.toJPEG).toHaveBeenCalledWith(85);
    expect(out).toMatchObject({ mime: "image/jpeg", qualityUsed: "medium", exceedsMaxBytes: false });
  });

  it("JPEG + maxBytes：逐级下探到第一个达标档位", async () => {
    const img = fakeImage();
    // high=950B, medium=850B, low=700B；上限 800B → 落在 low
    const out = await encodeStill(
      img,
      { format: "jpeg", compression: { quality: "high", maxBytes: 800 } },
      encoder,
    );
    expect(img.toJPEG.mock.calls.map((c) => c[0])).toEqual([95, 85, 70]);
    expect(out).toMatchObject({ qualityUsed: "low", exceedsMaxBytes: false });
    expect(out.data.length).toBe(700);
  });

  it("JPEG 最低档仍超限：如实标记，仍返回最低档结果", async () => {
    const img = fakeImage();
    const out = await encodeStill(
      img,
      { format: "jpeg", compression: { quality: "high", maxBytes: 10 } },
      encoder,
    );
    expect(out).toMatchObject({ qualityUsed: "low", exceedsMaxBytes: true });
  });

  it("未指定格式与档位：缺省 high + JPEG", async () => {
    const out = await encodeStill(fakeImage(), {}, encoder);
    expect(out).toMatchObject({ format: "jpeg", qualityUsed: "high" });
  });

  it("尺寸不变：任何档位×格式，输出宽高恒等于输入", async () => {
    for (const quality of CAPTURE_QUALITIES) {
      for (const format of ["png", "jpeg"] as const) {
        for (const maxBytes of [undefined, 1]) {
          const out = await encodeStill(
            fakeImage(1366, 767),
            { format, compression: { quality, maxBytes } },
            encoder,
          );
          expect([out.width, out.height]).toEqual([1366, 767]);
        }
      }
    }
  });
});
