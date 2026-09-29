/**
 * Webview / iframe 浏览器策略统一管理
 *
 * 集中处理：
 * 1. 权限请求（剪贴板、媒体、全屏等）
 * 2. window.open 弹窗（应用内打开，尺寸在页面请求基础上 ×2）
 * 3. 文件下载（导出等场景，支持进度条）
 */

import { app, session as electronSession, BrowserWindow, dialog } from "electron";
import type { HandlerDetails, BrowserWindowConstructorOptions, Session, WebContents, WebPreferences, WindowOpenHandlerResponse } from "electron";
import { randomUUID } from "crypto";
import * as path from "path";
import log from "electron-log";
import {
  APP_NAME_IDENTIFIER,
  WEBVIEW_POPUP_BASE_WIDTH,
  WEBVIEW_POPUP_BASE_HEIGHT,
  WEBVIEW_POPUP_MIN_WIDTH,
  WEBVIEW_POPUP_MIN_HEIGHT,
} from "@shared/constants";
import { businessBridgeOrigins } from "../auth/businessOrigins";
import { attachHostActivityBusinessWindow } from "../hostActivity";
import { isGuestNewTaskAvailable } from "../newTaskAvailability";
import { t } from "../i18n";
import { trustInitialBusinessNavigation } from "../sessionAuthInjection";

// ---------- 权限白名单 ----------

const ALLOWED_PERMISSIONS = new Set([
  "clipboard-read",
  "clipboard-sanitized-write",
  "media",
  "mediaKeySystem",
  "notifications",
  "fullscreen",
  "pointerLock",
  "openExternal",
]);
// 外部网站仍可使用普通复制/全屏；设备、通知、剪贴板读取等需留在业务会话。
const ALLOWED_ISOLATED_PERMISSIONS = new Set([
  "clipboard-sanitized-write",
  "fullscreen",
]);
const configuredPermissionSessions = new WeakSet<Session>();
const guardedBusinessContents = new WeakSet<WebContents>();
const trustedBusinessPopups = new Set<BrowserWindow>();
const configuredDownloadSessions = new WeakSet<Session>();
type PopupWindowState = {
  window: BrowserWindow;
  opener?: WebContents;
  hasDocument: boolean;
  downloads: number;
};
const popupWindows = new WeakMap<WebContents, PopupWindowState>();
let downloadMainWindow: () => BrowserWindow | null = () => null;

/** Close popups whose preload captured the previous business-origin allowlist. */
export function destroyTrustedBusinessPopups(): void {
  for (const win of [...trustedBusinessPopups]) {
    if (!win.isDestroyed()) win.destroy();
  }
  trustedBusinessPopups.clear();
}

// ---------- 权限 ----------

function configurePermissionHandlers(ses: Session, allowed: ReadonlySet<string>): void {
  if (configuredPermissionSessions.has(ses)) return;
  ses.setPermissionRequestHandler(
    (contents, permission, callback, details) => {
      const trusted = ses !== electronSession.defaultSession ||
        APP_NAME_IDENTIFIER !== "nuwax" ||
        isTrustedPermissionSource(contents, details?.requestingUrl);
      if (allowed.has(permission) && trusted) {
        callback(true);
      } else {
        log.warn(`[WebviewPolicy] Denied permission request: ${permission}`);
        callback(false);
      }
    },
  );

  ses.setPermissionCheckHandler(
    (contents, permission, requestingOrigin, details) => {
      if (!allowed.has(permission)) return false;
      if (ses !== electronSession.defaultSession || APP_NAME_IDENTIFIER !== "nuwax") return true;
      return isTrustedPermissionSource(contents, requestingOrigin) &&
        (!details?.requestingUrl || isTrustedBusinessUrl(details.requestingUrl)) &&
        (!details?.embeddingOrigin || isTrustedBusinessUrl(details.embeddingOrigin)) &&
        (!details?.securityOrigin || isTrustedBusinessUrl(details.securityOrigin));
    },
  );
  configuredPermissionSessions.add(ses);
}

function setupPermissions(): void {
  configurePermissionHandlers(electronSession.defaultSession, ALLOWED_PERMISSIONS);
}

/** 必须在创建外链窗口之前设置其独立会话权限；Electron 不从 defaultSession 继承。 */
export function configureIsolatedWebSession(partition: string): Session {
  if (!partition.startsWith("temp:nuwax-") || partition.startsWith("persist:"))
    throw new Error("Invalid isolated web partition");
  const ses = electronSession.fromPartition(partition);
  configurePermissionHandlers(ses, ALLOWED_ISOLATED_PERMISSIONS);
  configureDownloads(ses);
  ses.setSpellCheckerEnabled(false);
  return ses;
}

