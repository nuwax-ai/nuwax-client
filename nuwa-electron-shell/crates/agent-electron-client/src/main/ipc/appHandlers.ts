import {
  ipcMain,
  app,
  dialog,
  shell,
  systemPreferences,
  BrowserWindow,
  desktopCapturer,
} from "electron";
import type { IpcMainInvokeEvent } from "electron";
import * as path from "path";
import { pathToFileURL } from "node:url";
import { createExternalOpenHandler } from "./openExternal";
import { DEFAULT_DEV_SERVER_PORT } from "../services/constants";
import * as fs from "fs";
import * as os from "os";
import { execSync } from "child_process";
import log from "electron-log";
import type { HandlerContext } from "@shared/types/ipc";
import type { UpdateCheckOptions } from "@shared/types/updateTypes";
import { LATEST_LOG_BASENAME } from "../bootstrap/logConfig";
import { readLogTail } from "../services/utils/logTail";
import {
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  getUpdateState,
  openReleasesPage,
} from "../services/autoUpdater";
import { getDeviceId } from "../services/system/deviceId";
import {
  openMacPrivacySettings,
  isMacPrivacyPane,
} from "../services/system/macPermissions";
import { getBundledDistVersion } from "../services/frontendDistVersion";
import { distHandshake } from "../services/distVersionHandshake";
import { createDistHandshakeReader } from "../services/distVersionHandshakeIPC";
import { loopbackGatewayStatus, resolveBackendOrigin } from "../services/loopbackGateway";
import { ticketEpoch } from "../services/commercialTicketSession";
import { getTrayManager } from "../window/trayManager";
import { createAutoLaunchManager, getAutoLaunchManager } from "../window/autoLaunchManager";
import { t } from "../services/i18n";
import { APP_DISPLAY_NAME, APP_NAME_IDENTIFIER, I18N_KEYS } from "@shared/constants";
import { checkMacNotificationPermission } from "../services/system/macNotificationPermission";
import { canUseUpdater as canUseUpdaterFrom, isHostRendererSender } from "./bridgeTrust";

function platformDisplayName(): string {
  switch (process.platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return os.type() || process.platform;
  }
}

/**
 * 打开日志目录（mac 在 Finder 中选中 latest 日志文件，win 资源管理器选中，
 * 其余直接开目录）。log:openDir IPC 与应用菜单「帮助 → 打开日志目录」共用。
 */
export async function openLogDirectory(): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const currentPath = log.transports.file.getFile().path;
    const logDir = currentPath
      ? path.dirname(currentPath)
      : app.getPath("logs");
    const latestPath = path.join(logDir, LATEST_LOG_BASENAME);
    const fileToSelect = fs.existsSync(latestPath)
      ? latestPath
      : currentPath || path.join(logDir, "main.log");
    try {
      if (process.platform === "darwin") {
        execSync(`open -R "${fileToSelect}"`, { encoding: "utf-8" });
      } else if (process.platform === "win32") {
        const winPath = fileToSelect.replace(/\//g, "\\");
        execSync(`explorer /select,"${winPath}"`, { encoding: "utf-8" });
      } else {
        await shell.openPath(logDir);
      }
    } catch (_) {
      await shell.openPath(logDir);
    }
    return { success: true };
  } catch (error) {
    log.error("[IPC] log:openDir failed:", error);
    return { success: false, error: String(error) };
  }
}

