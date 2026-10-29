/**
 * 截屏特性的 Electron 适配层：权限、显示器、Phase 1 的「整屏抓取」引擎。
 *
 * 这里是唯一直接依赖 `electron` 的采集代码，保持很薄；业务逻辑都在可单测的模块里。
 * Phase 2 起交互式覆盖层引擎会替换 `createDisplayStillEngine`，对 `StillEngine` 接口无感。
 *
 * ★desktopCapturer 的 thumbnail 会按 `thumbnailSize` 缩放：这里按「DIP × scaleFactor」
 * 请求物理像素尺寸，得到整屏原分辨率画面。HDR 屏的色彩归一待 Phase 0 结论，目前
 * 如实报告 `hdrToneMapped: false`（没有做任何转换）。
 */

import { desktopCapturer, screen, systemPreferences } from "electron";
import type { CapturePermission } from "@shared/features/capture/contract";
import type { DisplayLike } from "./hdr";
import type { StillEngine } from "./captureService";

export function getScreenPermission(): CapturePermission {
  if (process.platform !== "darwin") return "n/a";
  const status = systemPreferences.getMediaAccessStatus("screen");
  if (status === "granted") return "granted";
  if (status === "denied" || status === "restricted") return "denied";
  return "not-determined";
}

export function getAllDisplays(): DisplayLike[] {
  return screen.getAllDisplays();
}

/** 抓取鼠标所在显示器的整屏画面（原分辨率）。 */
export function createDisplayStillEngine(): StillEngine {
  return {
    async captureStill(signal) {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const thumbnailSize = {
        width: Math.max(1, Math.round(display.size.width * display.scaleFactor)),
        height: Math.max(1, Math.round(display.size.height * display.scaleFactor)),
      };
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize,
      });
      if (signal.aborted) return null;
      const source =
        sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
      if (!source || source.thumbnail.isEmpty()) {
        throw new Error("screen capture returned an empty image");
      }
      return { image: source.thumbnail, hdrToneMapped: false };
    },
  };
}