// ---------- 拼写检查 ----------

/**
 * 在 session 级别禁用拼写检查。
 *
 * BrowserWindow 的 webPreferences.spellcheck:false 只对该窗口自身的 webContents
 * 生效；而应用内打开网页用的是 <webview>，它是独立的 webContents、不会继承该设置，
 * 因此 Windows 上网页输入框仍会出现红色拼写波浪线。这里在 default session（所有
 * 未指定 partition 的 webview 与主窗口共用）上关闭拼写检查器，一次性覆盖全部。
 */
function setupSpellCheck(): void {
  electronSession.defaultSession.setSpellCheckerEnabled(false);
}

// ---------- window.open ----------

function parseHttpUrl(value: string | undefined): URL | null {
  try {
    const url = new URL(value || "");
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function isTrustedBusinessUrl(value: string | undefined): boolean {
  const parsed = parseHttpUrl(value);
  return !!parsed && !parsed.username && !parsed.password &&
    businessBridgeOrigins().includes(parsed.origin);
}

function isTrustedPermissionSource(contents: WebContents | null, frameUrl: string | undefined): boolean {
  return !!contents && !contents.isDestroyed() &&
    contents.session === electronSession.defaultSession &&
    isTrustedBusinessUrl(contents.getURL()) && isTrustedBusinessUrl(frameUrl);
}

/** noreferrer 不提供发起 frame；有任何外域或不明 origin 的 iframe 时不借用文件鉴权。 */
function hasOnlyBusinessFrames(contents: WebContents): boolean {
  try {
    const frames = contents.mainFrame.framesInSubtree;
    return frames.length > 0 && frames.every((frame) => isTrustedBusinessUrl(frame.origin));
  } catch {
    return false;
  }
}

/** Keep a non-business initial <webview src> out of the shared session before its first request. */
export function isolateUntrustedInitialWebview(
  webPreferences: WebPreferences,
  params: Record<string, string>,
): boolean {
  if (APP_NAME_IDENTIFIER !== "nuwax" || !params.src || isTrustedBusinessUrl(params.src))
    return false;
  const partition = `temp:nuwax-webview-${randomUUID()}`;
  configureIsolatedWebSession(partition);
  delete webPreferences.session;
  delete webPreferences.preload;
  webPreferences.partition = partition;
  params.partition = partition;
  return true;
}

/**
 * 解析 window.open 的 features 字符串（如 "width=500,height=300"）。
 */
function parseWindowFeatures(features: string): {
  width?: number;
  height?: number;
} {
  const result: { width?: number; height?: number } = {};
  if (!features) return result;

  for (const part of features.split(",")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim().toLowerCase();
    const value = parseInt(trimmed.slice(eq + 1).trim(), 10);
    if (Number.isNaN(value) || value <= 0) continue;

    if (key === "width") result.width = value;
    if (key === "height") result.height = value;
  }

  return result;
}

/**
 * 将页面请求的弹窗尺寸放大一倍；未指定时使用 Electron 常见默认 600×400 再 ×2。
 */
function resolveWebviewPopupSize(features: string): {
  width: number;
  height: number;
} {
  const parsed = parseWindowFeatures(features);
  const baseWidth = parsed.width ?? WEBVIEW_POPUP_BASE_WIDTH;
  const baseHeight = parsed.height ?? WEBVIEW_POPUP_BASE_HEIGHT;
  return { width: baseWidth * 2, height: baseHeight * 2 };
}

/** 应用内 http(s) 弹窗的 BrowserWindow 配置 */
function buildPopupWindowOptions(
  features: string,
  trustedBusiness: boolean,
  authenticatedDownload = false,
): BrowserWindowConstructorOptions {
  const { width, height } = resolveWebviewPopupSize(features);
  const webPreferences: NonNullable<BrowserWindowConstructorOptions["webPreferences"]> = {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false,
  };
  if (APP_NAME_IDENTIFIER === "nuwax") {
    if (trustedBusiness || authenticatedDownload) {
      webPreferences.session = electronSession.defaultSession;
      if (trustedBusiness) {
        webPreferences.preload = path.join(__dirname, "..", "preload", "webviewPerfBridge.js");
        webPreferences.additionalArguments = [
          `--nuwax-host-product=${APP_NAME_IDENTIFIER}`,
          `--nuwax-trusted-origins=${encodeURIComponent(JSON.stringify(businessBridgeOrigins()))}`,
        ];
      }
    } else {
      // 子窗口不继承默认业务 cookie；每次打开均用新的内存会话。
      webPreferences.partition = `temp:nuwax-popup-${randomUUID()}`;
      configureIsolatedWebSession(webPreferences.partition);
    }
  }
  return {
    width,
    height,
    minWidth: WEBVIEW_POPUP_MIN_WIDTH,
    minHeight: WEBVIEW_POPUP_MIN_HEIGHT,
    // 收银台等页面没有壳工具栏，必须由原生标题栏提供关闭入口；覆盖页面的 frame=no。
    frame: true,
    titleBarStyle: "default",
    titleBarOverlay: false,
    closable: true,
    webPreferences,
    show: APP_NAME_IDENTIFIER !== "nuwax",
    backgroundColor: "#ffffff",
  };
}

function registerTrustedPopup(win: BrowserWindow): void {
  if (APP_NAME_IDENTIFIER !== "nuwax" ||
      win.webContents.session !== electronSession.defaultSession ||
      trustedBusinessPopups.has(win)) return;
  trustedBusinessPopups.add(win);
  win.on("closed", () => trustedBusinessPopups.delete(win));
  attachHostActivityBusinessWindow(win);
}

/** 附件不提交页面；等待真实文档后显示，并只清理下载专用窗口。 */
function trackPopupWindow(win: BrowserWindow, opener?: WebContents): void {
  const contents = win.webContents;
  const state: PopupWindowState = { window: win, opener, hasDocument: false, downloads: 0 };
  popupWindows.set(contents, state);
  configureDownloads(contents.session);
  const destroy = () => { if (!win.isDestroyed()) win.destroy(); };
  let shown = false;
  // 主文档提交后即需保留；慢图片/iframe 可能让 did-finish-load 晚于下载完成。
  contents.on("did-navigate", (_event, url) => {
    if (parseHttpUrl(url)) state.hasDocument = true;
  });
  const showDocument = () => {
    if (shown || win.isDestroyed() || !parseHttpUrl(contents.getURL())) return;
    shown = true;
    win.show();
    win.focus();
  };
  contents.on("dom-ready", () => {
    if (state.hasDocument) showDocument();
  });
  contents.on("did-finish-load", () => {
    if (win.isDestroyed() || !parseHttpUrl(contents.getURL())) return;
    state.hasDocument = true;
    showDocument();
  });
  contents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
    if (!isMainFrame || state.hasDocument || state.downloads > 0) return;
    // 下载触发 ERR_ABORTED；已存在 DownloadItem 时由其终态负责清理。
    if (code !== -3) log.warn("[WebviewPolicy] Popup document failed", { code });
    destroy();
  });
  // createWindow 的原生 link 路径不会安装默认 opener 生命周期。
  opener?.once("destroyed", destroy);
  win.on("closed", () => {
    popupWindows.delete(contents);
    opener?.removeListener("destroyed", destroy);
  });
}

