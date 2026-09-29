/**
 * 托盘管理器 - Electron 客户端
 *
 * 功能：
 * - 统一托盘图标（32x32.png，所有状态共用；状态通过 tooltip 区分）
 * - 服务管理菜单（重启/停止服务）
 * - 开机自启动
 * - IPC 状态同步
 */

import { Tray, Menu, nativeImage, app, dialog, BrowserWindow } from "electron";
import * as path from "path";
import log from "electron-log";
import { APP_DISPLAY_NAME, I18N_KEYS } from "@shared/constants";
import {
  createAutoLaunchManager,
  AutoLaunchManager,
} from "./autoLaunchManager";
import { t } from "../services/i18n";
import { createIMBadgePng, formatIMBadgeCount, normalizeIMUnreadCount, paintWindowsTrayBadgeBitmap } from "../services/imBadgeImage";

// ==================== Types ====================

export type TrayStatus = "running" | "stopped" | "error" | "starting";

export interface TrayManagerOptions {
  platform?: NodeJS.Platform;
  onShowWindow: () => void;
  onRestartServices: () => Promise<void>;
  onStopServices: () => Promise<void>;
}

// ==================== Constants ====================

/**
 * 托盘图标文件名（所有状态共用同一图标，状态由 tooltip 区分）
 *
 * macOS: trayTemplate.png / trayTemplate@2x.png — 22x22 / 44x44 黑色剪影，
 *        Electron 根据 "Template" 后缀自动设为 template image（随系统明暗主题变色）。
 * Windows / Linux: tray.png — 32x32 彩色图标。
 */
const TRAY_ICON_MAC = "trayTemplate.png";
const TRAY_ICON_MAC_RETINA = "trayTemplate@2x.png";
const TRAY_ICON_DEFAULT = "tray.png";
/** 即使托盘尚未创建/被暂时关闭，也只保留最后成功未读数。 */
let latestUnreadCount = 0;

// ==================== Tray Manager ====================

export class TrayManager {
  private tray: Tray | null = null;
  private status: TrayStatus = "stopped";
  private servicesRunning: boolean = false;
  private autoLaunchEnabled: boolean = false;
  private autoLaunchManager: AutoLaunchManager;
  private options: TrayManagerOptions;
  private platform: NodeJS.Platform;
  private unreadCount = latestUnreadCount;
  private baseIcon: Electron.NativeImage | null = null;
  private badgeIcon: Electron.NativeImage | null = null;
  private badgeLabel = "";

  constructor(options: TrayManagerOptions) {
    this.options = options;
    this.platform = options.platform ?? process.platform;
    this.autoLaunchManager = createAutoLaunchManager();
  }

  /**
   * 创建托盘
   */
  async create(): Promise<void> {
    // 重复初始化不创建第二份原生托盘；关闭后再创建会补回缓存数值。
    if (this.tray) return;
    const icon = this.createTrayIcon("stopped");
    this.baseIcon = icon;

    this.tray = new Tray(icon);
    this.tray.setToolTip(APP_DISPLAY_NAME);
    this.updateIcon();

    // 左键点击显示窗口
    this.tray.on("click", () => {
      this.options.onShowWindow();
    });

    // 双击也显示窗口
    this.tray.on("double-click", () => {
      this.options.onShowWindow();
    });

    // 检查自启动状态
    this.autoLaunchEnabled = await this.autoLaunchManager.isEnabled();

    // 构建初始菜单
    this.updateMenu();
    log.info("[Tray] Tray created");
  }

  /**
   * 更新服务状态
   */
  updateServicesStatus(running: boolean): void {
    this.servicesRunning = running;
    this.status = running ? "running" : "stopped";
    this.updateIcon();
    this.updateMenu();
  }

  /**
   * 设置状态（用于错误状态）
   */
  setStatus(status: TrayStatus): void {
    this.status = status;
    this.updateIcon();
    this.updateMenu();
  }

  /** 系统托盘角标仅按最后成功总数刷新，聚焦不会清除计数。 */
  setUnreadCount(count: number): void {
    const normalized = normalizeIMUnreadCount(count);
    latestUnreadCount = normalized;
    if (normalized === this.unreadCount) return;
    this.unreadCount = normalized;
    this.updateIcon();
  }

  /**
   * 刷新自启动缓存状态（当外部修改了自启动设置时调用）
   */
  async refreshAutoLaunchState(): Promise<void> {
    this.autoLaunchEnabled = await this.autoLaunchManager.isEnabled();
    this.updateMenu();
  }

