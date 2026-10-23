import { app, desktopCapturer, shell, systemPreferences } from "electron";
import type { BrowserWindow } from "electron";
import path from "node:path";
import log from "electron-log";
import { readSetting, writeSetting } from "../db";
import {
  probeFullDiskAccess,
  isFullDiskAccessPromptDismissed,
} from "./fullDiskAccess";
import { checkMacNotificationPermission } from "./system/macNotificationPermission";
import { openMacPrivacySettings } from "./system/macPermissions";
import { APP_DISPLAY_NAME } from "@shared/constants";
import {
  PermissionRestartTracker,
  isDragAddPermissionKey,
  isPermissionKey,
  isPermissionGuideTarget,
  supportsPermissionGuide,
  type HelperPermissionAdapter,
  type PermissionGuideTarget,
  type PermissionKey,
  type PermissionProbe,
  type PermissionSnapshot,
} from "@shared/types/permissionOnboarding";

export const PERMISSION_ONBOARDING_SETTING = "nuwax.permissionOnboarding.v1";
let getWindow: (() => BrowserWindow | null) | undefined;
let helper: HelperPermissionAdapter | undefined;
const tracker = new PermissionRestartTracker();
let pending: Promise<PermissionSnapshot> | undefined;

export function setPermissionGuideWindowProvider(
  provider: () => BrowserWindow | null,
): void {
  getWindow = provider;
}
/** Registration alone neither starts CU nor requests permissions. */
export function registerHelperPermissionAdapter(
  adapter: HelperPermissionAdapter,
): () => void {
  helper = adapter;
  return () => {
    if (helper === adapter) helper = undefined;
  };
}
export function openPermissionGuide(
  target: PermissionGuideTarget = "overview",
): boolean {
  if (
    !supportsPermissionGuide(process.platform) ||
    !isPermissionGuideTarget(target)
  )
    return false;
  const win = getWindow?.();
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.webContents.send("permissions:guide", target);
  return true;
}
function appIdentity() {
  const exe = app.getPath("exe");
  return {
    appName: app.isPackaged ? APP_DISPLAY_NAME : path.basename(exe),
    appPath: exe.match(/^.*?\.app(?=\/|$)/)?.[0] ?? exe,
  };
}
async function safeProbe(
  read: () => PermissionProbe | Promise<PermissionProbe>,
): Promise<PermissionProbe> {
  try {
    const result = await read();
    return ["granted", "denied", "unknown"].includes(result)
      ? result
      : "unknown";
  } catch (error) {
    log.warn("[Permissions] detection unavailable", error);
    return "unknown";
  }
}
export function markPermissionOnboardingSeen(): boolean {
  writeSetting(PERMISSION_ONBOARDING_SETTING, true);
  return true;
}
export function getPermissionSnapshot(): Promise<PermissionSnapshot> {
  if (pending) return pending;
  pending = (async () => {
    const snapshot: PermissionSnapshot = {
      platform: process.platform,
      ...appIdentity(),
      seen:
        readSetting(PERMISSION_ONBOARDING_SETTING) === true ||
        isFullDiskAccessPromptDismissed() === true,
      helperAvailable: !!helper,
      helperAppAvailable: !!helper?.appPath?.(),
      helperEnabled: false,
      items: [],
    };
    if (process.platform !== "darwin") return snapshot;
    const entries: Array<
      [PermissionKey, () => PermissionProbe | Promise<PermissionProbe>]
    > = [
      [
        "screen_recording",
        () => {
          const status = systemPreferences.getMediaAccessStatus("screen");
          return status === "granted"
            ? "granted"
            : status === "unknown"
            ? "unknown"
            : "denied";
        },
      ],
      ["file_access", probeFullDiskAccess],
      ["notifications", checkMacNotificationPermission],
    ];
    const adapter = helper;
    if (adapter) {
      snapshot.helperEnabled = await Promise.resolve().then(() => adapter.enabled?.() ?? false).catch(() => false);
      const result = Promise.resolve().then(() => adapter.check());
      entries.push(
        [
          "helper_accessibility",
          () => result.then((value) => value.accessibility),
        ],
        [
          "helper_screen_recording",
          () => result.then((value) => value.screen_recording),
        ],
      );
    }
    snapshot.items = await Promise.all(
      entries.map(async ([key, read]) =>
        tracker.update(key, await safeProbe(read)),
      ),
    );
    return snapshot;
  })().finally(() => {
    pending = undefined;
  });
  return pending;
}
/** All callers must originate in a user click. Reads and navigation never invoke this. */
export async function openGuidedPermissionSettings(
  key: PermissionKey,
): Promise<boolean> {
  if (!isPermissionKey(key) || process.platform !== "darwin") return false;
  if (key === "helper_accessibility" || key === "helper_screen_recording") {
    if (!helper?.appPath?.() || !(await helper.enabled?.())) return false;
    return openMacPrivacySettings(key === "helper_accessibility" ? "accessibility" : "screen_recording");
  }
  // Screen Recording has no add-app button. This explicit row action must
  // register the host with TCC before opening the pane on a fresh install.
  if (key === "screen_recording" && systemPreferences.getMediaAccessStatus("screen") !== "granted") {
    await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } })
      .catch(error => log.warn("[Permissions] screen request failed", error));
  }
  // Combined helper requests belong to the explicit Computer Use enable flow.
  return openMacPrivacySettings(key);
}
export function showPermissionApp(): boolean {
  shell.showItemInFolder(appIdentity().appPath);
  return true;
}
export function restartForPermissions(): boolean {
  app.relaunch();
  app.quit();
  return true;
}
/**
 * Resolves the bundle a drag-add would drop, in the main process only — the
 * renderer never supplies paths. Helper rows drag the helper's own bundle;
 * without a registered adapter/path there is nothing to drag yet.
 */