function loadPopupDocument(win: BrowserWindow, url: string, details?: HandlerDetails): void {
  const contents = win.webContents;
  const postBody = details?.postBody;
  const loading = details ? win.loadURL(url, {
    httpReferrer: details.referrer,
    ...(postBody && {
      postData: postBody.data,
      extraHeaders: `content-type: ${postBody.contentType}${
        postBody.boundary != null ? `; boundary=${postBody.boundary}` : ""
      }`,
    }),
  }) : win.loadURL(url);
  void loading.catch((error: { code?: string }) => {
    // loadURL 对下载与中止也会 reject，不能留下未处理的 Promise。
    const state = popupWindows.get(contents);
    if (!win.isDestroyed() && state && !state.hasDocument && state.downloads === 0) win.destroy();
    if (error.code !== "ERR_ABORTED")
      log.warn("[WebviewPolicy] Popup navigation failed", { code: error.code });
  });
}

function handleHttpPopupOpen(details: HandlerDetails, opener: WebContents): WindowOpenHandlerResponse {
  const { url, features } = details;
  const target = parseHttpUrl(url);
  if (!target) {
    return { action: "deny" };
  }

  const openerUrl = parseHttpUrl(opener.getURL());
  const referrerUrl = parseHttpUrl(details.referrer?.url);
  const allowed = APP_NAME_IDENTIFIER === "nuwax" ? businessBridgeOrigins() : [];
  const businessPair = APP_NAME_IDENTIFIER === "nuwax" &&
    opener.session === electronSession.defaultSession &&
    !!openerUrl &&
    !openerUrl.username && !openerUrl.password &&
    !target.username && !target.password &&
    allowed.includes(openerUrl.origin) && allowed.includes(target.origin);
  const trustedBusiness = businessPair && !!referrerUrl &&
    !referrerUrl.username && !referrerUrl.password &&
    openerUrl.origin === referrerUrl.origin &&
    allowed.includes(referrerUrl.origin);
  // IM 正文链接使用 noreferrer。只允许业务文件 GET 首请求鉴权，不授予页面 IPC 桥。
  const authenticatedDownload = businessPair && !details.referrer?.url &&
    !details.postBody && target.pathname.startsWith("/api/f/s3/") &&
    hasOnlyBusinessFrames(opener);
  const options = buildPopupWindowOptions(features ?? "", trustedBusiness, authenticatedDownload);
  log.debug(
    `[WebviewPolicy] Opening in-app popup: ${target.origin} (${options.width}x${options.height})`,
  );
  if (APP_NAME_IDENTIFIER !== "nuwax")
    return { action: "allow", overrideBrowserWindowOptions: options };
  if (!trustedBusiness && !authenticatedDownload && !details.referrer?.url) {
    // noreferrer 的 Chromium guest 已绑定 opener 会话，构造器不能改它的 Session。
    // 拒绝该 guest，显式创建没有继承业务 cookie/preload 的隔离窗口。
    const win = new BrowserWindow(options);
    trackPopupWindow(win, opener);
    loadPopupDocument(win, target.href, details);
    return { action: "deny" };
  }
  return {
    action: "allow",
    overrideBrowserWindowOptions: options,
    createWindow: (windowOptions) => {
      const win = new BrowserWindow(windowOptions);
      trackPopupWindow(win, opener);
      if (trustedBusiness || authenticatedDownload) {
        // 必须早于首个请求；自定义 createWindow 不会触发 did-create-window。
        trustInitialBusinessNavigation(win.webContents, target.href);
        registerTrustedPopup(win);
      }
      // 有 Chromium guest 时由它导航；普通链接路径需要显式加载。
      const guest = (windowOptions as BrowserWindowConstructorOptions & {
        webContents?: WebContents;
      }).webContents;
      if (!guest) loadPopupDocument(win, target.href, details);
      return win.webContents;
    },
  };
}