  /**
   * 更新托盘图标
   */
  private updateIcon(): void {
    if (!this.tray) return;

    const label = formatIMBadgeCount(this.unreadCount);
    const original = this.baseIcon ??= this.createTrayIcon(this.status);
    if (this.platform === "darwin") {
      // 原 template 图标继续跟随系统主题，数量显示在菜单栏图标右侧。
      this.tray.setImage(original);
      this.tray.setTitle(label, { fontType: "monospacedDigit" });
    } else {
      if (label && (label !== this.badgeLabel || !this.badgeIcon)) {
        this.badgeLabel = label;
        if (this.platform === "win32") {
          try {
            const normal = nativeImage.createFromBitmap(
              paintWindowsTrayBadgeBitmap(original.toBitmap(), this.unreadCount, 1),
              { width: 16, height: 16 },
            );
            const retina = nativeImage.createFromBitmap(
              paintWindowsTrayBadgeBitmap(original.toBitmap({ scaleFactor: 2 }), this.unreadCount, 2),
              { width: 32, height: 32 },
            );
            normal.addRepresentation({ scaleFactor: 2, dataURL: retina.toDataURL() });
            this.badgeIcon = normal;
          } catch (error) {
            log.error("[Tray] Failed to draw Windows unread badge:", error);
            this.badgeIcon = original;
          }
        } else {
          this.badgeIcon = nativeImage.createFromBuffer(createIMBadgePng(this.unreadCount));
        }
      }
      this.tray.setImage(label ? this.badgeIcon! : original);
    }

    const statusKey: Record<TrayStatus, string> = {
      running: "Claw.Tray.Status.running",
      stopped: "Claw.Tray.Status.stopped",
      error: "Claw.Tray.Status.error",
      starting: "Claw.Tray.Status.starting",
    };
    const unread = label ? ` - ${t(I18N_KEYS.IM.UNREAD_MESSAGES, String(this.unreadCount))}` : "";
    this.tray.setToolTip(`${APP_DISPLAY_NAME} - ${t(statusKey[this.status])}${unread}`);
  }

  /**
   * 更新托盘菜单
   */
  private updateMenu(): void {
    if (!this.tray) return;

    const contextMenu = Menu.buildFromTemplate([
      {
        label: t("Claw.Tray.showWindow"),
        click: () => this.options.onShowWindow(),
      },
      { type: "separator" },
      {
        label: t("Claw.Tray.restartServices"),
        click: async () => {
          log.info("[Tray] Restarting services...");
          try {
            await this.options.onRestartServices();
          } catch (e) {
            log.error("[Tray] Restart services failed:", e);
          }
        },
      },
      {
        label: t("Claw.Tray.stopServices"),
        enabled: this.servicesRunning,
        click: async () => {
          log.info("[Tray] Stopping services...");
          try {
            await this.options.onStopServices();
          } catch (e) {
            log.error("[Tray] Stop services failed:", e);
          }
        },
      },
      { type: "separator" },
      {
        label: t("Claw.Tray.autoLaunch"),
        type: "checkbox",
        checked: this.autoLaunchEnabled,
        click: async () => {
          const newEnabled = !this.autoLaunchEnabled;
          const success = await this.autoLaunchManager.setEnabled(newEnabled);
          if (success) {
            this.autoLaunchEnabled = newEnabled;
            this.updateMenu();
            // 通知渲染进程同步状态
            for (const win of BrowserWindow.getAllWindows()) {
              if (!win.isDestroyed()) {
                win.webContents.send("autolaunch:changed", newEnabled);
              }
            }
          } else {
            dialog.showErrorBox(
              t("Claw.Dialog.error"),
              t("Claw.Dialog.autoLaunchFailed"),
            );
          }
        },
      },
      {
        label: t("Claw.Tray.checkUpdate"),
        click: async () => {
          const { showUpdateDialogFlow } = require("../services/autoUpdater");
          await showUpdateDialogFlow();
        },
      },
      { type: "separator" },
      {
        label: t("Claw.Tray.about", APP_DISPLAY_NAME, app.getVersion()),
        enabled: false,
      },
      {
        label: t("Claw.Tray.quit"),
        click: () => app.quit(),
      },
    ]);

    this.tray.setContextMenu(contextMenu);
  }

