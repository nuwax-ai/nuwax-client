/**
 * Loopback Gateway 编排：按 step1_config.nuwaxLoadMode（'direct' | 'gateway'，
 * 缺省 direct——不配置即完全维持现状）决定是否起网关；env NUWAX_LOOPBACK=1
 * 可强制开启（开发验收用）。
 *
 * 【overlay 商业实现】本文件经商业 overlay（Nuwax）覆写基座 no-op 插槽
 * （基座 services/loopbackGateway/index.ts）；导出面必须保持兼容
 * （stopLoopbackGateway / refreshLoopbackGateway）。
 *
 * 运行时真值写 settings 键 `nuwax.loopback` = { enabled, origin }：
 * renderer（NuwaxHostWebview）免新 IPC 面直接读，enabled 时 webview 从网关
 * origin 加载 nuwax。业务请求经主进程授权后从当前业务域镜像注入 ticket。
 *
 * dist 目录来源（dev）：优先 NUWAX_FRONTEND_DIST env（in-base.js 注入 =
 * 外层 nuwax-dist 产物子模块）；缺省回落外层根的 nuwax-dist。
 * 打包形态恒为 resources/nuwax-dist（CI extraResources 注入）。
 */
import { app, session, webContents } from "electron";
import log from "electron-log";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { randomBytes } from "node:crypto";
import { readSetting, writeSetting } from "../../db";
import { DEFAULT_SERVER_HOST } from "@shared/constants";
import { currentTicket, mirrorGatewaySetCookies, ticketEpoch, setLoopbackTicketOrigin, advanceTicketEpoch, abortGatewayTicketMirror } from "../commercialTicketSession";
import { getConfiguredPorts } from "../startupPorts";
import {
  startLoopbackGateway,
  DEFAULT_BACKEND_PREFIXES,
  type LoopbackGatewayHandle,
} from "./gateway";
import { normalizeGatewayRequestUrl } from "./routingPolicy";
import { setGatewayRequestContext } from "./requestContext";
import { parseTicketSetCookie } from "../ticketCookiePolicy";

export const DEFAULT_LOOPBACK_GATEWAY_PORT = 46800;

/**
 * dist 形态额外反代的后端微应用文档根：list-menu 下发的
 * 消息（/instant-message）与资料库（/repo）是业务域上的独立微应用，iframe src
 * 为后端域绝对 URL，本应直连业务域——但 dist 形态的绝对 URL 归一钩子会把
 * 指向后端域的请求重定向回网关 origin，这些路径若不在反代前缀里会被本地
 * dist 托管兜住：无点深链 SPA 回退成 nuwax 首页（nuwax 路由无此路由 →
 * 前端 404 页），带点资源直接 404。生态市场是 %siteUrl%/api/eco/redirect，
 * 落在 /api 前缀内 302 到自有域，不在此列。消息/资料库接入方案后续将大改
 * （qiankun 微前端），届时接入形态变化须复核本清单；新增微应用文档根用 env
 * NUWAX_GATEWAY_EXTRA_BACKEND_PREFIXES（逗号分隔，如 "/im,/wiki"）免重建追加。
 */
const MICROAPP_BACKEND_PREFIXES = ["/instant-message", "/repo"];

