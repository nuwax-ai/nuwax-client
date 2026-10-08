/** 开机自启动：系统状态为展示依据，本地选择用于防止默认值覆盖用户关闭。 */
import { app } from "electron";
import log from "electron-log";
import { APP_DISPLAY_NAME } from "@shared/constants";
import { readSetting, writeSetting } from "../db";

const PREFERENCE_KEY = "nuwax.autoLaunch.enabled";

// Linux 使用 .desktop 自启动项，Windows/macOS 使用 Electron 原生 API。
let AutoLaunch: any = null;
try {
  AutoLaunch = require("auto-launch");
} catch (error) {
  log.warn("[AutoLaunch] auto-launch module not available:", error);
}

export interface AutoLaunchStatus {
  enabled: boolean;
  supported: boolean;
}

export class AutoLaunchManager {
  private supported = true;
  /** Windows 的读写参数必须一致才能匹配同一注册表项。 */
  private readonly loginItemArgs = ["--hidden"];

  isSupported(): boolean {
    return this.supported;
  }

  /** 数据库就绪后调用一次；开发运行不注册开发用 Electron。 */
  async initializeDefault(): Promise<void> {
    if (!app.isPackaged) return;
    try {
      if (typeof readSetting(PREFERENCE_KEY) === "boolean") return;
      // 已有自启动项只记下初始化结果，不重复修改系统设置。
      if (await this.readSystemEnabled()) {
        writeSetting(PREFERENCE_KEY, true);
        return;
      }
      await this.setEnabled(true);
    } catch (error) {
      // 读取失败不视为“关闭”，避免凭空覆盖系统设置。
      log.error("[AutoLaunchManager] Failed to initialize default:", error);
    }
  }

  private createLinuxLauncher() {
    if (!AutoLaunch) {
      this.supported = false;
      throw new Error("Auto-launch is not available");
    }
    return new AutoLaunch({
      name: APP_DISPLAY_NAME,
      // AppImage 挂载目录会随启动变化，应注册原始包路径。
      path: process.env.APPIMAGE || process.execPath,
      isHidden: true,
    });
  }

  private async readSystemEnabled(): Promise<boolean> {
    if (process.platform === "linux") {
      return this.createLinuxLauncher().isEnabled();
    }
    const settings = app.getLoginItemSettings({ args: this.loginItemArgs });
    // Windows 任务管理器禁用的注册表项不能显示成开启。
    return (
      settings.openAtLogin &&
      (process.platform !== "win32" ||
        settings.executableWillLaunchAtLogin !== false)
    );
  }

  async isEnabled(): Promise<boolean> {
    try {
      return await this.readSystemEnabled();
    } catch (error) {
      log.error("[AutoLaunchManager] Failed to check status:", error);
      return false;
    }
  }

  async setEnabled(enabled: boolean): Promise<boolean> {
    try {
      if (process.platform === "linux") {
        const launcher = this.createLinuxLauncher();
        if (enabled) await launcher.enable();
        else await launcher.disable();
      } else {
        app.setLoginItemSettings({
          openAtLogin: enabled,
          openAsHidden: true,
          args: this.loginItemArgs,
          ...(process.platform === "win32" ? { enabled } : {}),
        });
      }
      if ((await this.readSystemEnabled()) !== enabled) {
        log.warn(
          "[AutoLaunchManager] System did not apply auto-launch setting",
        );
        return false;
      }
      if (!writeSetting(PREFERENCE_KEY, enabled)) {
        log.error("[AutoLaunchManager] Failed to save auto-launch preference");
        return false;
      }
      log.info(
        `[AutoLaunchManager] Auto-launch ${enabled ? "enabled" : "disabled"}`,
      );
      return true;
    } catch (error) {
      log.error("[AutoLaunchManager] Failed to set auto-launch:", error);
      return false;
    }
  }

  async toggle(): Promise<boolean> {
    return this.setEnabled(!(await this.isEnabled()));
  }
}

let autoLaunchManager: AutoLaunchManager | null = null;

export function createAutoLaunchManager(): AutoLaunchManager {
  // 启动初始化、设置 IPC 与托盘复用同一实例。
  return (autoLaunchManager ??= new AutoLaunchManager());
}

export function getAutoLaunchManager(): AutoLaunchManager | null {
  return autoLaunchManager;
}
