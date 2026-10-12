/**
 * 压缩档：质量档 → 编码参数的唯一事实源（纯数据，无依赖）。
 *
 * 铁律：任何一档都**不改变像素尺寸**，只改变编码质量（静态图量化/质量、视频码率、
 * GIF 帧率与色数）。`maxBytes` 只会让档位逐级下探，永远不会缩放。
 *
 * 位于 shared：main 做编码、preload 在特性关闭时据此返回「不可用」能力说明。
 * 数值为临时取值，Phase 0 真机实测体积与观感后再定稿；改数值只改本文件。
 *
 * 「lossless」档：PNG 为严格无损；JPEG 为该格式能给的最高质量（仍属有损）；
 * 视频与 GIF 恒为有损（视频为最高码率档，GIF 受 256 色调色板限制）。
 */

import {
  CAPTURE_QUALITIES,
  type CaptureQuality,
  type TierDescriptor,
} from "./contract";

export interface TierParams extends TierDescriptor {
  /** PNG 是否走调色板量化（lossless 档为全色无损）。 */
  pngPalette: boolean;
  /** PNG 调色板量化质量（1-100）。 */
  pngPaletteQuality: number;
  /** VP9 CRF（越小质量越高）。 */
  vp9Crf: number;
}

const TIERS: Record<CaptureQuality, TierParams> = {
  lossless: {
    quality: "lossless",
    stillStrictlyLossless: true,
    stillQuality: null,
    videoBitsPerPixel: 0.2,
    gifMaxFps: 20,
    gifColors: 256,
    pngPalette: false,
    pngPaletteQuality: 100,
    vp9Crf: 15,
  },
  high: {
    quality: "high",
    stillStrictlyLossless: false,
    stillQuality: 95,
    videoBitsPerPixel: 0.1,
    gifMaxFps: 15,
    gifColors: 256,
    pngPalette: true,
    pngPaletteQuality: 95,
    vp9Crf: 24,
  },
  medium: {
    quality: "medium",
    stillStrictlyLossless: false,
    stillQuality: 85,
    videoBitsPerPixel: 0.06,
    gifMaxFps: 12,
    gifColors: 192,
    pngPalette: true,
    pngPaletteQuality: 80,
    vp9Crf: 30,
  },
  low: {
    quality: "low",
    stillStrictlyLossless: false,
    stillQuality: 70,
    videoBitsPerPixel: 0.035,
    gifMaxFps: 10,
    gifColors: 128,
    pngPalette: true,
    pngPaletteQuality: 60,
    vp9Crf: 37,
  },
};

export function isCaptureQuality(value: unknown): value is CaptureQuality {
  return (
    typeof value === "string" &&
    (CAPTURE_QUALITIES as readonly string[]).includes(value)
  );
}

export function getTierParams(quality: CaptureQuality): Readonly<TierParams> {
  return TIERS[quality];
}

/** 给调用方看的档位说明，不含内部编码参数。 */
export function describeTiers(): Record<CaptureQuality, TierDescriptor> {
  const out = {} as Record<CaptureQuality, TierDescriptor>;
  for (const quality of CAPTURE_QUALITIES) {
    const t = TIERS[quality];
    out[quality] = {
      quality: t.quality,
      stillStrictlyLossless: t.stillStrictlyLossless,
      stillQuality: t.stillQuality,
      videoBitsPerPixel: t.videoBitsPerPixel,
      gifMaxFps: t.gifMaxFps,
      gifColors: t.gifColors,
    };
  }
  return out;
}

/** 比 `quality` 更低的一档；已是最低档返回 null。 */
export function lowerQuality(quality: CaptureQuality): CaptureQuality | null {
  const i = CAPTURE_QUALITIES.indexOf(quality);
  return i >= 0 && i < CAPTURE_QUALITIES.length - 1
    ? CAPTURE_QUALITIES[i + 1]
    : null;
}