export function getPermissionDragIdentity(
  key: PermissionKey,
): { key: PermissionKey; appName: string; appPath: string } | null {
  if (process.platform !== "darwin" || !isDragAddPermissionKey(key))
    return null;
  if (key === "helper_accessibility" || key === "helper_screen_recording") {
    const appPath = helper?.appPath?.();
    return appPath
      ? { key, appName: "Nuwax Computer Use", appPath }
      : null;
  }
  return { key, ...appIdentity() };
}
let dragChipPromise: Promise<ReturnType<typeof import("./permissionDragChip").createPermissionDragChip>> | undefined;
let dragChipEpoch = 0;
let dragChipDisposed = false;
app.on("before-quit", () => {
  dragChipDisposed = true;
  dragChipEpoch++;
  void dragChipPromise?.then(chip => chip()).catch(() => undefined);
});
function ensureDragChip() {
  // Single-flight: concurrent shows must not construct the palette twice.
  dragChipPromise ??= (async () => {
    const [{ createPermissionDragChip }, { t }] = await Promise.all([
      import("./permissionDragChip"),
      import("./i18n"),
    ]);
    const chip = createPermissionDragChip({ t, getWindow: () => getWindow?.() ?? null });
    if (dragChipDisposed) chip();
    return chip;
  })();
  return dragChipPromise;
}
export async function showPermissionDragChip(key: unknown): Promise<boolean> {
  if (!isPermissionKey(key)) return false;
  if (dragChipDisposed) return false;
  const epoch = dragChipEpoch;
  const identity = getPermissionDragIdentity(key);
  if (!identity) return false;
  if (key.startsWith("helper_") && !(await helper?.enabled?.())) return false;
  if (dragChipDisposed || epoch !== dragChipEpoch) return false;
  const chip = await ensureDragChip();
  return !dragChipDisposed && epoch === dragChipEpoch ? chip.show(identity) : false;
}
export function hidePermissionDragChip(): boolean {
  dragChipEpoch++;
  // Never construct the palette just to hide it.
  if (!dragChipPromise) return true;
  void dragChipPromise.then((chip) => chip.hide()).catch(() => undefined);
  return true;
}
/** Only real OS denials qualify; a policy/path-boundary denial must remain a denial. */
export async function guideForFileAccessError(
  error: unknown,
  stillCurrent: () => boolean,
): Promise<void> {
  if (
    process.platform !== "darwin" ||
    !["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException)?.code ?? "")
  )
    return;
  const status = await getPermissionSnapshot();
  if (
    stillCurrent() &&
    status.items.some(
      (item) => item.key === "file_access" && item.probe === "denied",
    )
  ) {
    openPermissionGuide("file_access");
  }
}