/** env 追加前缀：剥尾斜杠，仅收 `/` 开头且非裸 `/` 的路径段（组装处统一去重）。 */
function resolveExtraBackendPrefixes(): string[] {
  const raw = (process.env.NUWAX_GATEWAY_EXTRA_BACKEND_PREFIXES || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((p) => p.trim().replace(/\/+$/, ""))
    .filter((p) => p.startsWith("/") && p.length > 1);
}

/** dev（未打包）gateway 形态的页面反代目标：本地 nuwax dev server（前端 vite）；
 * 直连形态 dev 已不加载此地址（走 serverHost，2026-09-18 起）。可 env 覆盖。 */
const DEV_TARGET = "http://localhost:3000";

/** 运行时键（renderer 读；enabled=false 时同时用于清理残留）。 */
export const LOOPBACK_RUNTIME_KEY = "nuwax.loopback";

/**
 * 调试覆盖前端域名（.env / 启动 env `NUWAX_WEBVIEW_ORIGIN`）→ 运行时键。
 * 设置时 webview 强制加载该前端源（如本地 nuwax dev server）；**后端域不受
 * 影响**，仍按 serverHost 前后端一体语义解析（§6）。未设置清键 = 前后端同域。
 * renderer（nodeIntegration 关闭读不到 env）经 settings 读此键。
 */
export const WEBVIEW_OVERRIDE_KEY = "nuwax.webviewOverride";

export function syncWebviewOverrideFromEnv(): void {
  const raw = (process.env.NUWAX_WEBVIEW_ORIGIN || "")
    .trim()
    .replace(/\/+$/, "");
  const origin =
    raw && /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
      ? raw
      : raw
        ? `https://${raw}`
        : null;
  writeSetting(WEBVIEW_OVERRIDE_KEY, { origin });
  if (origin) {
    log.info(
      `[WebviewOverride] NUWAX_WEBVIEW_ORIGIN 生效：webview 将加载 ${origin}（后端域不变）`,
    );
  }
}

interface Step1GatewayFields {
  nuwaxLoadMode?: "direct" | "gateway";
  gatewayPort?: number;
  serverHost?: string;
}

let running: LoopbackGatewayHandle | undefined;
// 起停、设置刷新共用队列，迟到 start 不能越过 stop；失败不阻塞下一轮。
let lifecycleQueue: Promise<unknown> = Promise.resolve();
function enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const result = lifecycleQueue.then(operation);
  lifecycleQueue = result.catch(() => undefined);
  return result;
}

/** 网关是否处于启用态（step1 配置或 env 强制）。 */
export function isLoopbackGatewayEnabled(): boolean {
  // 显式配置优先（设置里「本地化加速」开关落此键）；env 仅作未配置时的缺省
  const step1 = readSetting("step1_config") as Step1GatewayFields | null;
  if (step1?.nuwaxLoadMode) return step1.nuwaxLoadMode === "gateway";
  return process.env.NUWAX_LOOPBACK === "1";
}

/** 透明反代目标 origin：dev（未打包）联调 localhost:3000（NUWAX_LOOPBACK_TARGET
 *  可覆盖）；生产反代 step1_config.serverHost / DEFAULT_SERVER_HOST。 */
function resolveTargetOrigin(): string {
  if (!app.isPackaged) {
    return process.env.NUWAX_LOOPBACK_TARGET || DEV_TARGET;
  }
  return resolveBackendOrigin();
}

/** 后端 origin（dist 模式的 /api 反代目标与 cookie 会话源）：一律真实后端
 *  （serverHost / DEFAULT_SERVER_HOST，NUWAX_LOOPBACK_TARGET 可覆盖）——
 *  dev 缺省的 localhost:3000 是 nuwax dev server，不是 API 后端。 */
function resolveBackendOrigin(): string {
  if (process.env.NUWAX_LOOPBACK_TARGET)
    return process.env.NUWAX_LOOPBACK_TARGET;
  const step1 = readSetting("step1_config") as Step1GatewayFields | null;
  const raw = (step1?.serverHost || DEFAULT_SERVER_HOST)
    .trim()
    .replace(/\/+$/, "");
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
}

/** dist 目录解析：dev 优先 NUWAX_FRONTEND_DIST（壳根 nuwax-dist），回落外层
 * 产物子模块（nuwax-client/nuwax-dist）；打包 = resources/nuwax-dist。 */
export function resolveNuwaxDistDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "nuwax-dist");
  }
  const fromEnv = (process.env.NUWAX_FRONTEND_DIST || "").trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  // dev：app path = crates/agent-electron-client → 外层根/nuwax-dist
  return path.resolve(app.getAppPath(), "..", "..", "..", "nuwax-dist");
}

function distDirAvailable(): boolean {
  try {
    return fs.existsSync(path.join(resolveNuwaxDistDir(), "index.html"));
  } catch {
    return false;
  }
}

/** dist 模式开关：显式 env（dev 验收）或 nuwaxLoadMode='gateway' 且 dist 就绪。 */
function isDistModeEnabled(): boolean {
  if (process.env.NUWAX_LOOPBACK_DIST === "1") return true;
  const step1 = readSetting("step1_config") as Step1GatewayFields | null;
  return step1?.nuwaxLoadMode === "gateway" && distDirAvailable();
}

