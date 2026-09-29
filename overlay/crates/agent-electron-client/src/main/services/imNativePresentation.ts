import { app, nativeImage, Notification, type BrowserWindow, type NativeImage, type NotificationConstructorOptions } from "electron";
import log from "electron-log";
import { I18N_KEYS } from "@shared/constants";
import { t } from "./i18n";
import { setTrayUnreadCount } from "../window/trayManager";
import { createIMBadgePng, formatIMBadgeCount, normalizeIMUnreadCount } from "./imBadgeImage";

export { createIMBadgePng, formatIMBadgeCount } from "./imBadgeImage";

export interface IMNativeMessage {
  sessionGeneration: number;
  msgId: string;
  convId: string;
  title: string;
  body: string;
}

export interface IMNativeNotification {
  on(event: "click" | "close" | "failed", listener: (details?: unknown) => void): unknown;
  removeAllListeners(): unknown;
  show(): void;
  close(): void;
}

export interface IMNativePresentationOptions {
  getMainWindow(): BrowserWindow | null;
  getBusinessWindows?(): readonly BrowserWindow[];
  isSessionCurrent(sessionGeneration: number): boolean;
  isNotificationAllowed?(): boolean;
  platform?: NodeJS.Platform;
  /** 测试可注入系统对象；生产始终使用 Electron 原生能力。 */
  notificationBackend?: {
    isSupported(): boolean;
    create(options: NotificationConstructorOptions): IMNativeNotification;
  };
  setDockBadge?(text: string): void;
  setTrayBadgeCount?(count: number): void;
  createOverlayImage?(png: Buffer): NativeImage;
  unreadDescription?(count: number): string;
}

export interface IMNativePresentation {
  setUnreadCount(count: number): void;
  showMessage(message: IMNativeMessage): boolean;
  clear(): void;
  dispose(): void;
}

