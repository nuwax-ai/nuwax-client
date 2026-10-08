import * as path from "node:path";
import { createRequire } from "node:module";
import log from "electron-log";

export type NotificationPermissionStatus = "granted" | "denied" | "unknown";
type NativeReader = { readSettings(): Promise<number> };

/** Apple UNAuthorizationStatus。新值/失败不能误报成已开启。 */
export function notificationPermissionStatus(status: number): NotificationPermissionStatus {
  if (status === 0 || status === 1) return "denied";
  if (status === 2 || status === 3) return "granted";
  return "unknown";
}

let reader: NativeReader | undefined;
let pending: Promise<NotificationPermissionStatus> | undefined;
const loadNative = createRequire(__filename);

/** 只合并正在进行的检测，不缓存结果，用户可以随时撤销系统通知授权。 */
export function checkMacNotificationPermission(): Promise<NotificationPermissionStatus> {
  if (process.platform !== "darwin") return Promise.resolve("unknown");
  if (pending) return pending;
  pending = Promise.resolve().then(async () => {
    try {
      reader ??= loadNative(path.join(__dirname, "mac-notification-permission.node")) as NativeReader;
      return notificationPermissionStatus(await reader.readSettings());
    } catch (error) {
      log.warn("[MacNotificationPermission] settings query failed:", error);
      return "unknown" as const;
    }
  }).finally(() => { pending = undefined; });
  return pending;
}
