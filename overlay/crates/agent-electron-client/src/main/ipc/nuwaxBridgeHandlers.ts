/**
 * nuwax webview ↔ nuwaclaw 壳的桥后端。
 *
 * - auth:getToken / auth:persistToken / auth:clear
 *     nuwax 用 localStorage.ACCESS_TOKEN（Authorization header）鉴权，非 cookie。
 *     这里把 token 按 webview 来源 origin 持久化到 settings 表（键 nuwax.accessToken.<origin>），
 *     与 sandbox ticket 隔离，实现「重启免登 / 登录持久化 / 登出联动」。
 *     主进程 AuthLifecycle 串行注册与业务服务启停；失效/换域取消在途操作。
 * - native:saveImage
 *     右键另存图片：系统保存对话框 + Node fetch。相对地址按调用方 frame origin 归一为
 *     绝对地址；鉴权依赖回环网关对目标域代注 Bearer（见 loopbackGateway/gateway.ts）。
 * - native:openWindow
 *     新开独立窗口打开 nuwax 站内页面（智能体详情/工作流/网页应用开发/我的电脑等
 *     全屏页）。带系统标题栏（零遮挡）+ 同一 webview 桥 preload；URL 追加 _shell=1
 *     让 nuwax 解除沉浸式门控。仅接受站内相对路径并校验同源。
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
 * 桥前端：preload/webviewPerfBridge.ts（注入到所有 http/https webview guest）。
 * 注册入口：ipc/index.ts 的 registerAllHandlers。
 */