const MAX_MESSAGE_KEYS = 2048;
const MAX_NATIVE_NOTIFICATIONS = 20;
export function createIMNativePresentation(options: IMNativePresentationOptions): IMNativePresentation {
  const platform = options.platform ?? process.platform;
  const backend = options.notificationBackend ?? {
    isSupported: () => Notification.isSupported(),
    create: (details: NotificationConstructorOptions) => new Notification(details),
  };
  const setDockBadge = options.setDockBadge ?? ((text: string) => {
    const dock = app.dock;
    if (!dock) return;
    dock.setBadge(text);
    log.debug("[IM] Dock unread badge updated", { requested: text, applied: dock.getBadge() });
  });
  const setTrayBadgeCount = options.setTrayBadgeCount ?? setTrayUnreadCount;
  const createOverlayImage = options.createOverlayImage ?? ((png: Buffer) => nativeImage.createFromBuffer(png));
  const unreadDescription = options.unreadDescription ?? ((count: number) => t(I18N_KEYS.IM.UNREAD_MESSAGES, String(count)));
  const seenMessageKeys = new Set<string>();
  const notifications = new Map<IMNativeNotification, (close?: boolean) => void>();
  let unreadCount = 0;
  let disposed = false;
  let epoch = 0;
  let mainWindow: BrowserWindow | null = null;
  let cachedLabel = "";
  let cachedImage: NativeImage | null = null;
  let lastAppliedWindow: BrowserWindow | null = null;
  let lastAppliedCount: number | null = null;
  let windowSync: ReturnType<typeof setImmediate> | null = null;

  function applyBadge(force = false): void {
    if (disposed) return;
    try { setTrayBadgeCount(unreadCount); } catch { log.warn("[IM] Failed to update tray unread badge"); }
    try {
      const label = formatIMBadgeCount(unreadCount);
      if (platform === "darwin") {
        if (force || lastAppliedCount !== unreadCount) setDockBadge(label);
      } else if (platform === "win32" && mainWindow && !mainWindow.isDestroyed()) {
        if (!force && lastAppliedWindow === mainWindow && lastAppliedCount === unreadCount) return;
        if (label && (cachedLabel !== label || !cachedImage)) {
          cachedLabel = label;
          cachedImage = createOverlayImage(createIMBadgePng(unreadCount, 1, "taskbar"));
        }
        mainWindow.setOverlayIcon(label ? cachedImage : null, label ? unreadDescription(unreadCount) : "");
      }
      lastAppliedWindow = mainWindow;
      lastAppliedCount = unreadCount;
    } catch {
      log.warn("[IM] Failed to update native unread badge");
    }
  }

  const onWindowRestored = (): void => applyBadge(true);
  const onWindowClosed = (): void => {
    detachWindow();
    lastAppliedWindow = null;
  };
  const onWindowCreated = (): void => {
    if (disposed || windowSync) return;
    // Electron 构造窗口时先发 created，等宿主保存新的主窗引用后再补角标。
    windowSync = setImmediate(() => {
      windowSync = null;
      syncWindow();
      applyBadge(true);
    });
    windowSync.unref();
  };

  function detachWindow(): void {
    mainWindow?.removeListener("restore", onWindowRestored);
    mainWindow?.removeListener("show", onWindowRestored);
    mainWindow?.removeListener("closed", onWindowClosed);
    mainWindow = null;
  }

  function syncWindow(): void {
    if (platform !== "win32") return;
    const current = options.getMainWindow();
    const next = current && !current.isDestroyed() ? current : null;
    if (next === mainWindow) return;
    detachWindow();
    mainWindow = next;
    mainWindow?.on("restore", onWindowRestored);
    mainWindow?.on("show", onWindowRestored);
    mainWindow?.on("closed", onWindowClosed);
  }

  function setUnreadCount(count: number): void {
    if (disposed) return;
    unreadCount = normalizeIMUnreadCount(count);
    syncWindow();
    applyBadge();
  }

  function sessionCurrent(generation: number): boolean {
    return !disposed && options.isSessionCurrent(generation);
  }

  function notificationAllowed(): boolean {
    return options.isNotificationAllowed?.() !== false;
  }

  function businessWindowFocused(): boolean {
    const main = options.getMainWindow();
    const windows = options.getBusinessWindows?.() ?? [];
    return [...windows, ...(main ? [main] : [])].some((win) => !win.isDestroyed() && win.isFocused());
  }

  function showMessage(message: IMNativeMessage): boolean {
    if (!Number.isSafeInteger(message.sessionGeneration) || message.sessionGeneration < 0
      || typeof message.msgId !== "string" || !message.msgId || message.msgId.length > 256
      || typeof message.convId !== "string" || !message.convId || message.convId.length > 256) return false;
    // 点击回调只留代次，避免把收到的完整消息内容留到通知关闭。
    const generation = message.sessionGeneration;
    try {
      if (!sessionCurrent(generation)) return false;
      const key = `${generation}:${message.msgId}`;
      if (seenMessageKeys.has(key)) return false;
      seenMessageKeys.add(key);
      if (seenMessageKeys.size > MAX_MESSAGE_KEYS) {
        seenMessageKeys.delete(seenMessageKeys.values().next().value!);
      }
      // 前台已经读到的消息不在随后失焦或恢复连接时重新弹出。
      if (!notificationAllowed() || businessWindowFocused() || !backend.isSupported()) return false;
      const currentEpoch = epoch;
      const notification = backend.create({
        title: String(message.title).slice(0, 128),
        body: String(message.body).slice(0, 256),
        silent: false,
      });
      const release = (close = false): void => {
        if (!notifications.delete(notification)) return;
        try { notification.removeAllListeners(); } catch { /* 已销毁的 OS 对象仍视为释放。 */ }
        if (close) {
          try { notification.close(); } catch { /* 平台清理失败不阻断账号边界。 */ }
        }
      };
      while (notifications.size >= MAX_NATIVE_NOTIFICATIONS) {
        // 只释放本地监听，不主动删除由 OS 通知中心管理的历史消息。
        notifications.values().next().value?.(false);
      }
      notifications.set(notification, (close = true) => release(close));
      notification.on("close", (details) => {
        const reason = details && typeof details === "object" ? (details as {reason?: unknown}).reason : undefined;
        // A timed-out Windows toast remains clickable in Action Center.
        if (platform === "win32" && reason === "timedOut") return;
        release();
      });
      notification.on("failed", () => {
        log.warn("[IM] Native notification failed");
        release(true);
      });
      notification.on("click", () => {
        const active = notifications.has(notification);
        release(true);
        if (!active || currentEpoch !== epoch) return;
        try {
          if (!sessionCurrent(generation)) return;
          const win = options.getMainWindow();
          if (win && !win.isDestroyed()) {
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
          }
        } catch {
          log.warn("[IM] Failed to restore notified application");
        }
      });
      try {
        notification.show();
        return true;
      } catch {
        release(true);
        log.warn("[IM] Failed to show native notification");
        return false;
      }
    } catch {
      log.warn("[IM] Native notification unavailable");
      return false;
    }
  }

  function clear(): void {
    epoch += 1;
    for (const close of [...notifications.values()]) close();
    seenMessageKeys.clear();
    cachedImage = null;
    cachedLabel = "";
    setUnreadCount(0);
  }

  function dispose(): void {
    if (disposed) return;
    clear();
    disposed = true;
    detachWindow();
    if (windowSync) clearImmediate(windowSync);
    windowSync = null;
    if (platform === "win32") app.removeListener?.("browser-window-created", onWindowCreated);
  }

  syncWindow();
  if (platform === "win32") app.on?.("browser-window-created", onWindowCreated);
  return { setUnreadCount, showMessage, clear, dispose };
}