/** A business document must not carry its defaultSession into an external top-level page. */
function guardBusinessNavigation(contents: WebContents): void {
  if (APP_NAME_IDENTIFIER !== "nuwax" ||
      contents.session !== electronSession.defaultSession ||
      guardedBusinessContents.has(contents)) return;
  guardedBusinessContents.add(contents);

  const handleTarget = (event: Electron.Event, targetUrl: string, isMainFrame: boolean) => {
    if (!isMainFrame || isTrustedBusinessUrl(targetUrl)) return;
    event.preventDefault();
    const target = parseHttpUrl(targetUrl);
    if (!target) {
      log.warn(`[WebviewPolicy] Blocked non-HTTP top-level navigation: ${targetUrl}`);
      return;
    }
    try {
      const previous = popupWindows.get(contents);
      const win = new BrowserWindow(buildPopupWindowOptions("", false));
      trackPopupWindow(win, previous?.opener ?? contents);
      loadPopupDocument(win, target.href);
      // 首次下载重定向时，原业务弹窗也没有提交内容。
      if (previous && !previous.hasDocument && !previous.window.isDestroyed())
        previous.window.destroy();
      log.info(`[WebviewPolicy] Isolated external navigation: ${target.origin}`);
    } catch (error) {
      log.warn("[WebviewPolicy] Failed to open isolated external navigation", error);
    }
  };
  // will-frame-navigate covers _self / location changes, including named-frame
  // targeting the top frame. will-redirect covers server redirects from loadURL
  // and initial <webview src>, which do not emit will-frame-navigate.
  contents.on("will-frame-navigate", (event) =>
    handleTarget(event, event.url, event.isMainFrame));
  contents.on("will-redirect", (event) =>
    handleTarget(event, event.url, event.isMainFrame));
}