import { ipcMain, dialog, BrowserWindow, webContents, app, session, screen } from "electron";
import type { IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import * as fs from "fs";
import * as path from "path";
import { saveResponse } from "../services/system/saveResponse";
import log from "electron-log";
import type { HandlerContext } from "@shared/types/ipc";
import { readSetting, writeSetting, getDb } from "../db";
import { stopAllServicesNow, restartAllServicesNow } from "./processHandlers";
import { sanitizeTitlebarDragRegions } from "@shared/utils/titlebarDragRegions";
import * as cuaComputerUse from "../services/cua/computerUse";
import * as powerPolicy from "../services/powerPolicy";
import * as fullDiskAccess from "../services/fullDiskAccess";

import {
  initializeCommercialAuth,
  currentAccessToken,
  currentBusinessOrigin,
  clearRegistration,
  writeTicketForScopes,
} from "./commercialAuth";

/** nuwax ACCESS_TOKEN 存储键前缀，按来源 origin 分域，避免污染 sandbox ticket。 */
export const NUWAX_TOKEN_KEY_PREFIX = "nuwax.accessToken.";

/** 从 IPC 调用方（webview guest）解析来源 origin 作为 token 存储作用域。 */
function resolveSenderOrigin(event: IpcMainInvokeEvent | undefined): string {
  const url = event?.senderFrame?.url || event?.sender?.getURL?.() || "";
  try {
    return url ? new URL(url).origin : "global";
  } catch {
    return "global";
  }
}

function tokenKey(scope: string): string {
  return `${NUWAX_TOKEN_KEY_PREFIX}${scope}`;
}

/** 解析 JWT sub（与 reg 的 username 同源）；opaque/坏 token 返回 null。 */
function jwtSub(token: string): string | null {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString(),
    );
    return typeof payload?.sub === "string" && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
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

/**
 * 跨 origin 候选作用域统一视图（sender → serverHost origin → 网关 origin）。
 * token 按 origin 分键存储，direct↔gateway 两形态共存期内多个键都可能被读到——
 * getToken 回退 / persistToken 双写 / clear 全清 / 网关 Bearer 代注源必须共享
 * 同一份候选集合，否则出现「写 A 读 B」的键空间分裂（网关形态新登录代注不注入、
 * 登出被回退链复活过期 token）。
 */
export function nuwaxTokenScopes(senderScope: string): string[] {
  const scopes = [senderScope];
  try {
    // 业务域候选无条件在列：与 reg 门禁/网关代注的读键（currentAccessToken →
    // currentBusinessOrigin，serverHost 缺省回落 DEFAULT_SERVER_HOST）同源。
    // 若仅在 step1_config.serverHost 存在时补列，全新安装（该字段仅打包版首启
    // 种值，dev 为空）时 persistToken 单写 sender 键 → 门禁读业务域键为空 →
    // 本地抛 "Login required"，reg 请求发不出（2026-09-14 dev 全新安装实证）。
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
  let serviceState: { phase: string; error?: string } = { phase: "stopped" };
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
      cancelTransfers();
      const scopes = nuwaxTokenScopes(currentBusinessOrigin());
      for (const scope of scopes) writeSetting(tokenKey(scope), null);
      writeTicketForScopes(scopes, null);
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
  );
  ipcMain.handle("services:syncConfig", () => lifecycle.sync());
  ipcMain.handle("services:authState", () => ({
    ...serviceState,
    loggedIn: !!currentAccessToken(),
  }));
  // 每个文档第一次 getToken 绑定会话代次。换域/登出后旧文档不能写回。
  let authGeneration = 0;
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
    !switching && documents.get(documentKey(event)) === authGeneration;
  const clearSiteStorage = async (scopes: string[]) => {
    const sessions = new Set(
      webContents.getAllWebContents().map((wc) => wc.session),
    );
    for (const ses of sessions)
      for (const origin of scopes) {
        if (/^https?:\/\//.test(origin))
          await ses.clearStorageData({
            origin,
            storages: [
              "cookies",
              "localstorage",
              "indexdb",
              "serviceworkers",
              "cachestorage",
            ],
          });
      }
  };
  // localFiles 仅保留宿主原生目录选择器：返回绝对路径，数据面由 nuwax 走
  // file-server（customTargetDir）HTTP 通道，主进程不做持久化与文件操作。
  // 注：当前 nuwax 前端已无调用方（「文件树选择非工作空间目录」需求回滚，
  // 见 nuwax/specs/luodong-delivery.md）。保留为对外桥面，避免前端需要时再动基座。
  ipcMain.handle("localFiles:pickDirectory", async () => {
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
  ipcMain.on("nuwax:theme-sync", (_event, payload: unknown) => {
    const safe =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : null;
    if (!safe || typeof safe.active !== "boolean") return;
    ctx.getMainWindow()?.webContents.send("nuwax:theme-changed", safe);
  });

  // ---- i18n：nuwax 语言变化 → 壳（UI 文案/主进程语言跟随） ----
  // nuwax 切换多语言（登录页语言开关/设置页/登录后用户资料同步）时推送当前语言，
  // 转发给壳 renderer 走与设置页同链路的应用（setCurrentLang+预拉翻译+主进程同步），
  // 不整窗 reload（避免连带重载 webview 丢会话态）。fire-and-forget。
  ipcMain.on("nuwax:lang-sync", (_event, payload: unknown) => {
    const safe =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : null;
    const lang = safe && typeof safe.lang === "string" ? safe.lang.trim() : "";
    if (!lang) return;
    log.info("[NuwaxBridge] lang-sync", { lang });
    ctx.getMainWindow()?.webContents.send("nuwax:lang-changed", { lang });
  });

  // ---- meta：nuwax 前端构建信息 → 壳（关于页「界面版本」展示） ----
  // 页面启动时上报一次 { appVersion, gitHash? }；转发给壳 renderer 存态，
  // fire-and-forget。非法载荷直接忽略。
  ipcMain.on("nuwax:web-meta", (_event, payload: unknown) => {
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
  ipcMain.on("nuwax:layout-sync", (_event, payload: unknown) => {
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
  ipcMain.on("nuwax:titlebar-drag-end", stopTitlebarDrag);
  ipcMain.on("nuwax:titlebar-toggle-maximize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  // ---- auth：登录会话 ticket cookie 同步（reg 凭据）----
  // 后端 reg 认「动态认证码或密码」不认 Bearer，全新设备无 savedKey 即 4000；
  // 解法=登录会话的 ticket cookie 同步进壳（存储/消费语义见 commercialAuth.ts
  // NUWAX_TICKET_KEY_PREFIX 注释）。主进程 session.cookies 可读 HttpOnly 与
  // 内存态 cookie；webview 无 partition=默认 session。ticket 是内存态 session
  // cookie：app 重启后 session 里即消失，持久化的 settings 值才是跨重启来源
  // （故 getToken 的后台刷新只写不清，防误清持久值）。
  const captureTicketCookie = async (
    senderScope: string,
    opts?: { clearIfAbsent?: boolean },
  ): Promise<void> => {
    const scopes = nuwaxTokenScopes(senderScope);
    const ses =
      ctx.getMainWindow()?.webContents.session ?? session.defaultSession;
    const candidates = [...new Set([...scopes, senderScope])].filter((url) =>
      /^https?:\/\//.test(url),
    );
    let found: string | null = null;
    for (const url of candidates) {
      try {
        const cookies = await ses.cookies.get({ url, name: "ticket" });
        if (cookies[0]?.value) {
          found = cookies[0].value;
          break;
        }
      } catch {
        /* session 不可用/域不合法：保持未找到 */
      }
    }
    if (found || opts?.clearIfAbsent) writeTicketForScopes(scopes, found);
    log.info("[NuwaxBridge] ticket cookie sync", {
      captured: !!found,
      clearIfAbsent: !!opts?.clearIfAbsent,
      scopes,
    });
  };

  // ---- auth：ACCESS_TOKEN 双向同步 ----
  ipcMain.handle("auth:getToken", (event) => {
    if (switching) return null;
    const scopeOrigin = resolveSenderOrigin(event);
    const loopbackOrigin = (
      readSetting("nuwax.loopback") as { origin?: string } | null
    )?.origin;
    const overrideOrigin = (
      readSetting("nuwax.webviewOverride") as { origin?: string } | null
    )?.origin;
    // webview origin 与 URL 解析（NuwaxHostWebview）恒同源：直连形态 dev 与
    // 生产一样加载业务域（serverHost/DEFAULT，dev 已不例外指 localhost:3000），
    // gateway 形态加载回环域，调试覆盖加载 override 域——三类准入项已全覆盖，
    // 不需要单独的 dev 例外项（曾有的 NUWAX_DEV_HOST 准入项随该解析分支移除；
    // 名单与解析不同源会出现登录态静默进不了壳，见 09-12/09-14 复发记录）。
    const allowedOrigins = [
      currentBusinessOrigin(),
      loopbackOrigin,
      overrideOrigin,
    ].filter(Boolean);
    // 拒绝必须留痕：此前静默 return null 零日志，断链排障只能靠 DB+代码对拍
    // （09-12/09-14 两次复发教训）。
    if (!allowedOrigins.includes(scopeOrigin)) {
      log.warn("[NuwaxBridge] auth:getToken origin 不在准入名单，拒绝", {
        scope: scopeOrigin,
        allowed: allowedOrigins,
      });
      return null;
    }
    const key = documentKey(event);
    // 代次不匹配不再拒绝且必须重注册：换域（configureServerHost）/登出
    // （auth:clear）都会 authGeneration++ 并硬重载 webview，重载后的新文档
    // 复用同一 documentKey（webContents+frame 标识），按过期文档静默拒绝的
    // 话它永远无法重新入册，persistToken 的 isCurrentDocument 守卫随之零日志
    // 静默失败——登录态进不了壳（2026-09-18 提测：改域后登录/退出重登均
    // 不同步）。getToken 本就是每文档一次的注册门：重注册即恢复写权；旧文档
    // 在途请求由上方 switching 守卫与 isCurrentDocument 迟到写保护兜底。
    if (documents.has(key) && documents.get(key) !== authGeneration) {
      log.info("[NuwaxBridge] auth:getToken 文档代次已过期，重注册", {
        key,
        authGeneration,
      });
    }
    documents.set(key, authGeneration);
    const scope = resolveSenderOrigin(event);
    // 跨 origin 回退链（nuwaxTokenScopes 统一视图）：direct↔gateway 切换后
    // sender 键为空时依次回退其余候选键，命中即回写——双向切换免重登。
    const scopes = nuwaxTokenScopes(scope);
    // 后台刷新 ticket（只写不清）：webview 重载/会话内 cookie 轮转时保持新鲜，
    // 重启后内存 cookie 消失不得误清持久值
    void captureTicketCookie(scope);
    let value = readSetting(tokenKey(scopes[0]));
    if (typeof value !== "string" || !value) {
      for (const candidate of scopes.slice(1)) {
        const fallback = readSetting(tokenKey(candidate));
        if (typeof fallback === "string" && fallback) {
          value = fallback;
          writeSetting(tokenKey(scope), fallback);
          log.info("[NuwaxBridge] auth:getToken origin 迁移回退命中", {
            from: candidate,
            to: scope,
          });
          break;
        }
      }
    }
    const loggedIn = typeof value === "string" && !!value;
    log.debug("[NuwaxBridge] auth:getToken", { scope, hasToken: loggedIn });

    // 顶栏登录态同步（以 webview 为最优先）：nuwax 启动 getInitialState 无条件调 getToken，
    // 是感知 webview 真实登录态最可靠的时机。
    // - token 在（重启免登态）→ 推 loggedIn:true。
    // - token 不在（webview 未登录）→ 推 loggedIn:false，纠正 nuwaclaw configKey 残留导致的
    //   「伪已登录」，使原生顶栏始终跟随 webview 实际状态。
    // （persistToken 只在 /Login 登录成功时触发，覆盖不了「启动即未登录」场景，故在此补全。）
    ctx.getMainWindow()?.webContents.send("nuwax:authChanged", { loggedIn });
    if (loggedIn) {
      void lifecycle.start();
      log.info(
        "[NuwaxBridge] getToken → sync header loggedIn:true (relogin-free)",
      );
    } else {
      log.info(
        "[NuwaxBridge] getToken → sync header loggedIn:false (webview not logged in)",
      );
    }
    return typeof value === "string" ? value : null;
  });

  ipcMain.handle("auth:persistToken", async (event, token: unknown) => {
    if (!isCurrentDocument(event)) return false;
    const previous = currentAccessToken();
    const scope = resolveSenderOrigin(event);
    if (typeof token !== "string" || !token) return false;
    // 双写全部候选键（sender + serverHost + 网关）：网关 Bearer 代注源读
    // serverHost/网关键，单写 sender 键会让代注拿到空/陈旧 token（键空间分裂修复）。
    const scopes = nuwaxTokenScopes(scope);
    for (const s of scopes) writeSetting(tokenKey(s), token);
    log.info("[NuwaxBridge] auth:persistToken saved", { scopes });

    // 登录时刻捕获会话 ticket cookie（await：reg 链随后即起，凭据须先落库；
    // 登录时刻即事实——找不到即清，防陈旧 ticket 顶替真实会话）
    await captureTicketCookie(scope, { clearIfAbsent: true });

    // 主进程注册成功后启动业务服务；切换 token 先取消旧代次并等待停服。
    // renderer 仅消费状态通知，不另行注册或启动。
    if (previous && previous !== token) {
      authGeneration++;
      documents.set(documentKey(event), authGeneration);
      cancelTransfers();
      // 注册凭据只在账号切换时清除（后端 reg 仍要求 savedKey，Bearer 非鉴权
      // 主体；非换账号场景清掉 = 「savedKey 只能由 reg 发放、reg 又必须要它」
      // 死局，2026-09-14 实证 token 过期重登即触发）。账号判据 = 新 token 的
      // JWT sub 对上次注册账号（auth.username；旧 token 的 sub 兜底，涵盖
      // previous 为 null 的登出后重登场景）。
      const nextSub = jwtSub(token);
      const lastAccount = readSetting("auth.username") || jwtSub(previous);
      const accountSwitched =
        !!nextSub && !!lastAccount && nextSub !== lastAccount;
      clearRegistration({ preserveSavedKey: !accountSwitched });
      log.info(
        accountSwitched
          ? "[NuwaxBridge] persistToken 账号切换，清除注册凭据"
          : "[NuwaxBridge] persistToken 同账号，保留注册凭据",
        { sub: nextSub, lastAccount },
      );
      void lifecycle.stop().then(() => lifecycle.start());
    } else {
      void lifecycle.start();
    }
    log.info(
      "[NuwaxBridge] login → renderer login-confirmed (reg+sync+restart)",
    );

    // 顶栏账号状态联动：登录成功 → 通知 renderer 顶栏切「已登录」态（跟随 nuwax token，
    // 而非 nuwaclaw 原生 configKey）。Phase 3 configKey 退役前，顶栏以此事件为准。
    ctx.getMainWindow()?.webContents.send("nuwax:authChanged", {
      loggedIn: true,
    });
    return true;
  });

  ipcMain.handle("auth:clear", async (event) => {
    if (!isCurrentDocument(event)) return false;
    authGeneration++;
    cancelTransfers();
    const stopping = lifecycle.stop();
    const scope = resolveSenderOrigin(event);
    // 全清候选键：单清 sender 键时，getToken 回退链会从 serverHost/网关键把
    // 过期 token「复活」——登出/401 后陷入 复活→401→clear 死循环（键空间分裂修复）。
    const scopes = nuwaxTokenScopes(scope);
    for (const s of scopes) writeSetting(tokenKey(s), null);
    writeTicketForScopes(scopes, null);
    log.info("[NuwaxBridge] auth:clear", { scopes });

    // 登录态以 webview 为准：登出即清壳侧登录态。注册凭据族（savedKey/
    // username）保留——登出 ≠ 注销设备，后端 reg 仍要 savedKey，清掉后同设备
    // 重登将永远无法重新注册（2026-09-14 实证）；跨账号风险由 persistToken
    // 的账号切换检测兜底（sub ≠ 上次账号 → 全清）。
    clearShellAuthState();

    clearRegistration({ preserveSavedKey: true });
    ctx
      .getMainWindow()
      ?.webContents.send("nuwax:authChanged", { loggedIn: false });
    await clearSiteStorage(scopes);
    const stopped = await stopping;
    // 重新挂载 guest，丢弃旧文档和内存认证状态；登录页可建立新文档会话。
    ctx.getMainWindow()?.webContents.send("nuwax:serverHostChanged", {});

    // 顶栏账号状态联动：登出 / token 失效 → 通知 renderer 顶栏切「去登录」态。
    ctx.getMainWindow()?.webContents.send("nuwax:authChanged", {
      loggedIn: false,
    });
    return stopped.success;
  });

  // ---- auth：企业登录（切换后端域名，客户端重新初始化） ----
  // 登录页「企业登录」入口调用：归一化并写入 step1_config.serverHost（业务域
  // 唯一事实源），清掉旧域全部派生凭据，停止全部本地服务（重新初始化语义——
  // 在跑的 lanproxy 等仍连旧域名，留着只会错乱），刷新回环网关（gateway 形态
  // 反代目标随域重指），并通知 renderer 重解析 webview URL（direct 形态即加载
  // 新域名的 /Login）。切换后 webview 在新域无 token → 登录页；登录成功经
  // persistToken → nuwax:login-confirmed → reg+重启服务，完成向新域的重新初始化。
  const configureServerHost = async (
    event: IpcMainInvokeEvent,
    input: unknown,
  ) => {
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

    if (
      !isCurrentDocument(event) &&
      event.sender !== ctx.getMainWindow()?.webContents
    )
      return { success: false, error: "Stale document" };
    switching = true;
    authGeneration++;
    cancelTransfers();
    const scopes = nuwaxTokenScopes(resolveSenderOrigin(event));
    const stopping = lifecycle.stop();
    // 换域 = 账号体系变化：全清注册凭据（与 persistToken 的账号切换、auth:clear
    // 的登出保留相对——三者语义见 clearRegistration 注释）。
    clearShellAuthState();
    clearRegistration();
    for (const scope of scopes) writeSetting(tokenKey(scope), null);
    writeTicketForScopes(scopes, null);
    // 新域历史凭据一并清理，回切也必须重新登录。
    writeSetting(tokenKey(origin), null);
    writeTicketForScopes([origin], null);
    ctx
      .getMainWindow()
      ?.webContents.send("nuwax:authChanged", { loggedIn: false });
    const previousConfig = readSetting("step1_config") as Record<
      string,
      unknown
    > | null;
    try {
      const result = await stopping;
      if (!result.success) throw new Error("Failed to stop business services");
      await clearSiteStorage([...scopes, origin]);
      const prev = readSetting("step1_config") as Record<
        string,
        unknown
      > | null;
      writeSetting("step1_config", { ...prev, serverHost: origin });
      const { refreshLoopbackGateway } =
        await import("../services/loopbackGateway");
      await refreshLoopbackGateway();
      ctx
        .getMainWindow()
        ?.webContents.send("nuwax:serverHostChanged", { serverHost: origin });
      return { success: true, serverHost: origin };
    } catch (error) {
      // 同文档允许再次操作重试，但旧 token 仍不可写回（需重新 getToken）。
      writeSetting("step1_config", previousConfig);
      ctx.getMainWindow()?.webContents.send("nuwax:serverHostChanged", {});
      return { success: false, error: String(error) };
    } finally {
      switching = false;
    }
  };
  ipcMain.handle("auth:configureServerHost", configureServerHost);
  ipcMain.handle("services:configureServerHost", configureServerHost);

  // ---- native：新开独立窗口打开 nuwax 页面 ----
  // 智能体详情/工作流/网页应用开发/我的电脑等全屏页在主窗口会被沉浸式工具栏遮挡
  //（fixed 头部/画布类布局也无法内嵌避让），改为独立窗口承载：带系统标题栏零遮挡，
  // 注入同一 webview 桥 preload（isNuwaClaw/主题等桥能力一致），URL 追加 _shell=1
  // 标记让 nuwax 解除沉浸式专属门控（菜单避让/隐藏 logo）。
  ipcMain.handle("native:openWindow", (event, opts: { path?: unknown }) => {
    try {
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

      const win = new BrowserWindow({
        width: 1280,
        height: 832,
        // 承载同一 nuwax 前端，同受 768 移动端断点约束，与主窗口共用下限
        minWidth: NUWAX_MAIN_WINDOW_MIN_WIDTH,
        minHeight: NUWAX_MAIN_WINDOW_MIN_HEIGHT,
        autoHideMenuBar: true,
        webPreferences: {
          // 与 webview guest 同一桥 preload：NuwaClawBridge 全能力（auth/theme/layout）
          preload: path.join(
            __dirname,
            "..",
            "preload",
            "webviewPerfBridge.js",
          ),
        },
      });
      shellWindows.add(win);
      win.on("closed", () => shellWindows.delete(win));
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
  ipcMain.handle("native:openClientSettings", () => {
    ctx.getMainWindow()?.webContents.send("nuwax:open-client-settings", {});
    log.info("[NuwaxBridge] native:openClientSettings");
    return { success: true };
  });

  // ---- cua：Computer Use 配置（设置页开关/状态/授权引导/首用安装；overlay 自持实现） ----
  cuaComputerUse.registerCuaQuitCleanup();
  // 允许锁屏运行：读库恢复档位并持有断言（registerAllHandlers 在 app ready 且
  // initDatabase 之后执行，此入口即 overlay 的 boot 钩子，同 ensureCuaOnBoot 先例）
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
  ipcMain.handle("cua:getStatus", () => cuaComputerUse.getCuaStatus());
  ipcMain.handle("cua:setEnabled", (_event, enabled: boolean) =>
    cuaComputerUse.setCuaEnabled(enabled === true),
  );
  ipcMain.handle("cua:requestPermissions", () =>
    cuaComputerUse.requestCuaPermissions(),
  );
  ipcMain.handle("cua:installHelper", () => cuaComputerUse.installCuaHelper());
  ipcMain.handle("cua:getVlmConfig", () => cuaComputerUse.getVlmConfig());
  ipcMain.handle("cua:setVlmConfig", (_event, patch: unknown) =>
    cuaComputerUse.setVlmConfig(
      (patch ?? {}) as { baseUrl?: string; model?: string; apiKey?: string },
    ),
  );
  ipcMain.handle("cua:testVlm", () => cuaComputerUse.testVlm());

  // ---- powerPolicy：允许锁屏运行（电源保活档位；overlay 自持实现） ----
  ipcMain.handle("powerPolicy:get", () => powerPolicy.getPowerPolicyMode());
  ipcMain.handle("powerPolicy:setMode", (_event, mode: unknown) =>
    powerPolicy.setPowerPolicyMode(mode),
  );

  // ---- fullDiskAccess：全磁盘访问状态/引导（仅 mac 有意义；overlay 自持实现） ----
  ipcMain.handle("fullDiskAccess:getStatus", () =>
    fullDiskAccess.getFullDiskAccessStatus(),
  );
  ipcMain.handle("fullDiskAccess:openSettings", () =>
    fullDiskAccess.openFullDiskAccessSettings(),
  );
  ipcMain.handle("fullDiskAccess:recheck", async () => {
    const granted = await fullDiskAccess.checkFullDiskAccess();
    return {
      supported: fullDiskAccess.isFullDiskAccessSupported(),
      granted,
    };
  });

  // ---- native：右键另存图片 ----
  ipcMain.handle(
    "native:saveImage",
    async (event, opts: { url: string; filename?: string }) => {
      const generation = authGeneration;
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
          target = new URL(url, event.senderFrame?.url || undefined);
        } catch {
          return { success: false, error: "invalid url" };
        }
        if (!/^https?:$/.test(target.protocol)) {
          return { success: false, error: "unsupported protocol" };
        }

        // 默认文件名：URL 末段；非法文件名字符替换为下划线；无扩展名补 .png
        const derived =
          filename ||
          decodeURIComponent(target.pathname.split("/").pop() || "") ||
          "image";
        const safeName = derived.replace(/[\\/:*?"<>|]/g, "_").slice(0, 120);
        const ext = path.extname(safeName) ? "" : ".png";
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

        const signal = AbortSignal.any([
          transferSignal,
          AbortSignal.timeout(120_000),
        ]);
        let destination = target;
        let resp: Response | undefined;
        for (let redirects = 0; redirects <= 5; redirects++) {
          if (generation !== authGeneration || switching)
            throw new Error("Session changed");
          const token =
            destination.origin === currentBusinessOrigin()
              ? currentAccessToken()
              : null;
          // Electron net.fetch rejects manual redirects before exposing the 302.
          // Node fetch preserves the response so every hop can recheck origin/auth.
          resp = await globalThis.fetch(destination.toString(), {
            method: "GET",
            redirect: "manual",
            signal,
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          });
          if (![301, 302, 303, 307, 308].includes(resp.status)) break;
          const location = resp.headers.get("location");
          await resp.body?.cancel();
          if (!location || redirects === 5)
            throw new Error("Invalid image redirect");
          destination = new URL(location, destination);
          if (!/^https?:$/.test(destination.protocol))
            throw new Error("Unsupported redirect protocol");
        }
        if (generation !== authGeneration || switching)
          throw new Error("Session changed");
        await saveResponse(resp!, res.filePath, signal, "binary");
        const bytes = fs.statSync(res.filePath).size;
        log.info("[NuwaxBridge] native:saveImage saved", {
          path: res.filePath,
          bytes,
        });
        return { success: true, path: res.filePath };
      } catch (error) {
        log.error("[NuwaxBridge] native:saveImage failed", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
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
  ipcMain.handle("nuwax:webview-nav-state", () => readNavState());
  ipcMain.handle("nuwax:webview-nav-go", (_event, dir: unknown) => {
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
}