/** 本地目标判定：目标是本地 dev server 时无需网关（本地源不存在云端域绑定问题，
 *  直连即得原始 dev 体验——HMR 等不经代理层）。 */
function isLocalTarget(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

/** TCP 可达性探测（dev：nuwax dev server 在线与否决定直连还是回落 dist）。 */
function isOriginReachable(origin: string, timeoutMs = 600): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const url = new URL(origin);
      const sock = net.connect(
        { port: Number(url.port) || 80, host: url.hostname },
        () => {
          sock.destroy();
          resolve(true);
        },
      );
      sock.setTimeout(timeoutMs, () => {
        sock.destroy();
        resolve(false);
      });
      sock.on("error", () => {
        sock.destroy();
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

/** 幂等启动：未启用时清运行时键并静默返回。失败仅告警，不阻断客户端启动。
 *  形态优先级（dev 语义）：nuwax dev server 在线 → webview 直连（原始 dev 体验）；
 *  不在线且 dist 就绪 → dist 形态（子模块本地 nuwax，make electron-dev 随时可见
 *  完整客户端）；远程目标 → 透明反代。 */
async function ensureLoopbackGatewayNow(): Promise<
  LoopbackGatewayHandle | undefined
> {
  if (running) return running;
  if (!isLoopbackGatewayEnabled()) {
    // backend 随键携带：direct 模式下域名变更也触发 renderer 重载 webview
    writeSetting(LOOPBACK_RUNTIME_KEY, {
      enabled: false,
      origin: null,
      backend: resolveBackendOrigin(),
    });
    return undefined;
  }
  let distMode = isDistModeEnabled();
  const backendOrigin = resolveBackendOrigin();
  let targetOrigin = distMode ? backendOrigin : resolveTargetOrigin();
  if (!distMode && isLocalTarget(targetOrigin)) {
    if (await isOriginReachable(targetOrigin)) {
      log.info(
        `[LoopbackGateway] 目标为本地 dev server（${targetOrigin}），跳过网关——webview 直连`,
      );
      writeSetting(LOOPBACK_RUNTIME_KEY, {
        enabled: false,
        origin: null,
        backend: resolveBackendOrigin(),
      });
      return undefined;
    }
    if (distDirAvailable()) {
      // nuwax dev server 不在线：回落 dist 形态（显式 NUWAX_LOOPBACK_DIST 已在
      // 上方 isDistModeEnabled 命中；此处覆盖 dev 缺省目标为 dist）。
      distMode = true;
      targetOrigin = backendOrigin;
      log.info(
        `[LoopbackGateway] 本地 dev server 不在线，回落 dist 形态（子模块本地 nuwax）`,
      );
    } else {
      log.info(
        `[LoopbackGateway] 目标为本地 dev server（${targetOrigin}）且不在线、dist 未就绪——先执行 git submodule update --init nuwax-dist；webview 直连（等待 nuwax dev server）`,
      );
      writeSetting(LOOPBACK_RUNTIME_KEY, {
        enabled: false,
        origin: null,
        backend: resolveBackendOrigin(),
      });
      return undefined;
    }
  }
  const step1 = readSetting("step1_config") as Step1GatewayFields | null;
  // 端口校验：配置值可能与服务端口族冲突（如误填 ttyd 默认口 60009——会反把
  // ttyd 挤掉）或越界，一律回落默认 46800 并告警。
  const configured = step1?.gatewayPort;
  let fixedPort = DEFAULT_LOOPBACK_GATEWAY_PORT;
  if (configured !== undefined) {
    const servicePorts = Object.values(getConfiguredPorts()).filter(
      (p): p is number => typeof p === "number",
    );
    if (
      !Number.isInteger(configured) ||
      configured < 1024 ||
      configured > 65535 ||
      servicePorts.includes(configured) ||
      configured === DEFAULT_LOOPBACK_GATEWAY_PORT + 1 // 46801 = nuwax-desktop 原型占用
    ) {
      log.warn(
        `[LoopbackGateway] gatewayPort=${configured} 非法/与服务端口冲突，回落 ${DEFAULT_LOOPBACK_GATEWAY_PORT}`,
      );
    } else {
      fixedPort = configured;
    }
  }
  try {
    const requestSecret = randomBytes(32).toString("hex");
    running = await startLoopbackGateway({
      targetOrigin,
      distDir: distMode ? resolveNuwaxDistDir() : undefined,
      fixedPort,
      // 缺省三前缀 + 外链菜单微应用前缀 + env 追加（Set 去重防重叠）
      backendPrefixes: [
        ...new Set([
          ...DEFAULT_BACKEND_PREFIXES,
          ...MICROAPP_BACKEND_PREFIXES,
          ...resolveExtraBackendPrefixes(),
        ]),
      ],
      getTicket: currentTicket,
      ticketEpoch,
      onSetCookie: async (headers, epoch, login) => {
        // A successful login invalidates renewals from requests belonging to
        // the previous account, even if those responses arrive afterward.
        // A response from a login superseded by logout or another login must
        // never advance the epoch and restore its cookie.
        if (epoch !== ticketEpoch()) return false;
        if (login && headers.some((header) => parseTicketSetCookie(header, backendOrigin).kind === "valid")) advanceTicketEpoch();
        const mirrorEpoch = ticketEpoch();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            mirrorGatewaySetCookies(headers, backendOrigin, mirrorEpoch),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error("ticket mirror timed out")), 3000);
            }),
          ]);
        } catch (error) {
          if (ticketEpoch() === mirrorEpoch) abortGatewayTicketMirror(backendOrigin);
          log.error("[LoopbackGateway] ticket mirror failed", error);
          throw error;
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
      trustedRequestSecret: requestSecret,
    });
    await setLoopbackTicketOrigin(running.origin);
    // Cookie 镜像也是 await；关闭意图可能在 start 或镜像期间到达。
    if (!isLoopbackGatewayEnabled()) {
      await stopLoopbackGatewayNow();
      writeSetting(LOOPBACK_RUNTIME_KEY, {
        enabled: false,
        origin: null,
        backend: resolveBackendOrigin(),
      });
      return undefined;
    }
    setGatewayRequestContext({ origin: running.origin, requestSecret });
    if (distMode) {
      startAbsoluteUrlNormalization(running.origin, backendOrigin);
    }
    writeSetting(LOOPBACK_RUNTIME_KEY, {
      enabled: true,
      origin: running.origin,
      mode: running.mode,
      // 后端域随键落库：refreshLoopbackGateway 以此做变更检测——仅域名变化
      // （网关 origin/形态不变）也能触发 renderer 重载 webview。serverHost 是
      // 前后端一体域名（见设计文档 §6），域名变更=后端已换，页面必须重载。
      backend: backendOrigin,
    });
    return running;
  } catch (e) {
    setGatewayRequestContext(null);
    log.warn("[LoopbackGateway] start failed (non-fatal):", e);
    writeSetting(LOOPBACK_RUNTIME_KEY, {
      enabled: false,
      origin: null,
      backend: resolveBackendOrigin(),
      error: "Loopback gateway failed to start",
    });
    return undefined;
  }
}

