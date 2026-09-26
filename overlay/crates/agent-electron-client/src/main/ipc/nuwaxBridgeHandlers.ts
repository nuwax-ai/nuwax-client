/**
 * nuwax webview ↔ nuwaclaw 壳的桥后端。
 *
 * - auth:beginLogin / auth:syncSession / auth:clear
 *     webview 只通知会话节点；ticket 由 Electron cookie jar 与网关响应处理，
 *     不经过页面脚本或 token 桥。主进程 AuthLifecycle 串行注册与服务启停。
 * - native:saveImage / native:saveFile
 *     图片与产物保存：系统保存对话框 + Node fetch。相对地址按调用方 frame origin 归一为
 *     绝对地址；当前业务域逐跳附 cookie，跨域重定向不携带。
 * - native:openWindow
 *     站内相对路径按二级页设置选择同窗或独立窗口；绝对 HTTP(S) 地址开独立窗口。
 *     受信业务域复用会话和桥，外链使用独立内存会话；独立业务窗口追加 _shell=1
 *     让 nuwax 解除沉浸式门控。
 * - native:openClientSettings
 *     打开壳的「客户端配置」设置弹窗（nuwax web 用户区「客户端设置」按钮入口，
 *     仅 nuwax 宿主渲染）。设置弹窗是壳 renderer 的 React state，主进程无法直接
 *     打开，转发 nuwax:open-client-settings 给壳 renderer（同 open-same-window）。
 * - nuwax:theme-sync
 *     nuwax 女娲主题状态推送（{ active, 调色板 }）→ 转发 nuwax:theme-changed 给壳
 *     renderer，壳给自己的 antd tokens / CSS 变量叠加同套米白调色板（原生 UI 统一）。
 * - nuwax:layout-sync
 *     nuwax 布局状态推送（{ secondMenuAvailable }）→ 转发 nuwax:layout-changed 给壳
 *     renderer，工具栏据此显隐「收起二级菜单」按钮（无二级菜单的页面按钮无意义）。
 *
 * 桥前端：preload/webviewPerfBridge.ts（商业版只注入当前受信业务页）。
 * 注册入口：ipc/index.ts 的 registerAllHandlers。
 */
