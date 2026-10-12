/**
 * 显示器 HDR / 广色域判定。
 *
 * ★判据是临时的：依据 Chromium `gfx::ColorSpace` 字符串里的传输函数/原色名做关键字匹配，
 * Electron 40 在各平台上 `display.colorSpace` 的真实取值待 Phase 0 真机核对后收紧。
 * 判定只用于（1）写入 `getCapabilities()`、（2）决定是否走 SDR 归一管线，
 * 不影响输出尺寸；误判为 HDR 的代价是多做一次保守的 sRGB 归一，不会丢画面。
 */

import type { CaptureDisplayInfo } from "@shared/features/capture/contract";

/** Electron `Display` 里本模块用到的字段子集（避免在纯逻辑里 import electron）。 */
export interface DisplayLike {
  id: number;
  scaleFactor: number;
  colorSpace?: string;
  depthPerComponent?: number;
}

const HDR_TRANSFER =
  /\b(PQ|HLG|SMPTEST2084|ARIB_STD_B67|SCRGB|LINEAR_HDR)\b/i;
const NON_SRGB_PRIMARIES = /primaries:\s*(?!BT709\b|SRGB\b)[A-Za-z0-9_]+/i;

export interface DisplayColorTraits {
  hdr: boolean;
  /** 原色不是 sRGB/BT.709（如 Display P3、BT.2020）。 */
  wideGamut: boolean;
}

export function classifyDisplayColor(display: DisplayLike): DisplayColorTraits {
  const cs = display.colorSpace ?? "";
  return {
    hdr: HDR_TRANSFER.test(cs),
    wideGamut: NON_SRGB_PRIMARIES.test(cs),
  };
}

export function summarizeDisplays(
  displays: readonly DisplayLike[],
): CaptureDisplayInfo[] {
  return displays.map((d) => ({
    id: String(d.id),
    hdr: classifyDisplayColor(d).hdr,
    scale: d.scaleFactor,
  }));
}

/** 任一块参与采集的屏是 HDR，则本次结果需要标记 `hdrToneMapped`。 */
export function anyHdr(displays: readonly DisplayLike[]): boolean {
  return displays.some((d) => classifyDisplayColor(d).hdr);
}