/** dist 模式 URL 归一：文档保持 pathname；可信微应用 frame 的后端资源进入
 *  命名空间。跨 origin fetch 重定向仍受 CORS 检查，session 附的私有 capability
 *  由 gateway 响应层验证；不能把 redirect 当成消除 CORS 的手段。 */
let normalizationActive = false;
function startAbsoluteUrlNormalization(
  gatewayOrigin: string,
  backendOrigin: string,
): void {
  try {
    const backendPrefixes = [
      ...DEFAULT_BACKEND_PREFIXES,
      ...MICROAPP_BACKEND_PREFIXES,
      ...resolveExtraBackendPrefixes(),
    ];
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
      (details, callback) => {
        // 仅 webview guest（发起页 origin = 网关 origin）的绝对 URL 归一。
        // 壳 renderer（vite origin）直连后端的 API 不归一——壳 API 域名与后端
        // 同域时全量误伤：重定向进网关后后端回 ACAO=后端域 ≠ 壳 origin，
        // preflight 直接被 CORS 拦死（i18n/sandbox reg 等全挂）。
        try {
          const wc = details.webContentsId
            ? webContents.fromId(details.webContentsId)
            : null;
          const redirectURL = normalizeGatewayRequestUrl(
            {
              url: details.url,
              resourceType: details.resourceType,
              webContentsUrl: wc?.getURL() ?? "",
              frameUrl: details.frame?.url,
              parentFrameUrl: details.frame?.parent?.url,
              referrer: details.referrer,
            },
            { gatewayOrigin, backendOrigin, backendPrefixes },
          );
          if (redirectURL) {
            callback({ redirectURL });
            return;
          }
        } catch {
          /* webContents 可能已销毁——按非 guest 放行 */
        }
        callback({});
      },
    );
    normalizationActive = true;
    log.info(
      `[LoopbackGateway] 后端 URL 归一 → ${gatewayOrigin}（${backendOrigin}）`,
    );
  } catch (e) {
    log.warn("[LoopbackGateway] 绝对 URL 归一注册失败:", e);
  }
}