function setupWindowOpen(): void {
  app.on("web-contents-created", (_event, contents) => {
    // A guest can start loading its initial src before did-attach-webview.
    // Install the redirect guard at creation, then let attach be a fallback.
    if (contents.getType() === "webview") guardBusinessNavigation(contents);
    contents.on("did-create-window", (win) => registerTrustedPopup(win));
    // <webview> tag 内部的 window.open
    contents.on("did-attach-webview", (_event, webContents) => {
      guardBusinessNavigation(webContents);
      webContents.setWindowOpenHandler((details) =>
        handleHttpPopupOpen(details, webContents),
      );

      // Webview captures keyboard events — they don't bubble to the host page.
      // Intercept Ctrl/Cmd+Shift+I here to open webview DevTools.
      // Ctrl/Cmd+N: "new task" — reserved by real browsers (new window) so the
      // guest page never receives it there; the shell takes over and forwards
      // it as a host command (HostCommand "new-task", see nuwax nuwaClawHostEvents).
      webContents.on("before-input-event", (event, input) => {
        if (
          input.type === "keyDown" &&
          !input.shift &&
          !input.alt &&
          (input.control || input.meta) &&
          input.key.toLowerCase() === "n"
        ) {
          event.preventDefault();
          if (isGuestNewTaskAvailable(webContents)) {
            webContents.send("nuwax:host-command", { type: "new-task" });
          }
          return;
        }
        if (
          input.type === "keyDown" &&
          input.shift &&
          (input.control || input.meta) &&
          input.key.toLowerCase() === "i"
        ) {
          event.preventDefault();
          webContents.openDevTools();
        }
      });
    });

    // BrowserWindow 内部的 window.open（独立 webview 窗口等）
    if (contents.getType() === "window") {
      contents.setWindowOpenHandler((details) => handleHttpPopupOpen(details, contents));
      guardBusinessNavigation(contents);
    }
  });
}

// ---------- 独立页面离开确认 ----------

function setupPopupUnloadConfirmation(getMainWindow: () => BrowserWindow | null): void {
  // 同时覆盖 native.openWindow、window.open 和跨域导航创建的独立窗口。
  // beforeunload 不会自动弹出浏览器确认框；不处理会让收银台的关闭按钮无响应。
  app.on("browser-window-created", (_event, win) => {
    win.webContents.on("will-prevent-unload", (event) => {
      if (win.isDestroyed() || win === getMainWindow() ||
          !parseHttpUrl(win.webContents.getURL())) return;
      try {
        const choice = dialog.showMessageBoxSync(win, {
          type: "question",
          title: t("Claw.Webview.leaveTitle"),
          message: t("Claw.Webview.leaveMessage"),
          buttons: [t("Claw.Webview.leave"), t("Claw.Webview.stay")],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        // Electron 此事件的 preventDefault 是忽略页面拦截，允许离开。
        if (choice === 0) event.preventDefault();
      } catch (error) {
        log.warn("[WebviewPolicy] Failed to confirm page unload", error);
      }
    });
  });
}

// ---------- 文件下载 ----------

function configureDownloads(ses: Session): void {
  if (configuredDownloadSessions.has(ses)) return;
  configuredDownloadSessions.add(ses);
  ses.on("will-download", (_event, item, contents) => {
    const popup = contents ? popupWindows.get(contents) : undefined;
    if (popup) popup.downloads++;
    const filename = item.getFilename();
    log.info(
      `[WebviewPolicy] Download started: ${filename} (${item.getTotalBytes()} bytes)`,
    );

    item.on("updated", (_event, state) => {
      if (state === "progressing" && !item.isPaused()) {
        const received = item.getReceivedBytes();
        const total = item.getTotalBytes();
        if (total > 0) {
          downloadMainWindow()?.setProgressBar(received / total);
        }
      }
    });

    item.once("done", (_event, state) => {
      downloadMainWindow()?.setProgressBar(-1);
      if (popup) {
        popup.downloads--;
        if (!popup.hasDocument && popup.downloads === 0 && !popup.window.isDestroyed())
          popup.window.destroy();
      }
      if (state === "completed") {
        log.info(
          `[WebviewPolicy] Download completed: ${filename} → ${item.getSavePath()}`,
        );
      } else {
        log.warn(`[WebviewPolicy] Download failed: ${filename} (${state})`);
      }
    });
  });
}

// ---------- 统一入口 ----------

/**
 * 初始化 webview / iframe 浏览器策略。
 * 须在 createWindow() 之前调用，确保主窗口 webContents 能注册 did-attach-webview 监听。
 */
export function initWebviewPolicy(
  getMainWindow: () => BrowserWindow | null,
): void {
  downloadMainWindow = getMainWindow;
  setupPermissions();
  setupSpellCheck();
  setupWindowOpen();
  if (APP_NAME_IDENTIFIER === "nuwax") setupPopupUnloadConfirmation(getMainWindow);
  configureDownloads(electronSession.defaultSession);
  log.info(
    "[WebviewPolicy] Initialized (permissions, spellcheck off, window.open, downloads)",
  );
}