export function registerAppHandlers(ctx: HandlerContext): void {
  const canUseUpdater = (event: IpcMainInvokeEvent): boolean =>
    canUseUpdaterFrom(
      event,
      ctx.getMainWindow()?.webContents,
      app.isPackaged,
      APP_NAME_IDENTIFIER,
    );
  // Autolaunch
  ipcMain.handle("autolaunch:get", async () => {
    try {
      const mgr = getAutoLaunchManager() ?? createAutoLaunchManager();
      return await mgr.isEnabled();
    } catch (error) {
      log.error("[IPC] autolaunch:get failed:", error);
      return false;
    }
  });

  ipcMain.handle("autolaunch:set", async (_, enabled: boolean) => {
    try {
      // 启动较早的 IPC 也复用管理器，避免备用路径重新写入隐藏 Dock 的旧策略。
      const mgr = getAutoLaunchManager() ?? createAutoLaunchManager();
      const success = await mgr.setEnabled(enabled);
      if (!success)
        return {
          success: false,
          error: t("Claw.Settings.messages.settingFailed"),
        };
      getTrayManager()?.refreshAutoLaunchState();
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send("autolaunch:changed", enabled);
        }
      }
      return { success: true };
    } catch (error) {
      log.error("[IPC] autolaunch:set failed:", error);
      return { success: false, error: String(error) };
    }
  });

  // Log handlers
  ipcMain.handle("log:getDir", () => {
    return log.transports.file.getFile().path
      ? path.dirname(log.transports.file.getFile().path)
      : app.getPath("logs");
  });

  ipcMain.handle(
    "log:write",
    async (
      _,
      level: "info" | "warn" | "error",
      message: string,
      ...args: unknown[]
    ) => {
      switch (level) {
        case "error":
          log.error(message, ...args);
          break;
        case "warn":
          log.warn(message, ...args);
          break;
        default:
          log.info(message, ...args);
      }
    },
  );

  ipcMain.handle("log:openDir", async () => {
    return openLogDirectory();
  });

  ipcMain.handle("log:list", async (_, count?: number, offset?: number) => {
    try {
      const currentPath = log.transports.file.getFile().path;
      const logDir = currentPath
        ? path.dirname(currentPath)
        : app.getPath("logs");
      const latestPath = path.join(logDir, LATEST_LOG_BASENAME);
      const logPath =
        (fs.existsSync(latestPath) ? latestPath : currentPath) || currentPath;
      if (!logPath || !fs.existsSync(logPath)) {
        return [];
      }
      const lines = await readLogTail(logPath, count, offset);
      return lines.map((line) => {
        const match = line.match(
          /^\[(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}\.\d{3})\]\s\[(\w+)\]\s(.*)$/,
        );
        if (match) {
          return {
            timestamp: match[1],
            level: match[2].toLowerCase(),
            message: match[3],
          };
        }
        return { timestamp: "", level: "info", message: line };
      });
    } catch (error) {
      log.error("[IPC] log:list failed:", error);
      return [];
    }
  });

  // App handlers
  ipcMain.handle("app:getVersion", () => {
    return app.getVersion();
  });

  // 系统信息（关于页「系统信息」明细行消费）
  ipcMain.handle("app:getSystemInfo", () => {
    const osVersion =
      typeof process.getSystemVersion === "function"
        ? process.getSystemVersion()
        : os.release();
    const bundledDist = getBundledDistVersion();
    return {
      clientVersion: app.getVersion(),
      platform: process.platform,
      platformName: platformDisplayName(),
      osVersion,
      arch: process.arch,
      bundledDist,
    };
  });

  const readDistHandshake = createDistHandshakeReader({
    handshake: distHandshake,
    backendOrigin: resolveBackendOrigin,
    sessionEpoch: ticketEpoch,
    gatewayStatus: loopbackGatewayStatus,
  });
  // This is shell-only IPC, not a new business-WebView capability.
  ipcMain.handle(
    "app:getDistHandshake",
    (event, force?: boolean) => {
      if (!isHostRendererSender(event, ctx.getMainWindow()?.webContents, app.isPackaged)) {
        throw new Error("Host renderer required");
      }
      return readDistHandshake(force === true);
    },
  );

  // ---- webview（nuwax 前端）触达的宿主更新能力：与壳关于页共用同一 autoUpdater
  // 单例（download 不会双跑），桥前端见 preload/webviewPerfBridge.ts updater 命名空间 ----
  ipcMain.handle("updater:get-state", (event) => {
    if (!canUseUpdater(event)) return null;
    return { ...getUpdateState(), hostVersion: app.getVersion() };
  });

  ipcMain.handle("updater:check", async (event) => {
    if (!canUseUpdater(event))
      return { hasUpdate: false, error: "untrusted sender" };
    try {
      return await checkForUpdates();
    } catch (error) {
      log.error("[IPC] updater:check failed:", error);
      return { hasUpdate: false, error: String(error) };
    }
  });

  ipcMain.handle("updater:download", async (event) => {
    if (!canUseUpdater(event))
      return { success: false, error: "untrusted sender" };
    try {
      const result = await downloadUpdate();
      log.info(
        `[IPC] updater:download → success=${result.success}, error="${result.error}"`,
      );
      return result;
    } catch (error) {
      log.error("[IPC] updater:download failed:", error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle("updater:install", (event) => {
    if (!canUseUpdater(event))
      return { success: false, error: "untrusted sender" };
    try {
      return installUpdate();
    } catch (error) {
      log.error("[IPC] updater:install failed:", error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle("app:getDeviceId", () => {
    return getDeviceId();
  });

  // 本机电脑名（os.hostname，三平台），顶栏设备标识等消费；与商业注册上报的
  // computerName（commercialAuth.getComputerName 剥 .local）同源。
  ipcMain.handle("app:getHostname", () => {
    return os.hostname();
  });

  ipcMain.handle(
    "app:checkUpdate",
    async (_event, options?: UpdateCheckOptions) => {
      try {
        return await checkForUpdates({
          background: options?.background === true,
        });
      } catch (error) {
        log.error("[IPC] app:checkUpdate failed:", error);
        return { hasUpdate: false, error: String(error) };
      }
    },
  );

  ipcMain.handle("app:downloadUpdate", async () => {
    try {
      const result = await downloadUpdate();
      log.info(
        `[IPC] app:downloadUpdate → success=${result.success}, error="${result.error}"`,
      );
      return result;
    } catch (error) {
      log.error("[IPC] app:downloadUpdate failed:", error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle("app:installUpdate", () => {
    try {
      return installUpdate();
    } catch (error) {
      log.error("[IPC] app:installUpdate failed:", error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle("app:getUpdateState", () => {
    return getUpdateState();
  });

  ipcMain.handle("app:openReleasesPage", async () => {
    await openReleasesPage();
    return { success: true };
  });

  ipcMain.handle("app:getUpdateDebugInfo", async () => {
    try {
      const { getInstallerType, canAutoUpdate, getBackgroundCheckDebugInfo } =
        await import("../services/autoUpdater");
      const installerType = getInstallerType();
      const canUpdate = canAutoUpdate();
      const backgroundCheck = getBackgroundCheckDebugInfo();

      let appFiles: string[] = [];
      if (process.platform === "win32") {
        try {
          const appDir = path.dirname(app.getPath("exe"));
          appFiles = require("fs").readdirSync(appDir);
        } catch (e) {
          log.error("[IPC] Failed to read app directory for debug:", e);
        }
      }

      const uninstallers = appFiles.filter((f) => {
        const lower = f.toLowerCase();
        return lower.startsWith("uninstall") || lower.startsWith("unins");
      });

      return {
        success: true,
        platform: process.platform,
        arch: process.arch,
        isPackaged: app.isPackaged,
        appVersion: app.getVersion(),
        // 关于页展示产品名称；app.getName() 的 ASCII 值仍供更新程序定位卸载文件。
        appName: APP_DISPLAY_NAME,
        appPath: app.getAppPath(),
        exePath: app.getPath("exe"),
        installerType,
        canAutoUpdate: canUpdate,
        // 后台定时复检调度器（QA 验证：last/next 时间戳 + 实际生效间隔）
        backgroundCheck,
        appDir:
          process.platform === "win32"
            ? path.dirname(app.getPath("exe"))
            : null,
        uninstallerFiles: uninstallers,
        totalAppFiles: appFiles.length,
      };
    } catch (error) {
      log.error("[IPC] app:getUpdateDebugInfo failed:", error);
      return { success: false, error: String(error) };
    }
  });

  // Permissions (macOS)
  ipcMain.handle("permissions:check", async () => {
    if (process.platform !== "darwin") {
      return [];
    }
    try {
      const items = [
        {
          key: "accessibility",
          name: t("Claw.PermissionsPage.macosAccessibility"),
          description: t("Claw.PermissionsPage.macosAccessibilityDesc"),
          status: systemPreferences.isTrustedAccessibilityClient(false)
            ? "granted"
            : "denied",
        },
        {
          key: "screen_recording",
          name: t("Claw.PermissionsPage.macosScreenRecording"),
          description: t("Claw.PermissionsPage.macosScreenRecordingDesc"),
          status:
            systemPreferences.getMediaAccessStatus("screen") === "granted"
              ? "granted"
              : "denied",
        },
        {
          key: "file_access",
          name: t("Claw.PermissionsPage.macosFullDiskAccess"),
          description: t("Claw.PermissionsPage.macosFullDiskAccessDesc"),
          status: "unknown" as const,
        },
        {
          key: "notifications",
          name: t(I18N_KEYS.PermissionsPage.MACOS_NOTIFICATIONS),
          description: t(I18N_KEYS.PermissionsPage.MACOS_NOTIFICATIONS_DESC),
          status: await checkMacNotificationPermission(),
        },
      ];
      return items;
    } catch (error) {
      log.error("[IPC] permissions:check failed:", error);
      return [];
    }
  });

  ipcMain.handle(
    "permissions:openSettings",
    async (_, permissionKey: string) => {
      try {
        if (!isMacPrivacyPane(permissionKey)) {
          return { success: false, error: "Unknown permission" };
        }
        // macOS lists an app under Screen Recording only after it has requested capture once.
        if (
          permissionKey === "screen_recording" &&
          process.platform === "darwin" &&
          systemPreferences.getMediaAccessStatus("screen") !== "granted"
        ) {
          await desktopCapturer
            .getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } })
            .catch((error) => log.warn("[IPC] screen recording request failed:", error));
        }
        const ok = await openMacPrivacySettings(permissionKey);
        return ok
          ? { success: true }
          : { success: false, error: "Not macOS or failed to open" };
      } catch (error) {
        log.error("[IPC] permissions:openSettings failed:", error);
        return { success: false, error: String(error) };
      }
    },
  );

  // Shell
  const rendererEntry = app.isPackaged
    ? pathToFileURL(path.join(process.resourcesPath, "app.asar", "dist", "index.html")).href
    : `http://localhost:${DEFAULT_DEV_SERVER_PORT}/`;
  ipcMain.handle("shell:openExternal", createExternalOpenHandler(
    () => ctx.getMainWindow()?.webContents,
    rendererEntry,
    (url) => shell.openExternal(url),
  ));

  ipcMain.handle("shell:openPath", async (_, targetPath: string) => {
    try {
      if (!targetPath || typeof targetPath !== "string") {
        return { success: false, error: "Path is required" };
      }
      const openResult = await shell.openPath(targetPath);
      if (openResult) {
        return { success: false, error: openResult };
      }
      return { success: true };
    } catch (error) {
      log.error("[IPC] shell:openPath failed:", error);
      return { success: false, error: String(error) };
    }
  });

  // Dialog
  ipcMain.handle("dialog:openDirectory", async (_, title?: string) => {
    const mainWindow = ctx.getMainWindow();
    if (!mainWindow) return { success: false, error: "No window" };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: title || t("Claw.Settings.workspace.selectDir"),
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }
    return { success: true, path: result.filePaths[0] };
  });
}