function stopAbsoluteUrlNormalization(): void {
  if (!normalizationActive) return;
  try {
    session.defaultSession.webRequest.onBeforeRequest(
      null as never,
      null as never,
    );
  } catch {
    /* 旧版签名差异时忽略（退出路径） */
  }
  normalizationActive = false;
}

async function stopLoopbackGatewayNow(): Promise<void> {
  setGatewayRequestContext(null);
  await setLoopbackTicketOrigin(null);
  if (!running) return;
  const handle = running;
  running = undefined;
  stopAbsoluteUrlNormalization();
  await handle.close();
  writeSetting(LOOPBACK_RUNTIME_KEY, { enabled: false, origin: null });
  log.info("[LoopbackGateway] stopped");
}

export function loopbackGatewayStatus(): {
  running: boolean;
  origin?: string;
  mode?: "dist" | "proxy";
} {
  return running
    ? { running: true, origin: running.origin, mode: running.mode }
    : { running: false };
}

/**
 * 配置变更后的网关刷新（settings 保存/restartAll 钩子调用）：
 * 停掉在跑实例 → 按当前配置重确保（direct 即停、gateway/dist 重起）→
 * 运行时键实际变化才通知 renderer 重解析 webview URL（形态/后端/域名已变）。
 * 无变化不广播：webview 收到后会 setUrl("") 硬重载——闪白且丢失页面内状态，
 * 登录成功等场景（direct→direct 域名未变）不应触发。
 */
async function refreshLoopbackGatewayNow(): Promise<void> {
  // env 调试旋钮接线：每次 refresh（启动 + 配置变更）把 NUWAX_WEBVIEW_ORIGIN
  // 同步进运行时键（renderer 关 nodeIntegration 读不到 env，经键传递）。
  // 未设置写 {origin:null}——env 是权威源，顺带清掉手动种的残留 override。
  // 此前 syncWebviewOverrideFromEnv 无任何调用方，旋钮自 f68964eb 起失效。
  syncWebviewOverrideFromEnv();
  const before = JSON.stringify(readSetting(LOOPBACK_RUNTIME_KEY) ?? null);
  await stopLoopbackGatewayNow();
  await ensureLoopbackGatewayNow();
  const state = readSetting(LOOPBACK_RUNTIME_KEY) as {
    enabled?: boolean;
    error?: string;
  } | null;
  if (state?.error) throw new Error(state.error);
  const after = JSON.stringify(readSetting(LOOPBACK_RUNTIME_KEY) ?? null);
  if (before === after) return;
  try {
    // 动态 import 避免模块加载期与 electron 的循环依赖（主进程既有惯例）；
    // 相比 require 在 ESM（单测）环境下同样可用
    const { BrowserWindow } = await import("electron");
    const win = BrowserWindow.getAllWindows()[0];
    const loopback = readSetting(LOOPBACK_RUNTIME_KEY);
    win?.webContents.send("nuwax:loopback-changed", loopback);
  } catch {
    /* 窗口不存在时忽略 */
  }
}

export function ensureLoopbackGateway(): Promise<LoopbackGatewayHandle | undefined> {
  return enqueueLifecycle(ensureLoopbackGatewayNow);
}

export function stopLoopbackGateway(): Promise<void> {
  return enqueueLifecycle(stopLoopbackGatewayNow);
}

export function refreshLoopbackGateway(): Promise<void> {
  return enqueueLifecycle(refreshLoopbackGatewayNow);
}