import { ipcMain, dialog, BrowserWindow, webContents, app, screen, net, session } from "electron";
import type { IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import { APP_NAME_IDENTIFIER } from "@shared/constants";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { saveResponse } from "../services/system/saveResponse";
import log from "electron-log";
import type { HandlerContext } from "@shared/types/ipc";
import { readSetting, writeSetting, getDb } from "../db";
import { getMainLang, setMainLang } from "../services/i18n";
import { getTrayManager } from "../window/trayManager";
import { NUWAX_WEBVIEW_LANG_KEY, resolveShellLang } from "@shared/utils/shellLanguage";
import { stopAllServicesNow, restartAllServicesNow } from "./processHandlers";
import { sanitizeTitlebarDragRegions } from "@shared/utils/titlebarDragRegions";
import * as cuaComputerUse from "../services/cua/computerUse";
import * as powerPolicy from "../services/powerPolicy";
import * as fullDiskAccess from "../services/fullDiskAccess";
import * as contextMenuService from "../services/contextMenu";
import { initSessionAuthInjection, trustInitialBusinessNavigation } from "../services/sessionAuthInjection";
import { nativeTicketHeaders } from "../services/nativeTicketCapability";
import { matchesBusinessOrigin } from "../services/auth/requestPolicy";
import { getGatewayRequestContext } from "../services/loopbackGateway/requestContext";
import { configureIsolatedWebSession, destroyTrustedBusinessPopups } from "../services/system/webviewPolicy";
import { businessBridgeOrigins, httpOrigin } from "../services/auth/businessOrigins";
import { currentTicket, syncTicketFromJar, restoreTicketSession, invalidateTicketSession, clearTicketCookies,
  advanceTicketEpoch, mirrorNativeResponseTicket, ticketEpoch } from "../services/commercialTicketSession";

import {
  initializeCommercialAuth,
  currentBusinessOrigin,
  clearRegistration,
  registrationTraceCode,
  type RegistrationTrace,
} from "./commercialAuth";

/** 仅用于清除升级前残留的 token 键；不再读取或写入新 token。 */
export const NUWAX_TOKEN_KEY_PREFIX = "nuwax.accessToken.";

/** 从 IPC 调用方（webview guest）解析来源 origin。 */
function resolveSenderOrigin(event: IpcMainInvokeEvent | undefined): string {
  const url = event?.senderFrame?.url || event?.sender?.getURL?.() || "";
  return httpOrigin(url) ?? "global";
}

/** IPC 权限以调用时的 frame 和顶层文档为准，不能沿用导航前的 preload 身份。 */
function isTrustedBusinessSender(
  event: Electron.IpcMainEvent | IpcMainInvokeEvent,
  origins: readonly string[],
): boolean {
  const frame = httpOrigin(event.senderFrame?.url);
  const top = httpOrigin(event.sender?.getURL());
  return !!frame && !!top && origins.includes(frame) && origins.includes(top);
}

function tokenKey(scope: string): string {
  return `${NUWAX_TOKEN_KEY_PREFIX}${scope}`;
}

/**
 * 清壳侧登录态键（登录态以 webview 为准，登出即清）：定点键置 null（=
 * writeSetting 语义里的删除），域名级 savedKey 前缀键经 SQL 批删。
 * 注册凭据族（auth.saved_key/config_key/username）不在此清——它们是
 * 「设备×账号」维度的注册凭据，归 clearRegistration({preserveSavedKey})
 * 统一管理（后端 reg 必须携带 savedKey，见该函数注释）。
 */
function clearShellAuthState(): void {
  const directKeys = [
    "auth.user_info",
    "auth.online_status",
    "auth.token",
    "auth.password",
  ];
  for (const key of directKeys) writeSetting(key, null);
  const db = getDb();
  if (db) {
    const info = db
      .prepare("DELETE FROM settings WHERE key LIKE 'auth.saved_keys.%'")
      .run();
    log.info("[NuwaxBridge] cleared auth.saved_keys.* rows:", info.changes);
  }
}

/** 登出与换域时清理当前业务域、网关及调用方会话。 */
function nuwaxSessionScopes(senderScope: string): string[] {
  const scopes = [senderScope];
  try {
    // 业务域始终参与清理；缺省域也可能已有旧客户端凭据。
    scopes.push(currentBusinessOrigin());
    const loopback = readSetting("nuwax.loopback") as {
      enabled?: boolean;
      origin?: string | null;
    } | null;
    if (loopback?.enabled && loopback.origin) scopes.push(loopback.origin);
  } catch {
    /* 配置异常时退化为仅 sender */
  }
  return [...new Set(scopes)];
}

/** 桌面独立窗口注册表：持引用防 GC，closed 时清理。 */
const shellWindows = new Set<BrowserWindow>();
const businessShellWindows = new Set<BrowserWindow>();

/**
 * 商业版窗口最小尺寸（plans/20260921-min-window-resolution.md）：
 * - 宽 1200 对齐 nuwax 前端多栏 html 地板（global.less / Chat 普通态），单栏下
 *   主区不内部横滚；innerWidth 是 CSS 像素，150% 网页缩放下仍有 1200/1.5=800
 *   > 768 移动端断点（nuwax MOBILE_BREAKPOINT=768 纯视口判定、无宿主豁免），
 *   不会整页误切移动端布局；
 * - 高 720 保顶栏避让 + 消息区 + 输入框可用。基座 DEFAULT_WINDOW_MIN_*（800×600，
 *   社区版在用）不动，商业下限在此覆设。
 */
export const NUWAX_MAIN_WINDOW_MIN_WIDTH = 1200;
export const NUWAX_MAIN_WINDOW_MIN_HEIGHT = 720;

/**
 * 商业下限统一补设到新建窗口（主窗口含 mac activate 重建、webview window.open
 * 弹窗、session 独立窗口均一并抬升——Electron 40 已移除 getLastWebPreferences，
 * 事件期读不到 webPreferences 无法按窗口分类，且弹窗承载同一前端同受 768 断点
 * 约束；session 窗基座 600×400 下限被有意覆盖，同屏一致性优先）。
 */
export function applyMainWindowMinSize(win: BrowserWindow): void {
  try {
    if (win.isDestroyed()) return;
    win.setMinimumSize(
      NUWAX_MAIN_WINDOW_MIN_WIDTH,
      NUWAX_MAIN_WINDOW_MIN_HEIGHT,
    );
  } catch {
    // 非关键链路：窗口边缘态（webContents 已销毁等）忽略
  }
}

export function registerNuwaxBridgeHandlers(ctx: HandlerContext): void {
  // 主进程身份随进程固定；guest preload 可能在 dev 期间被另一次构建覆盖。
  // 在 webview 创建前传入运行时身份，避免 preload 的静态构建值让前端误判
  // 商业沉浸壳（logo / 菜单退让、折叠入口等随之失效）。
  const hostProductArg = `--nuwax-host-product=${APP_NAME_IDENTIFIER}`;
  const attachHostProduct = (contents: Electron.WebContents) => {
    contents.on("will-attach-webview", (_event, preferences) => {
      preferences.additionalArguments = [
        ...(preferences.additionalArguments ?? []).filter(
          (arg) => !arg.startsWith("--nuwax-host-product=") &&
            !arg.startsWith("--nuwax-trusted-origins="),
        ),
        hostProductArg,
        `--nuwax-trusted-origins=${encodeURIComponent(JSON.stringify(trustedOrigins()))}`,
      ];
    });
  };
  app.on("web-contents-created", (_event, contents) => attachHostProduct(contents));
  for (const contents of webContents.getAllWebContents()) attachHostProduct(contents);

  let serviceState: { phase: string; error?: string } = { phase: "stopped" };
  const emitRegistrationTrace = (event: RegistrationTrace) => {
    log.info("[NuwaxReg]", event);
    ctx.getMainWindow()?.webContents.send("nuwax:registrationTrace", event);
  };
  const lifecycle = initializeCommercialAuth(
    async (signal) => {
      const { checkAllDependencies } =
        await import("../services/system/dependencies");
      const deps = await checkAllDependencies();
      signal.throwIfAborted();
      if (deps.some((d) => d.status === "missing" || d.status === "error"))
        throw new Error("Required dependencies unavailable");
      const { startSandboxService } =
        await import("../services/sandbox/serviceBootstrap");
      await startSandboxService();
      signal.throwIfAborted();
      const result = await restartAllServicesNow(signal);
      // Computer Use 幂等收敛（开关开→拉 daemon+保 MCP 条目在位）；不阻塞启动主链
      void cuaComputerUse.ensureCuaOnBoot().catch((e) =>
        log.warn("[NuwaxBridge] Cua boot ensure failed", e),
      );
      return result;
    },
    stopAllServicesNow,
    (phase, error) => {
      serviceState = { phase, error };
      log.info("[NuwaxBridge] Service state", serviceState);
      ctx.getMainWindow()?.webContents.send("nuwax:serviceState", serviceState);
    },
    () => {
      // 注册接口也能发现登录失效；不依赖页面恰好发起下一次业务请求。
      // token 失效 ≠ 注销设备：保留注册凭据（reg 仍要 savedKey），用户重新
      // 登录即可闭环；换账号登录由 persistToken 的账号切换检测清除。
      authGeneration++;
      invalidateTicketSession(nuwaxSessionScopes(currentBusinessOrigin()));
      cancelTransfers();
      const scopes = nuwaxSessionScopes(currentBusinessOrigin());
      for (const scope of scopes) writeSetting(tokenKey(scope), null);
      clearShellAuthState();
      clearRegistration({ preserveSavedKey: true });
      ctx
        .getMainWindow()
        ?.webContents.send("nuwax:authChanged", { loggedIn: false });
      void lifecycle
        .stop()
        .then(() => clearSiteStorage(scopes))
        .then(() => {
          ctx.getMainWindow()?.webContents.send("nuwax:serverHostChanged", {});
        })
        .catch((error) =>
          log.error("[NuwaxBridge] Expiry cleanup failed", error),
        );
    },
    emitRegistrationTrace,
  );
  ipcMain.handle("services:syncConfig", (event) =>
    isHostSender(event) ? lifecycle.sync() : { success: false, error: "untrusted sender" },
  );
  ipcMain.handle("services:authState", (event) => isHostSender(event) ? ({
    ...serviceState,
    loggedIn: !!currentTicket(),
  }) : null);
  // 每个文档第一次读取会话上下文时绑定代次。换域/登出后旧文档不能写回。
  let authGeneration = 0;
  let authClearHandled = false;
  let transfers = new AbortController();
  const cancelTransfers = () => {
    transfers.abort();
    transfers = new AbortController();
  };
  let switching = false;
  const documents = new Map<string, number>();
  const documentKey = (event: IpcMainInvokeEvent) =>
    `${event.sender?.id}:${event.senderFrame?.processId}:${event.senderFrame?.routingId}`;
  const isCurrentDocument = (event: IpcMainInvokeEvent) =>
    !switching && isTrustedBusinessSender(event, trustedOrigins()) &&
    documents.get(documentKey(event)) === authGeneration;
  const clearSiteStorage = async (scopes: string[], full = false) => {
    const sessions = new Set(
      webContents.getAllWebContents().map((wc) => wc.session),
    );
    for (const ses of sessions)
      for (const origin of scopes) {
        if (/^https?:\/\//.test(origin))
          await ses.clearStorageData({
            origin,
            storages: full
              ? ["cookies", "localstorage", "indexdb", "serviceworkers", "cachestorage"]
              : ["cookies"],
          });
      }
  };
  // localFiles 仅保留宿主原生目录选择器：返回绝对路径，数据面由 nuwax 走
  // file-server（customTargetDir）HTTP 通道，主进程不做持久化与文件操作。
  // 注：当前 nuwax 前端已无调用方（「文件树选择非工作空间目录」需求回滚，
  // 见 nuwax/specs/luodong-delivery.md）。保留为对外桥面，避免前端需要时再动基座。
  ipcMain.handle("localFiles:pickDirectory", async (event) => {
    if (!isTrustedSender(event)) return { canceled: true, paths: [] as string[] };
    const win = ctx.getMainWindow();
    const options: OpenDialogOptions = {
      properties: ["openDirectory", "multiSelections"],
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    return result.canceled
      ? { canceled: true, paths: [] as string[] }
      : { canceled: false, paths: result.filePaths };
  });

  // ---- theme：nuwax 女娲主题 → 壳原生 UI 统一 ----
  // nuwax 主题生效/让位时推送 { active, 调色板 }，转发给壳 renderer 叠加/回落
  // （antd tokens + CSS 变量）。fire-and-forget（send），无返回值语义。
  ipcMain.on("nuwax:theme-sync", (event, payload: unknown) => {
    if (!isTrustedSender(event)) return;
    const safe =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : null;
    if (!safe || typeof safe.active !== "boolean") return;
    ctx.getMainWindow()?.webContents.send("nuwax:theme-changed", safe);
  });

  // ---- i18n：nuwax 语言变化 → 壳（UI 文案/主进程语言跟随） ----
  // nuwax 切换多语言（登录页语言开关/设置页/登录后用户资料同步）时推送当前语言，
  // 主进程直接跟随 guest，再通知壳 renderer 更新文案。不能经 i18n:setLang
  // 回传 set-lang 给 guest，否则 guest 自己切语言后会被宿主重复重载。
  ipcMain.on("nuwax:lang-sync", (event, payload: unknown) => {
    if (!isTrustedSender(event)) return;
    const safe =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : null;
    const lang = safe && typeof safe.lang === "string" ? safe.lang.trim() : "";
    if (!/^[a-z]{2,8}(?:-[a-z0-9]{2,8})*$/i.test(lang)) return;
    const shellLang = resolveShellLang(lang);
    log.info("[NuwaxBridge] lang-sync", { lang });
    writeSetting(NUWAX_WEBVIEW_LANG_KEY, lang.toLowerCase());
    if (getMainLang() !== shellLang) {
      setMainLang(shellLang);
      getTrayManager()?.refresh();
    }
    ctx.getMainWindow()?.webContents.send("nuwax:lang-changed", { lang: shellLang });
  });

  // ---- meta：nuwax 前端构建信息 → 壳（关于页「界面版本」展示） ----
  // 页面启动时上报一次 { appVersion, gitHash? }；转发给壳 renderer 存态，
  // fire-and-forget。非法载荷直接忽略。
  ipcMain.on("nuwax:web-meta", (event, payload: unknown) => {
    if (!isTrustedSender(event)) return;
    const safe =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : null;
    const appVersion =
      safe && typeof safe.appVersion === "string"
        ? safe.appVersion.trim()
        : "";
    if (!appVersion) return;
    const gitHash =
      safe && typeof safe.gitHash === "string" ? safe.gitHash.trim() : "";
    log.info("[NuwaxBridge] web-meta", { appVersion, gitHash });
    ctx.getMainWindow()?.webContents.send("nuwax:web-meta-changed", {
      appVersion,
      ...(gitHash ? { gitHash } : {}),
    });
  });

  // ---- layout：nuwax 布局状态 → 壳（工具栏收起按钮显隐/icon 态） ----
  // secondMenuAvailable：当前页是否有二级菜单（无则隐藏收起按钮）。
  // secondMenuCollapsed：二级菜单真实收起态（壳 icon 以此为准，修 reload 失同步）。
  ipcMain.on("nuwax:layout-sync", (event, payload: unknown) => {
    if (!isTrustedSender(event)) return;
    const safe =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : null;
    if (!safe) return;
    const forward: Record<string, unknown> = {};
    if (typeof safe.secondMenuAvailable === "boolean") {
      forward.secondMenuAvailable = safe.secondMenuAvailable;
    }
    if (typeof safe.secondMenuCollapsed === "boolean") {
      forward.secondMenuCollapsed = safe.secondMenuCollapsed;
    }
    if ("titlebarDragRegions" in safe) {
      const viewportWidth =
        ctx.getMainWindow()?.getContentBounds().width ?? Number.MAX_SAFE_INTEGER;
      const regions = sanitizeTitlebarDragRegions(
        safe.titlebarDragRegions,
        viewportWidth,
      );
      if (regions) {
        forward.titlebarDragRegions = regions;
        // 观测点：拖拽失效排障需区分「guest 没上报 / 上报被裁空 / 上报正常」
        // 三类；只记条数与首矩形，避免高频 flush 刷屏。
        log.debug(
          "[NuwaxBridge] layout-sync titlebar regions=" +
            regions.length +
            (regions.length > 0
              ? ` first={x:${regions[0].x},y:${regions[0].y},w:${regions[0].width},h:${regions[0].height}}`
              : ""),
        );
      }
    }
    if (Object.keys(forward).length === 0) return;
    ctx.getMainWindow()?.webContents.send("nuwax:layout-changed", forward);
  });

  // ---- titlebar：标题栏手势（guest 命中判定→主进程拖窗/双击缩放） ----
  // 2026-09-17 架构切换：壳层不再渲染 app-region 拖拽矩形（旧方案挖洞遗漏即吞
  // 页面点击，页面形态无法枚举）；guest mousedown 捕获阶段判定目标为空白后才发
  // beginDrag，主进程 16ms 光标轮询移动窗口，guest mouseup/blur 补发 drag-end。
  let titlebarDragTimer: NodeJS.Timeout | null = null;
  const stopTitlebarDrag = () => {
    if (titlebarDragTimer) {
      clearInterval(titlebarDragTimer);
      titlebarDragTimer = null;
    }
  };
  ipcMain.on("nuwax:titlebar-drag-start", (event) => {
    if (!isTrustedSender(event)) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    log.info("[NuwaxBridge] titlebar-drag-start", { hasWin: !!win });
    if (!win || win.isMinimized() || titlebarDragTimer) return;
    const startCursor = screen.getCursorScreenPoint();
    const [winX, winY] = win.getPosition();
    let last = startCursor;
    // 安全上限：guest 端 mouseup/blur/buttons 三重兜底，这里再兜 15s 防泄漏
    const startedAt = Date.now();
    titlebarDragTimer = setInterval(() => {
      if (win.isDestroyed() || Date.now() - startedAt > 15_000) {
        stopTitlebarDrag();
        return;
      }
      const cursor = screen.getCursorScreenPoint();
      if (cursor.x === last.x && cursor.y === last.y) return;
      last = cursor;
      win.setPosition(
        winX + (cursor.x - startCursor.x),
        winY + (cursor.y - startCursor.y),
      );
    }, 16);
  });
  ipcMain.on("nuwax:titlebar-drag-end", (event) => {
    if (isTrustedSender(event)) stopTitlebarDrag();
  });
  ipcMain.on("nuwax:titlebar-toggle-maximize", (event) => {
    if (!isTrustedSender(event)) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  const trustedOrigins = businessBridgeOrigins;

  const isTrustedSender = (event: Electron.IpcMainEvent | IpcMainInvokeEvent) =>
    !switching && isTrustedBusinessSender(event, trustedOrigins());
  const isTrustedMenuSource = (
    frameUrl: string | undefined,
    source: Electron.WebContents,
  ) => {
    if (!frameUrl || source.isDestroyed() || source.session !== session.defaultSession) return false;
    const origins = trustedOrigins();
    const frame = httpOrigin(frameUrl);
    const top = httpOrigin(source.getURL());
    return !!frame && !!top && origins.includes(frame) && origins.includes(top);
  };
  const isHostSender = (event: Electron.IpcMainEvent | IpcMainInvokeEvent) => {
    const contents = ctx.getMainWindow()?.webContents;
    if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame)
      return false;
    try {
      const url = new URL(contents.getURL());
      return url.protocol === "file:" || url.protocol === "app:" ||
        (!app.isPackaged && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
          ["http:", "https:"].includes(url.protocol));
    } catch {
      return false;
    }
  };

  ipcMain.handle("auth:getContext", (event) => {
    if (!isTrustedSender(event)) return null;
    documents.set(documentKey(event), authGeneration);
    const loopback = readSetting("nuwax.loopback") as { enabled?: boolean; origin?: string } | null;
    const gatewayOrigin = loopback?.enabled && loopback.origin ? loopback.origin : null;
    return { businessOrigin: currentBusinessOrigin(), gatewayOrigin, loadMode: gatewayOrigin ? "gateway" : "direct" };
  });

  // Token-only bridge calls are retired. Old clients must use the cookie-capable build.
  ipcMain.handle("auth:getToken", () => null);
  ipcMain.handle("auth:persistToken", () => false);
  let restoration: Promise<void> | null = null;
  const ensureTicketRestored = (): Promise<void> => {
    const loopback = readSetting("nuwax.loopback") as { enabled?: boolean; origin?: string } | null;
    restoration ??= restoreTicketSession(loopback?.enabled ? loopback.origin ?? null : null);
    return restoration;
  };
  ipcMain.handle("auth:beginLogin", async (event) => {
    const scope = resolveSenderOrigin(event);
    if (!isTrustedSender(event)) return false;
    authClearHandled = false;
    authGeneration++;
    const generation = authGeneration;
    documents.set(documentKey(event), authGeneration);
    cancelTransfers();
    const scopes = nuwaxSessionScopes(scope);
    await ensureTicketRestored();
    if (generation !== authGeneration) return false;
    // Restoration may promote the existing jar into the mirror. Complete it
    // before clearing the old login so it cannot restore that mirror afterward.
    invalidateTicketSession(scopes);
    await clearTicketCookies(scopes);
    await lifecycle.stop();
    return generation === authGeneration && isCurrentDocument(event);
  });

  // A token is never passed over this bridge. Login and startup both validate
  // the cookie already stored by Chromium, including direct-mode renewals.
  ipcMain.handle("auth:syncSession", async (event) => {
    const scope = resolveSenderOrigin(event);
    if (!isTrustedSender(event)) return false;
    const key = documentKey(event);
    documents.set(key, authGeneration);
    const generation = authGeneration;
    const businessOrigin = currentBusinessOrigin();
    emitRegistrationTrace({ stage: "sync-session-start", origin: businessOrigin, phase: serviceState.phase });
    await ensureTicketRestored();
    if (generation !== authGeneration || businessOrigin !== currentBusinessOrigin()) return false;
    const gatewayOrigin = (readSetting("nuwax.loopback") as { origin?: string } | null)?.origin;
    const source = scope === gatewayOrigin ? scope : businessOrigin;
    let captured = false;
    for (let attempt = 0; attempt < 12 && !captured; attempt++) {
      captured = await syncTicketFromJar(source);
      if (!captured && attempt < 11)
        await new Promise((resolve) => setTimeout(resolve, 50));
      if (generation !== authGeneration || businessOrigin !== currentBusinessOrigin()) return false;
    }
    if (!captured || generation !== authGeneration || !isCurrentDocument(event)) {
      if (!captured && generation === authGeneration)
        emitRegistrationTrace({ stage: "sync-session-no-cookie", origin: businessOrigin });
      return false;
    }
    let ticket = currentTicket();
    if (!ticket) return false;
    const requestEpoch = ticketEpoch();
    const expire = async () => {
      if (generation !== authGeneration) return;
      authGeneration++;
      cancelTransfers();
      const scopes = nuwaxSessionScopes(scope);
      invalidateTicketSession(scopes);
      clearShellAuthState();
      clearRegistration({ preserveSavedKey: true });
      ctx.getMainWindow()?.webContents.send("nuwax:authChanged", { loggedIn: false });
      await lifecycle.stop();
      await clearSiteStorage(scopes);
    };
    // Query the authenticated account rather than trusting a login token or
    // renderer-supplied identity. A different account invalidates device keys.
    let username: string;
    try {
      const response = await net.fetch(`${businessOrigin}/api/user/getLoginInfo`, {
        method: "GET", redirect: "error", credentials: "omit",
        headers: { ...nativeTicketHeaders(ticket), "x-client-type": "nuwax" },
      });
      await mirrorNativeResponseTicket(response, businessOrigin, requestEpoch);
      if (response.status === 401) {
        emitRegistrationTrace({ stage: "sync-session-validation-failed", origin: businessOrigin, status: 401 });
        await expire();
        return false;
      }
      ticket = currentTicket();
      if (!ticket) {
        emitRegistrationTrace({ stage: "sync-session-no-cookie", origin: businessOrigin });
        await expire();
        return false;
      }
      const payload = await response.json();
      if (!response.ok || payload?.code !== "0000" || !payload?.data?.userName) {
        emitRegistrationTrace({ stage: "sync-session-validation-failed", origin: businessOrigin,
          status: response.status, code: registrationTraceCode(payload?.code) });
        if (response.status === 401 || ["4010", "4011"].includes(payload?.code)) await expire();
        return false;
      }
      username = payload.data.userName;
    } catch (error) {
      emitRegistrationTrace({ stage: "sync-session-validation-error", origin: businessOrigin });
      log.warn("[NuwaxBridge] cookie session validation failed", error);
      return false;
    }
    if (generation !== authGeneration || businessOrigin !== currentBusinessOrigin() ||
        ticket !== currentTicket() || !isCurrentDocument(event)) return false;
    const previousAccount = readSetting("auth.username");
    if (previousAccount && previousAccount !== username) {
      advanceTicketEpoch();
      cancelTransfers();
      await lifecycle.stop();
      clearShellAuthState();
      clearRegistration();
      if (generation !== authGeneration || ticket !== currentTicket()) return false;
    }
    ctx.getMainWindow()?.webContents.send("nuwax:authChanged", { loggedIn: true });
    authClearHandled = false;
    emitRegistrationTrace({ stage: "sync-session-valid", origin: businessOrigin, phase: serviceState.phase });
    void lifecycle.start();
    return true;
  });

  ipcMain.handle("auth:clear", async (event) => {
    if (!isTrustedSender(event) || !isCurrentDocument(event)) return false;
    if (authClearHandled) return true;
    authClearHandled = true;
    const hadTicket = !!currentTicket();
    authGeneration++;
    cancelTransfers();
    const stopping = lifecycle.stop();
    const scope = resolveSenderOrigin(event);
    // 升级兼容：清除 sender、业务域和网关范围内残留的旧 token 键。
    const scopes = nuwaxSessionScopes(scope);
    invalidateTicketSession(scopes);
    for (const s of scopes) writeSetting(tokenKey(s), null);
    log.info("[NuwaxBridge] auth:clear", { scopes });

    // 登出保留 savedKey/username，供同账号重新注册；换账号时由
    // auth:syncSession 查询到的真实用户名触发全清。
    clearShellAuthState();

    clearRegistration({ preserveSavedKey: true });
    ctx
      .getMainWindow()
      ?.webContents.send("nuwax:authChanged", { loggedIn: false });
    if (hadTicket) await clearSiteStorage(scopes);
    const stopped = await stopping;
    return stopped.success;
  });

  // ---- auth：企业登录（切换后端域名，客户端重新初始化） ----
  // 登录页「企业登录」入口调用：归一化并写入 step1_config.serverHost（业务域
  // 唯一事实源），清掉旧域全部派生凭据，停止全部本地服务（重新初始化语义——
  // 在跑的 lanproxy 等仍连旧域名，留着只会错乱），刷新回环网关（gateway 形态
  // 反代目标随域重指），并通知 renderer 重解析 webview URL（direct 形态即加载
  // 新域名的 /Login）。切换后 webview 在新域无 ticket → 登录页；登录成功经
  // auth:syncSession → reg+重启服务，完成向新域的重新初始化。
  const configureServerHost = async (
    event: IpcMainInvokeEvent,
    input: unknown,
  ) => {
    if (switching) return { success: false, error: "Domain switch already in progress" };
    const raw =
      typeof input === "string" ? input.trim().replace(/\/+$/, "") : "";
    if (!raw) return { success: false, error: "empty domain" };
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
      ? raw
      : `https://${raw}`;
    let origin: string;
    try {
      const url = new URL(candidate);
      if (!/^https?:$/.test(url.protocol)) {
        return { success: false, error: "only http(s) allowed" };
      }
      origin = url.origin;
    } catch {
      return { success: false, error: "invalid domain" };
    }

    if (!(isTrustedSender(event) && isCurrentDocument(event)) && !isHostSender(event))
      return { success: false, error: "Stale document" };
    switching = true;
    authGeneration++;
    cancelTransfers();
    const scopes = nuwaxSessionScopes(resolveSenderOrigin(event));
    invalidateTicketSession([...scopes, origin]);
    // Existing secondary pages retain the trusted-origin list captured in their
    // preload arguments. Close them before changing domains so a stale bridge
    // cannot be reused with the next account's origin.
    for (const win of [...businessShellWindows]) {
      // A page can cancel close() in beforeunload; account boundaries cannot.
      if (!win.isDestroyed()) win.destroy();
    }
    businessShellWindows.clear();
    destroyTrustedBusinessPopups();
    const stopping = lifecycle.stop();
    // 换域 = 账号体系变化：全清注册凭据（与 auth:syncSession 的账号切换、auth:clear
    // 的登出保留相对——三者语义见 clearRegistration 注释）。
    clearShellAuthState();
    clearRegistration();
    for (const scope of scopes) writeSetting(tokenKey(scope), null);
    // 新域历史凭据一并清理，回切也必须重新登录。
    writeSetting(tokenKey(origin), null);
    ctx
      .getMainWindow()
      ?.webContents.send("nuwax:authChanged", { loggedIn: false });
    const previousConfig = readSetting("step1_config") as Record<
      string,
      unknown
    > | null;
    let changedGatewayTarget = false;
    try {
      const result = await stopping;
      if (!result.success) throw new Error("Failed to stop business services");
      await clearSiteStorage([...scopes, origin], true);
      const prev = readSetting("step1_config") as Record<
        string,
        unknown
      > | null;
      writeSetting("step1_config", { ...prev, serverHost: origin });
      changedGatewayTarget = true;
      const { refreshLoopbackGateway } =
        await import("../services/loopbackGateway");
      await refreshLoopbackGateway();
      ctx
        .getMainWindow()
        ?.webContents.send("nuwax:serverHostChanged", { serverHost: origin });
      return { success: true, serverHost: origin };
    } catch (error) {
      // 同文档允许再次操作重试，但旧会话仍不可写回（需重新读取上下文）。
      writeSetting("step1_config", previousConfig);
      let rollbackError: unknown = null;
      if (changedGatewayTarget) {
        try {
          const { refreshLoopbackGateway } = await import("../services/loopbackGateway");
          await refreshLoopbackGateway();
        } catch (restoreError) {
          rollbackError = restoreError;
          log.error("[NuwaxBridge] previous gateway restore failed", restoreError);
        }
      }
      ctx.getMainWindow()?.webContents.send("nuwax:serverHostChanged", {
        serverHost: currentBusinessOrigin(),
        loginRequired: true,
      });
      return {
        success: false,
        error: rollbackError
          ? `Domain switch failed: ${String(error)}; previous gateway restore failed: ${String(rollbackError)}`
          : changedGatewayTarget
            ? `Domain switch failed; previous gateway restored: ${String(error)}. Please sign in again.`
            : `Domain switch failed: ${String(error)}. Please sign in again.`,
      };
    } finally {
      switching = false;
    }
  };
  ipcMain.handle("auth:configureServerHost", configureServerHost);
  ipcMain.handle("services:configureServerHost", configureServerHost);

  // ---- native：新开独立窗口打开 nuwax 页面 ----
  // 智能体详情/工作流/网页应用开发/我的电脑等全屏页在主窗口会被沉浸式工具栏遮挡
  //（fixed 头部/画布类布局也无法内嵌避让），改为独立窗口承载：带系统标题栏零遮挡，
  // 站内页带桥 preload 并追加 _shell=1；外链用无桥、独立内存会话窗口。
  ipcMain.handle("native:openWindow", (event, opts: { path?: unknown }) => {
    try {
      if (!isTrustedSender(event)) {
        return { success: false, error: "untrusted sender" };
      }
      const raw = opts?.path;
      if (typeof raw !== "string" || !raw) {
        return { success: false, error: "invalid path" };
      }
      const base = event.senderFrame?.url || event.sender?.getURL?.() || "";
      if (!base) return { success: false, error: "sender url missing" };
      let target: URL;
      if (/^https?:\/\//i.test(raw)) {
        // 绝对 http(s) URL：外链（如导航"文档"），仅校验协议
        target = new URL(raw);
      } else if (raw.startsWith("/") && !raw.startsWith("//")) {
        // 站内相对路径：与发起 webview 同源拼接，杜绝任意源打开
        target = new URL(raw, base);
        if (target.origin !== new URL(base).origin) {
          return { success: false, error: "cross-origin blocked" };
        }
        // 二级页承载：same-window（默认）= 主 webview 内同窗导航（沉浸式避让，
        // 见 nuwax 侧 header-area/page-container 退让）；new-window = 独立窗口
        // （系统标题栏零遮挡，_shell=1 恢复浏览器式布局）。
        const step1 = readSetting("step1_config") as {
          secondaryPages?: "same-window" | "new-window";
        } | null;
        if (step1?.secondaryPages !== "new-window") {
          ctx.getMainWindow()?.webContents.send("nuwax:open-same-window", {
            url: target.href,
          });
          log.info("[NuwaxBridge] native:openWindow same-window", {
            path: raw,
          });
          return { success: true };
        }
        // 独立窗口标记（nuwax 据此恢复浏览器式布局：显示 logo/收起按钮、不避让）
        target.searchParams.set("_shell", "1");
      } else {
        return { success: false, error: "invalid path" };
      }

      const loopback = readSetting("nuwax.loopback") as { enabled?: boolean; origin?: string } | null;
      const businessWindow = !target.username && !target.password &&
        trustedOrigins().includes(target.origin);
      // Absolute same-origin links also open a standalone window. Its frontend
      // must use the standalone layout, regardless of the secondary-page setting.
      if (businessWindow) target.searchParams.set("_shell", "1");
      const isolatedPartition = businessWindow ? null : `temp:nuwax-external-${randomUUID()}`;
      if (isolatedPartition) configureIsolatedWebSession(isolatedPartition);
      if (loopback?.enabled && loopback.origin && matchesBusinessOrigin(target.href, currentBusinessOrigin())) {
        // Concatenate the fixed origin explicitly: a pathname beginning with //
        // must remain a path, never become a scheme-relative external authority.
        target = new URL(`${loopback.origin}${target.pathname}${target.search}${target.hash}`);
        target.searchParams.set("_shell", "1");
      }
      const win = new BrowserWindow({
        width: 1280,
        height: 832,
        // 承载同一 nuwax 前端，同受 768 移动端断点约束，与主窗口共用下限
        minWidth: NUWAX_MAIN_WINDOW_MIN_WIDTH,
        minHeight: NUWAX_MAIN_WINDOW_MIN_HEIGHT,
        autoHideMenuBar: true,
        webPreferences: businessWindow
          ? {
              preload: path.join(__dirname, "..", "preload", "webviewPerfBridge.js"),
              additionalArguments: [
                hostProductArg,
                `--nuwax-trusted-origins=${encodeURIComponent(JSON.stringify(trustedOrigins()))}`,
              ],
              contextIsolation: true,
              nodeIntegration: false,
            }
          : {
              // 外部网站只留在客户端窗口；独立内存会话不携带业务 cookie。
              partition: isolatedPartition!,
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
            },
      });
      shellWindows.add(win);
      if (businessWindow) businessShellWindows.add(win);
      win.on("closed", () => {
        shellWindows.delete(win);
        businessShellWindows.delete(win);
      });
      if (businessWindow) trustInitialBusinessNavigation(win.webContents, target.href);
      void win.loadURL(target.href);
      win.focus();
      log.info("[NuwaxBridge] native:openWindow", { path: raw });
      return { success: true };
    } catch (error) {
      log.error("[NuwaxBridge] native:openWindow failed", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  // ---- native：打开壳的「客户端配置」设置弹窗 ----
  // nuwax web 用户区「客户端设置」按钮入口（仅 nuwax 宿主渲染，壳顶行设置按钮
  // 在 nuwax 宿主下移除）。设置弹窗是壳 renderer 的 React state（webview 之上的
  // antd Modal），主进程无法直接打开，转发 nuwax:open-client-settings 给壳
  // renderer（同 open-same-window 模式；壳 preload on() 白名单已含该 channel）。
  ipcMain.handle("native:openClientSettings", (event) => {
    if (!isTrustedSender(event)) return { success: false, error: "untrusted sender" };
    ctx.getMainWindow()?.webContents.send("nuwax:open-client-settings", {});
    log.info("[NuwaxBridge] native:openClientSettings");
    return { success: true };
  });

  // ---- cua：Computer Use 配置（设置页开关/状态/授权引导/首用安装；overlay 自持实现） ----
  cuaComputerUse.registerCuaQuitCleanup();
  // 允许锁屏运行：读库恢复档位并持有断言（registerAllHandlers 在 app ready 且
  // initDatabase 之后执行，此入口即 overlay 的 boot 钩子，同 ensureCuaOnBoot 先例）
  initSessionAuthInjection(() => ({
    businessOrigin: currentBusinessOrigin(),
    trustedOrigins: trustedOrigins(),
    gateway: switching ? null : getGatewayRequestContext(),
  }));
  powerPolicy.initPowerPolicy();
  // 全磁盘访问初始化引导（仅 darwin）：主窗口首帧检测，未授权且未拒绝过弹一次
  // 原生引导窗，「暂不」持久化永不再弹；聚焦/解锁只静默复查（拒绝后的再入口
  // 在设置页状态行）。内部自挂 browser-window-created，同上拿不到窗口实例。
  fullDiskAccess.initFullDiskAccessGuard();
  // 窗口最小尺寸 1200×720：本钩子先于 createWindow 执行（main.ts app ready
  // 序里 registerAllHandlers 在 createWindow 之前），拿不到窗口实例，挂
  // browser-window-created 补设。注意事件在构造参数应用【之前】触发——同步
  // setMinimumSize 会被构造参数的基座 800×600 盖回（Electron 40 真机实证），
  // 推迟到构造完成的下一轮事件循环再设；已开的小尺寸持久化 bounds 会被
  // Electron 就地抬升到下限（mac activate 重建主窗口同样经此事件覆盖）。
  app.on("browser-window-created", (_event, win) => {
    setImmediate(() => applyMainWindowMinSize(win));
  });
  ipcMain.handle("cua:getStatus", (event) =>
    isHostSender(event) ? cuaComputerUse.getCuaStatus() : null,
  );
  ipcMain.handle("cua:setEnabled", (event, enabled: boolean) =>
    isHostSender(event) ? cuaComputerUse.setCuaEnabled(enabled === true) : { success: false, error: "untrusted sender" },
  );
  ipcMain.handle("cua:requestPermissions", (event) =>
    isHostSender(event) ? cuaComputerUse.requestCuaPermissions() : null,
  );
  ipcMain.handle("cua:installHelper", (event) =>
    isHostSender(event) ? cuaComputerUse.installCuaHelper() : { success: false, error: "untrusted sender" },
  );
  ipcMain.handle("cua:getVlmConfig", (event) =>
    isHostSender(event) ? cuaComputerUse.getVlmConfig() : null,
  );
  ipcMain.handle("cua:setVlmConfig", (event, patch: unknown) =>
    isHostSender(event) ? cuaComputerUse.setVlmConfig(
      (patch ?? {}) as { baseUrl?: string; model?: string; apiKey?: string },
    ) : { success: false, error: "untrusted sender" },
  );
  ipcMain.handle("cua:testVlm", (event) =>
    isHostSender(event) ? cuaComputerUse.testVlm() : { success: false, error: "untrusted sender" },
  );

  // ---- powerPolicy：允许锁屏运行（电源保活档位；overlay 自持实现） ----
  ipcMain.handle("powerPolicy:get", (event) =>
    isHostSender(event) ? powerPolicy.getPowerPolicyMode() : null,
  );
  ipcMain.handle("powerPolicy:setMode", (event, mode: unknown) =>
    isHostSender(event) ? powerPolicy.setPowerPolicyMode(mode) : null,
  );

  // ---- fullDiskAccess：全磁盘访问状态/引导（仅 mac 有意义；overlay 自持实现） ----
  ipcMain.handle("fullDiskAccess:getStatus", (event) =>
    isHostSender(event) ? fullDiskAccess.getFullDiskAccessStatus() : null,
  );
  ipcMain.handle("fullDiskAccess:openSettings", (event) =>
    isHostSender(event) ? fullDiskAccess.openFullDiskAccessSettings() : null,
  );
  ipcMain.handle("fullDiskAccess:recheck", (event) =>
    isHostSender(event) ? fullDiskAccess.getFullDiskAccessStatus() : null,
  );

  // ---- native：右键另存图片（IPC 通道与页面内右键菜单共用核心）----
  // 核心抽为本地函数：nuwax 前端经 IPC 调（frameUrl 取 senderFrame.url），页面
  // 右键菜单（services/contextMenu.ts，bug 2473）直接复用（frameUrl 取右键
  // 所在 frameURL，并单独核对顶层 URL，避免外链窗口借此代注业务 ticket）。
  const performSaveDownload = async (
    opts: { url: string; filename?: string } | undefined,
    frameUrl: string | undefined,
    stillTrusted: () => boolean = () => true,
    allowBusinessCredentials = true,
    fileDownload = false,
  ): Promise<contextMenuService.ContextMenuImageSaveResult> => {
    const generation = authGeneration;
    const requestEpoch = ticketEpoch();
    const transferSignal = transfers.signal;
    try {
      const { url, filename } = opts || {};
      if (typeof url !== "string" || !url) {
        return { success: false, error: "invalid url" };
      }

      // nuwax 前端直接传 <img src> 原值，markdown 图片常见相对地址
      // （/api/computer/static/... 或裸路径），而 net.fetch 只接受绝对 URL。
      // 以调用方 frame 的 origin 为 base 归一；base 缺失或解析失败才判非法。
      let target: URL;
      try {
        target = new URL(url, frameUrl || undefined);
      } catch {
        return { success: false, error: "invalid url" };
      }
      if (!/^https?:$/.test(target.protocol)) {
        return { success: false, error: "unsupported protocol" };
      }
      const gateway = (readSetting("nuwax.loopback") as { origin?: string } | null)?.origin;
      if (gateway && target.origin === gateway && !allowBusinessCredentials)
        return { success: false, error: "untrusted source" };
      if (gateway && target.origin === gateway)
        target = new URL(target.pathname + target.search, currentBusinessOrigin());

      // 默认文件名取 URL 末段并去除非法字符；无扩展名的图片补 .png、产物补 .bin
      const derived =
        filename ||
        decodeURIComponent(target.pathname.split("/").pop() || "") ||
        (fileDownload ? "download" : "image");
      const safeName = derived.replace(/[\\/:*?"<>|]/g, "_").slice(0, 120);
      const ext = path.extname(safeName) ? "" : fileDownload ? ".bin" : ".png";
      const defaultPath = `${safeName}${ext}`;
      const extension = path
        .extname(`${safeName}${ext}`)
        .replace(".", "")
        .toLowerCase();
      const filters = extension
        ? [
            { name: extension.toUpperCase(), extensions: [extension] },
            { name: "All Files", extensions: ["*"] },
          ]
        : undefined;

      const win = ctx.getMainWindow();
      const res = win
        ? await dialog.showSaveDialog(win, { defaultPath, filters })
        : await dialog.showSaveDialog({ defaultPath, filters });
      if (res.canceled || !res.filePath) {
        return { success: false, canceled: true };
      }
      if (!stillTrusted()) return { success: false, error: "untrusted sender" };

      const signal = AbortSignal.any([
        transferSignal,
        AbortSignal.timeout(120_000),
      ]);
      let destination = target;
      let resp: Response | undefined;
      for (let redirects = 0; redirects <= 5; redirects++) {
        if (generation !== authGeneration || switching || !stillTrusted())
          throw new Error("Session changed");
        const ticket =
          allowBusinessCredentials && destination.origin === currentBusinessOrigin()
            ? currentTicket()
            : null;
        // Electron net.fetch rejects manual redirects before exposing the 302.
        // Node fetch preserves the response so every hop can recheck origin/auth.
        resp = await globalThis.fetch(destination.toString(), {
          method: "GET",
          redirect: "manual",
          signal,
          headers: ticket ? { Cookie: `ticket=${ticket}` } : {},
        });
        if (allowBusinessCredentials && destination.origin === currentBusinessOrigin())
          await mirrorNativeResponseTicket(resp, destination.origin, requestEpoch);
        if (![301, 302, 303, 307, 308].includes(resp.status)) break;
        const location = resp.headers.get("location");
        await resp.body?.cancel();
        if (!location || redirects === 5)
          throw new Error("Invalid image redirect");
        destination = new URL(location, destination);
        if (!/^https?:$/.test(destination.protocol))
          throw new Error("Unsupported redirect protocol");
      }
      if (generation !== authGeneration || switching || !stillTrusted())
        throw new Error("Session changed");
      // 文件树产物可为 HTML/JSON。只有源地址（含最终重定向）本身声明
      // 相应扩展时允许文档正文；用户改保存名不能把 ZIP/接口错误页放过。
      const sourceExtension = (source: URL): string => {
        try { return path.extname(decodeURIComponent(source.pathname)).toLowerCase(); }
        catch { return ""; }
      };
      const contentType = resp!.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      const documentExtensions = contentType === "text/html" ? [".html", ".htm"]
        : ["application/json", "text/json"].includes(contentType || "") ? [".json"] : [];
      const documentFile = fileDownload && documentExtensions.includes(sourceExtension(target)) &&
        documentExtensions.includes(sourceExtension(destination));
      await saveResponse(resp!, res.filePath, signal, documentFile ? undefined : "binary");
      const bytes = fs.statSync(res.filePath).size;
      log.info(`[NuwaxBridge] native:${fileDownload ? "saveFile" : "saveImage"} saved`, {
        path: res.filePath,
        bytes,
      });
      return { success: true, path: res.filePath };
    } catch (error) {
      log.error(`[NuwaxBridge] native:${fileDownload ? "saveFile" : "saveImage"} failed`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
  ipcMain.handle(
    "native:saveImage",
    (event, opts: { url: string; filename?: string }) =>
      isTrustedSender(event)
        ? performSaveDownload(opts, event.senderFrame?.url, () => isTrustedSender(event))
        : { success: false, error: "untrusted sender" },
  );

  // 产物下载独立能力；图片另存及旧壳兼容接口保持原来的错误页保护。
  ipcMain.handle(
    "native:saveFile",
    (event, opts: { url: string; filename?: string }) =>
      isTrustedSender(event)
        ? performSaveDownload(opts, event.senderFrame?.url, () => isTrustedSender(event), true, true)
        : { success: false, error: "untrusted sender" },
  );

  // —— webview 历史导航真值通道（修 bug 2432 收银台进入后无法退出）——
  // Electron 40.8.2 实证：webview guest 加载回环网关 origin（http://127.0.0.1:46800，
  // 打包版默认形态）时，canGoBack()/goBack()/canGoForward()/goForward()（元素与主进程
  // 两路）恒 false/空转，而同一 navigationHistory 的 getActiveIndex()/getAllEntries()/
  // goToIndex() 正常（https 直连形态则全部正常；与 disable-http-cache 无关，已对照排除）。
  // 收银台（pay.nuwax.com 外域）整页跳转后的「后退」依赖此能力。工具栏因此改走本通道：
  // 主进程读真值并随导航事件推送，动作经 goToIndex 执行；旧元素方法留作无本通道时的回退。
  const readNavState = (): { canGoBack: boolean; canGoForward: boolean } => {
    const guest = webContents
      .getAllWebContents()
      .find((wc) => !wc.isDestroyed() && wc.getType() === "webview");
    try {
      const h = guest?.navigationHistory;
      const entries = h?.getAllEntries?.() ?? [];
      const active = h?.getActiveIndex?.() ?? 0;
      return {
        canGoBack: entries.length > 1 && active > 0,
        canGoForward: active < entries.length - 1,
      };
    } catch {
      return { canGoBack: false, canGoForward: false };
    }
  };
  const pushNavState = () => {
    const state = readNavState();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send("nuwax:webview-nav-state", state);
      }
    }
  };
  // guest 导航即推送（did-navigate 含整页跳转如收银台；did-navigate-in-page 含 SPA 路由；
  // dom-ready 兜首载）。商业客户端单窗单 guest，find() 取唯一 webview guest 足够。
  const hookGuestNavEvents = (wc: Electron.WebContents) => {
    if (wc.isDestroyed() || wc.getType() !== "webview") return;
    wc.on("did-navigate", pushNavState);
    wc.on("did-navigate-in-page", pushNavState);
    wc.on("dom-ready", pushNavState);
  };
  app.on("web-contents-created", (_e, wc) => hookGuestNavEvents(wc));
  for (const wc of webContents.getAllWebContents()) hookGuestNavEvents(wc);
  ipcMain.handle("nuwax:webview-nav-state", (event) =>
    isHostSender(event) ? readNavState() : { canGoBack: false, canGoForward: false },
  );
  ipcMain.handle("nuwax:webview-nav-go", (event, dir: unknown) => {
    if (!isHostSender(event)) return false;
    const guest = webContents
      .getAllWebContents()
      .find((wc) => !wc.isDestroyed() && wc.getType() === "webview");
    try {
      const h = guest?.navigationHistory;
      if (!h) return false;
      const entries = h.getAllEntries?.() ?? [];
      const active = h.getActiveIndex?.() ?? 0;
      const target = dir === "back" ? active - 1 : active + 1;
      if (target < 0 || target >= entries.length) return false;
      h.goToIndex(target);
      return true;
    } catch (e) {
      log.warn("[NuwaxBridge] webview-nav-go failed:", e);
      return false;
    }
  });

  // —— 顶栏自绘菜单收起信号（bug 2427 Win/Linux 工具栏菜单不自动关）——
  // 顶行菜单是宿主 renderer 的 antd Dropdown，「点外部收起」监听宿主 document
  // 的 mousedown；webview guest 是独立文档，页面内点击不冒泡到宿主 → 菜单挂住
  // （QA 实测：弹「编辑(E)」后点页面左侧导航不收起）。guest 捕获页面 pointerdown
  // 即可确定用户已点回内容区；focus 事件作为辅助兜底，窗口失焦（点窗口外/任务栏）
  // 也发相同信号，与原生菜单语义一致。
  const pushTopbarMenuDismiss = (win?: Electron.BrowserWindow) => {
    const targets = win ? [win] : BrowserWindow.getAllWindows();
    for (const w of targets) {
      if (!w.isDestroyed()) w.webContents.send("nuwax:dismiss-topbar-menus");
    }
  };
  // guest 页面内的真实点击比 focus 状态变化更可靠：点击侧栏时 webview 可能
  // 已经保持焦点，不会再次触发 focus；preload 捕获 pointerdown 后从这里广播收起。
  ipcMain.on("nuwax:guest-pointer-down", (event) => {
    if (event.sender.isDestroyed() || event.sender.getType() !== "webview") return;
    pushTopbarMenuDismiss();
  });
  const hookGuestFocusDismiss = (wc: Electron.WebContents) => {
    if (wc.isDestroyed() || wc.getType() !== "webview") return;
    wc.on("focus", () => pushTopbarMenuDismiss());
  };
  app.on("web-contents-created", (_e, wc) => hookGuestFocusDismiss(wc));
  for (const wc of webContents.getAllWebContents()) hookGuestFocusDismiss(wc);
  app.on("browser-window-blur", (_e, win) => pushTopbarMenuDismiss(win));

  // —— 页面内右键菜单（禅道 bug 2473：右键无菜单，无法复制/粘贴/另存图片）——
  // Electron 不监听 webContents 的 context-menu 事件就没有任何右键菜单（全仓
  // 此前零监听，页面右键无反应）。菜单覆盖 webview guest 与窗口主 contents
  // （宿主页/弹窗窗），编辑命令显式作用于发射事件的 wc；图片「另存为…」复用
  // 上面抽出的 performSaveDownload（相对地址归一/cookie 代注/重定向/保存对话框）。
  // 前端 antd 自绘右键（会话列表等）preventDefault 掉 DOM 事件，主进程
  // context-menu 不触发，天然无双重菜单。
  contextMenuService.installContextMenuService({
    saveImage: (opts, frameUrl, source) => {
      const trustedAtClick = isTrustedMenuSource(frameUrl, source);
      return performSaveDownload(
        opts,
        frameUrl,
        trustedAtClick ? () => isTrustedMenuSource(frameUrl, source) : () => true,
        trustedAtClick,
      );
    },
    normalizeCopiedUrl: (input) => {
      try {
        const url = new URL(input);
        const gateway = (readSetting("nuwax.loopback") as { origin?: string } | null)?.origin;
        if (gateway && url.origin === gateway)
          return new URL(url.pathname + url.search + url.hash, currentBusinessOrigin()).toString();
      } catch { /* non-URL clipboard content */ }
      return input;
    },
  });
}
