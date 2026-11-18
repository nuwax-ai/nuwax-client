import type { WebContents, WebFrameMain } from "electron";
import log from "electron-log";

// PC Web emits a fixed-format diagnostic. Forward only these fields to disk.
const MICRO_APP_LOAD_LINE = /^\[MicroAppLoad\] app=(repo|im) attempt=[1-9]\d{0,8} event=(slow|ready|failed|auth-expired|auth-probe|first-api) phase=(previous-instance|session-sync|qiankun-import|entry-assets|bootstrap|mount|im-auth|repo-api) durationMs=\d{1,12} httpStatus=(0|[1-5]\d{2}) timeMs=\d{13}$/;

export function observeMicroAppLoadLogs(
  contents: WebContents,
  isTrustedFrame: (frame: WebFrameMain) => boolean,
): void {
  contents.on("console-message", ({ frame, level, message }) => {
    if (level !== "warning" && level !== "info") return;
    if (message.length > 192 || /[\r\n]/.test(message) || !MICRO_APP_LOAD_LINE.test(message)) return;
    if (contents.isDestroyed() || !frame || frame !== contents.mainFrame || !isTrustedFrame(frame)) return;
    const context = { webContentsId: contents.id };
    if (level === "warning") log.warn(message, context);
    else log.info(message, context);
  });
}
