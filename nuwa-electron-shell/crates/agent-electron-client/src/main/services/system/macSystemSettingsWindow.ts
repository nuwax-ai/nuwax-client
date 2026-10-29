import path from "node:path";
import { createRequire } from "node:module";
import log from "electron-log";

export interface WindowBounds { x: number; y: number; width: number; height: number }
type NativeReader = { systemSettingsWindow(): WindowBounds | null };
const loadNative = createRequire(__filename);
let reader: NativeReader | null | undefined;

/** Shares the signed permission-query addon; reads only System Settings geometry. */
export function readSystemSettingsWindow(): WindowBounds | null {
  if (process.platform !== "darwin") return null;
  try {
    if (reader === undefined) reader = loadNative(path.join(__dirname, "mac-notification-permission.node")) as NativeReader;
    const bounds = reader?.systemSettingsWindow();
    if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) return null;
    return bounds;
  } catch (error) {
    if (reader !== null) log.warn("[Permissions] System Settings geometry unavailable", error);
    reader = null;
    return null;
  }
}

/** Matches the reference's lower-right placement, constrained to the target display. */
export function permissionChipPosition(anchor: WindowBounds, area: WindowBounds, size: { width: number; height: number }): { x: number; y: number } {
  const inset = 16;
  return {
    x: Math.round(Math.max(area.x, Math.min(anchor.x + anchor.width - size.width - inset, area.x + Math.max(0, area.width - size.width)))),
    y: Math.round(Math.max(area.y, Math.min(anchor.y + anchor.height - size.height - inset, area.y + Math.max(0, area.height - size.height)))),
  };
}
