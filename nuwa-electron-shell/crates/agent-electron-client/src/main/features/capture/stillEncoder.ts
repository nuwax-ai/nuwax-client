/**
 * 静态图编码（可插拔）。
 *
 * 当前实现基于 Electron `nativeImage`（零新增依赖）：PNG 严格无损；JPEG 由档位决定质量。
 * `nativeImage` 没有 PNG 调色板量化、也没有 WebP，因此：
 *   - `format: 'png'` 时所有档位都得到同一份无损 PNG，`qualityUsed` 如实报告 `lossless`，
 *     `maxBytes` 无法通过换档达标（如实返回 `exceedsMaxBytes`）；
 *   - `webp` 当前不支持（`supportedFormats()` 不含），待 ffmpeg 编码器（Phase 3）提供。
 *
 * 任何情况下都不缩放像素；`maxBytes` 只会让档位逐级下探。
 */

import type {
  CaptureCompression,
  CaptureQuality,
  StillFormat,
} from "@shared/features/capture/contract";
import { fitToMaxBytes, getTierParams } from "./tiers";

/** `Electron.NativeImage` 中本模块用到的子集。 */
export interface NativeImageLike {
  toPNG(): Buffer;
  toJPEG(quality: number): Buffer;
  getSize(): { width: number; height: number };
}

export interface StillEncoder {
  supportedFormats(): StillFormat[];
  /** 该格式下输出是否随档位变化；不随档位变化的格式无需逐级下探。 */
  isQualityDependent(format: StillFormat): boolean;
  encode(
    image: NativeImageLike,
    format: StillFormat,
    quality: CaptureQuality,
  ): Buffer;
}

export function createNativeImageEncoder(): StillEncoder {
  return {
    supportedFormats: () => ["png", "jpeg"],
    isQualityDependent: (format) => format === "jpeg",
    encode(image, format, quality) {
      if (format === "png") return image.toPNG();
      if (format === "jpeg") {
        // lossless 档对 JPEG 表示「该格式能给的最高质量」，仍属有损。
        return image.toJPEG(getTierParams(quality).stillQuality ?? 100);
      }
      throw new Error(`Unsupported still format: ${format}`);
    },
  };
}

export const MIME_BY_FORMAT: Record<StillFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** 未指定格式时：无损档用 PNG，有损档用 JPEG。 */
export function defaultStillFormat(quality: CaptureQuality): StillFormat {
  return quality === "lossless" ? "png" : "jpeg";
}

export interface EncodedStill {
  data: Buffer;
  mime: string;
  format: StillFormat;
  width: number;
  height: number;
  qualityUsed: CaptureQuality;
  exceedsMaxBytes: boolean;
}

export function encodeStill(
  image: NativeImageLike,
  options: { format?: StillFormat; compression?: CaptureCompression },
  encoder: StillEncoder,
): Promise<EncodedStill> {
  const requested = options.compression?.quality ?? "high";
  const format = options.format ?? defaultStillFormat(requested);
  const { width, height } = image.getSize();
  const maxBytes = options.compression?.maxBytes;

  if (!encoder.isQualityDependent(format)) {
    const data = encoder.encode(image, format, "lossless");
    return Promise.resolve({
      data,
      mime: MIME_BY_FORMAT[format],
      format,
      width,
      height,
      qualityUsed: "lossless",
      exceedsMaxBytes: maxBytes !== undefined && data.length > maxBytes,
    });
  }

  return fitToMaxBytes(requested, maxBytes, (quality) => {
    const data = encoder.encode(image, format, quality);
    return Promise.resolve({ value: data, bytes: data.length });
  }).then((fit) => ({
    data: fit.value,
    mime: MIME_BY_FORMAT[format],
    format,
    width,
    height,
    qualityUsed: fit.quality,
    exceedsMaxBytes: fit.exceedsMaxBytes,
  }));
}
