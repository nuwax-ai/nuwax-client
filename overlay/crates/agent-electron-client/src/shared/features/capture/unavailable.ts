/**
 * 「不可用」能力说明：特性关闭、调用方不受信、平台不支持时给调用方的统一形状。
 *
 * main 与 preload 共用，调用方只需判断 `available`。
 */

import { CAPTURE_API_VERSION, type CaptureCapabilities } from "./contract";
import { describeTiers } from "./tiers";

export function unavailableCapabilities(
  platform: NodeJS.Platform,
): CaptureCapabilities {
  return {
    apiVersion: CAPTURE_API_VERSION,
    available: false,
    platform,
    permission: "n/a",
    displays: [],
    formats: { still: [], video: [], gif: false },
    tiers: describeTiers(),
  };
}
