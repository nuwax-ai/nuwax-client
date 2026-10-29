/**
 * 压缩档（main 侧入口）：档位表在 `@shared/features/capture/tiers`，这里再导出并补上
 * 只在 main 用到的 `maxBytes` 逐级下探。
 */

import type { CaptureQuality } from "@shared/features/capture/contract";
import { lowerQuality } from "@shared/features/capture/tiers";

export {
  describeTiers,
  getTierParams,
  isCaptureQuality,
  lowerQuality,
  type TierParams,
} from "@shared/features/capture/tiers";

export interface FitOutcome<T> {
  quality: CaptureQuality;
  value: T;
  bytes: number;
  /** 最低档仍超过 maxBytes。 */
  exceedsMaxBytes: boolean;
}

/**
 * 按 `maxBytes` 逐级下探：从 `start` 档开始编码，超限则换更低一档重编，
 * 直到达标或已是最低档。没有 `maxBytes` 时只编码一次。
 *
 * `encode` 必须只依赖档位、不改变像素尺寸；这里不碰分辨率。
 */
export async function fitToMaxBytes<T>(
  start: CaptureQuality,
  maxBytes: number | undefined,
  encode: (quality: CaptureQuality) => Promise<{ value: T; bytes: number }>,
): Promise<FitOutcome<T>> {
  let quality = start;
  for (;;) {
    const { value, bytes } = await encode(quality);
    const fits = maxBytes === undefined || bytes <= maxBytes;
    const next = lowerQuality(quality);
    if (fits || next === null) {
      return { quality, value, bytes, exceedsMaxBytes: !fits };
    }
    quality = next;
  }
}