  /**
   * 获取托盘图标路径
   * 开发模式：使用 __dirname 相对路径，避免 process.cwd() 在 monorepo 或从其他目录启动时指向错误目录导致图标加载失败、托盘不显示。
   * 编译后 main 在 dist/main/，window 在 dist/main/window/，故 ../../../ 为包根目录。
   */
  private getIconPath(fileName: string): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, "tray", fileName);
    }
    const devPath = path.join(
      __dirname,
      "..",
      "..",
      "..",
      "public",
      "tray",
      fileName,
    );
    return devPath;
  }

  /**
   * 创建托盘图标
   *
   * macOS 开发模式：从终端运行时 template 图标常不显示，故一律使用彩色图标 tray.png，
   *        并缩放到 22x22 以符合菜单栏尺寸，保证托盘可见。
   * macOS 打包后：使用 trayTemplate / trayTemplate@2x + setTemplateImage(true)。
   * Windows / Linux: 使用彩色图标，优先高清版，并缩放到合适尺寸。
   */
  private createTrayIcon(_status: TrayStatus): Electron.NativeImage {
    if (this.platform === "darwin") {
      const isDev = !app.isPackaged;

      if (isDev) {
        // 开发模式：始终用彩色图标，避免 template 在菜单栏不显示
        const path22 = this.getIconPath(TRAY_ICON_DEFAULT);
        const path44 = this.getIconPath("tray@2x.png");
        let icon = nativeImage.createFromPath(path44);
        if (icon.isEmpty()) icon = nativeImage.createFromPath(path22);
        if (!icon.isEmpty()) {
          const size = icon.getSize();
          if (size.width > 22 || size.height > 22) {
            icon = icon.resize({ width: 22, height: 22 });
          }
          log.info(
            "[Tray] macOS dev: using non-template icon (menu bar visibility):",
            icon.getSize().width > 22 ? path44 : path22,
          );
          return icon;
        }
        // 最后兜底：生成 22x22 占位图，确保 Tray 收到非空图
        icon = this.createPlaceholderTrayImage(22);
        log.warn(
          "[Tray] macOS dev: tray icon files not found, using placeholder",
        );
        return icon;
      }

      // 打包后：template 图标
      const retinaPath = this.getIconPath(TRAY_ICON_MAC_RETINA);
      const normalPath = this.getIconPath(TRAY_ICON_MAC);
      let icon = nativeImage.createFromPath(retinaPath);
      if (icon.isEmpty()) {
        log.warn(
          "[Tray] Retina template icon not found, trying @1x:",
          normalPath,
        );
        icon = nativeImage.createFromPath(normalPath);
      }
      if (icon.isEmpty()) {
        log.error("[Tray] macOS tray icon not found. Paths tried:", {
          retinaPath,
          normalPath,
        });
        return this.createPlaceholderTrayImage(22);
      }
      log.info(
        "[Tray] macOS tray icon loaded from:",
        icon.getSize().width ? retinaPath : normalPath,
      );
      icon.setTemplateImage(true);
      return icon;
    }

    // Windows / Linux: 彩色图标，参考 macOS 的处理方式
    const targetSize = this.platform === "win32" ? 16 : 22;
    const pathNormal = this.getIconPath(TRAY_ICON_DEFAULT);
    const pathRetina = this.getIconPath("tray@2x.png");

    // 优先使用高清图标
    let icon = nativeImage.createFromPath(pathRetina);
    if (icon.isEmpty()) {
      icon = nativeImage.createFromPath(pathNormal);
    }

    if (!icon.isEmpty()) {
      const size = icon.getSize();
      if (this.platform === "win32") {
        // 彩色资源四周有 1/8 透明留白；裁掉大部分留白后提供 16/32px 两档，
        // 让 Windows 在高 DPI 托盘中选到清晰且占比合适的图像。
        const inset = Math.round(Math.min(size.width, size.height) * 3 / 32);
        const cropped = icon.crop({
          x: inset,
          y: inset,
          width: size.width - inset * 2,
          height: size.height - inset * 2,
        });
        const retina = cropped.resize({ width: 32, height: 32 });
        icon = cropped.resize({ width: 16, height: 16 });
        icon.addRepresentation({ scaleFactor: 2, dataURL: retina.toDataURL() });
        log.info("[Tray] Windows tray icon loaded with 1x/2x representations");
        return icon;
      }
      // 如果图标尺寸过大，缩放到目标尺寸
      if (size.width > targetSize || size.height > targetSize) {
        icon = icon.resize({ width: targetSize, height: targetSize });
      }
      log.info(
        `[Tray] ${this.platform} tray icon loaded, size:`,
        icon.getSize(),
      );
      return icon;
    }

    // 兜底：生成占位图
    log.error("[Tray] Tray icon not found. Paths tried:", {
      pathNormal,
      pathRetina,
    });
    return this.createPlaceholderTrayImage(targetSize);
  }

  /** 生成灰色占位图（1x1 PNG 放大），用于图标缺失时保证 Tray 收到非空图 */
  private createPlaceholderTrayImage(size: number): Electron.NativeImage {
    const s = Math.max(16, Math.min(22, size));
    const dataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const img = nativeImage.createFromDataURL(dataUrl);
    return img.isEmpty() ? img : img.resize({ width: s, height: s });
  }

  /**
   * 销毁托盘
   */
  destroy(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
    this.baseIcon = null;
    this.badgeIcon = null;
    this.badgeLabel = "";
  }

  /**
   * 获取托盘实例
   */
  getTray(): Tray | null {
    return this.tray;
  }

  /**
   * 刷新托盘菜单和图标（用于语言切换等场景）
   */
  refresh(): void {
    this.updateIcon();
    this.updateMenu();
  }
}

// ==================== Singleton ====================

let trayManager: TrayManager | null = null;

export function createTrayManager(options: TrayManagerOptions): TrayManager {
  if (trayManager) {
    trayManager.destroy();
  }
  trayManager = new TrayManager(options);
  return trayManager;
}

export function getTrayManager(): TrayManager | null {
  return trayManager;
}

/** 壳接收器可以先于托盘运行；创建/替换实例时立即重放这一个数值。 */
export function setTrayUnreadCount(count: number): void {
  latestUnreadCount = normalizeIMUnreadCount(count);
  getTrayManager()?.setUnreadCount(latestUnreadCount);
}
