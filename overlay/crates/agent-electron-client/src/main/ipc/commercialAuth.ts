import { app, net } from "electron";
import * as os from "os";
import log from "electron-log";
import { readSetting, writeSetting, getDb } from "../db";
import {
  LOCAL_HOST_URL,
  DEFAULT_GUI_MCP_PORT,
  TEST_SERVER_HOST,
} from "@shared/constants";
import { getConfiguredPorts } from "../services/startupPorts";
import { currentBusinessOrigin, readTicketCookieValue } from "../services/commercialSessionScope";
import { nativeTicketHeaders } from "../services/nativeTicketCapability";
export { currentBusinessOrigin, readTicketCookieValue } from "../services/commercialSessionScope";
import { getDeviceId } from "../services/system/deviceId";
import { stopDaemon } from "../services/cua/computerUse";
import {
  AuthLifecycle,
  setCommercialLifecycle,
  type ServiceResult,
} from "../services/auth/lifecycle";

/** 注册上报的电脑名（三平台）：os.hostname 通吃 macOS/Windows/Linux，
 * 仅剥 macOS Bonjour 的 .local 尾巴（DONG-MBP128.local → DONG-MBP128）。 */
export function getComputerName(): string {
  return os.hostname().replace(/\.local$/i, "").trim();
}
/**
 * nuwax web 登录会话 ticket cookie（服务端 Set-Cookie，内存态 session cookie）。
 *
 * 后端 reg 把「动态认证码或密码」当鉴权主体（Bearer 不算数）——全新设备无
 * savedKey 时 4000「动态认证码或密码不能为空」（2026-09-14 新装实测）。解法
 * （产品拍板）：登录会话的 ticket cookie 同步进壳、reg 请求附 Cookie——后端
 * 认会话即可放行首次设备注册。
 *
 * 主进程按当前业务 origin 保存 cookie 镜像，直连与回环模式共用该事实源；
 * 回环 cookie 由网关响应和镜像模块同步，注册请求从业务域镜像取值。
 */
/**
 * 清注册派生凭据（configKey/savedKey/lanproxy 指针）。
 *
 * preserveSavedKey（默认 false=全清）：后端 reg 仍要求 savedKey（Bearer 非鉴权
 * 主体，缺省即「动态认证码或密码不能为空」），而 savedKey 只能由 reg 成功发放
 * ——非换账号场景清掉它 = 此后永远无法重新注册（2026-09-14 实证）。因此
 * 「token 过期重登 / 显式登出 / 设备盐变更」一律保留；仅账号体系变化（换账号
 * 登录、换域）由调用方判账号切换后全清，防跨账号串用。savedKey+username 是
 * 「设备×账号」维度的注册凭据族，成对保留/清除。
 */
export function clearRegistration(
  opts?: { preserveSavedKey?: boolean },
): void {
  const legacySavedKey = readSetting("auth.saved_key");
  const legacyUsername = readSetting("auth.username");
  for (const key of [
    "auth.config_key",
    "auth.saved_key",
    "auth.username",
    "auth.token",
    "auth.online_status",
    "lanproxy.server_host",
    "lanproxy.server_port",
  ])
    writeSetting(key, null);
  getDb()
    ?.prepare(
      "DELETE FROM settings WHERE key LIKE 'auth.saved_keys.%' OR key LIKE 'auth.tokens.%'",
    )
    .run();
  const lp = (readSetting("lanproxy_config") || {}) as Record<string, unknown>;
  const preferences = { ...lp };
  delete preferences.serverIp;
  delete preferences.serverPort;
  delete preferences.clientKey;
  writeSetting("lanproxy_config", preferences);
  if (opts?.preserveSavedKey) {
    if (legacySavedKey != null) writeSetting("auth.saved_key", legacySavedKey);
    if (legacyUsername != null) writeSetting("auth.username", legacyUsername);
  }
}
/** 「本地化默认开」一次性迁移旗标（存量库 direct→gateway 只强制这一次）。 */
const LOADMODE_DEFAULT_MIGRATED_KEY = "nuwax.loadModeDefaultMigrated";

export function initializeCommercialAuth(
  start: (signal: AbortSignal) => Promise<ServiceResult>,
  stop: () => Promise<ServiceResult>,
  changed: (phase: string, error?: string) => void,
  expired?: () => void,
) {
  // Cookie auth is intentionally incompatible with legacy token-only sessions.
  // Delete both the token and the old token-paired ticket mirror once, then
  // require a fresh backend Set-Cookie login. Registration keys are preserved.
  if (!readSetting("nuwax.cookieAuthMigrated")) {
    getDb()?.prepare("DELETE FROM settings WHERE key LIKE 'nuwax.accessToken.%' OR key LIKE 'nuwax.ticket.%' OR key LIKE 'nuwax.ticketMeta.%'").run();
    writeSetting("nuwax.cookieAuthMustRelogin", true);
    writeSetting("nuwax.cookieAuthMigrated", true);
  }
  // 新安装使用随包前端，离线也能打开登录/企业域名配置；已有模式偏好保留。
  // 默认域=测试环境（2026-09-17 测试期拍板，商业专属逻辑故落 overlay 种子而非
  // 基座常量）；恢复正式环境改回 DEFAULT_SERVER_HOST 即可。dev 全新库同样
  // 种值：不种则业务域候选/注册回落 DEFAULT_SERVER_HOST（生产域），与 dev 前端
  // 联调的测试域 token 错域。NUWAX_SERVER_HOST 指定业务域；两种形态都默认
  // 种 gateway（本地化默认开）——dev 直连联调走 NUWAX_WEBVIEW_ORIGIN，其
  // 优先级高于 loopback，不受影响。
  const devSeedHost = process.env.NUWAX_SERVER_HOST?.trim();
  const seeded = readSetting("step1_config") as {
    serverHost?: string;
  } | null;
  if (!seeded) {
    if (app?.isPackaged) {
      writeSetting("step1_config", {
        serverHost: TEST_SERVER_HOST,
        nuwaxLoadMode: "gateway",
      });
    } else if (devSeedHost) {
      writeSetting("step1_config", {
        serverHost: devSeedHost,
        nuwaxLoadMode: "gateway",
      });
    }
  } else if (!seeded.serverHost) {
    // serverHost backfill：真实时序里 ensureDefaultWorkspaceDir（migrate）
    // 先写 step1_config（workspaceDir），上面的「首启种子」恒不命中——全新
    // 安装 serverHost 缺失回落 DEFAULT_SERVER_HOST（生产域），测试期默认
    // 测试域的拍板被架空（2026-09-18 提测实证）。凡「配置行存在但域名从未
    // 显式落值」即补种子值（打包=测试域 / dev=NUWAX_SERVER_HOST）；改过域
    // （configureServerHost 落值）不受影响。存量 v1.0.14 测试装机升级后同样
    // 被 backfill。恢复正式环境时本处种子值随首启种子一并改回 DEFAULT。
    const backfillHost = app?.isPackaged ? TEST_SERVER_HOST : devSeedHost;
    if (backfillHost) {
      writeSetting("step1_config", { ...seeded, serverHost: backfillHost });
      log.info(
        "[CommercialAuth] step1_config 存在但缺 serverHost，backfill 默认域",
        { serverHost: backfillHost },
      );
    }
  }
  // 存量库一次性对齐「本地化默认开」（2026-09-17 拍板）：历史库存在未操作
  // 也落 direct 的值（09-14 排障实证），与用户显式关闭不可区分，故以旗标
  // 只强制这一次；此后设置页的关闭（direct）不再被覆盖。
  const existingStep1 = readSetting("step1_config") as {
    nuwaxLoadMode?: "direct" | "gateway";
  } | null;
  if (
    existingStep1 &&
    readSetting(LOADMODE_DEFAULT_MIGRATED_KEY) == null &&
    existingStep1.nuwaxLoadMode !== "gateway"
  ) {
    writeSetting("step1_config", {
      ...existingStep1,
      nuwaxLoadMode: "gateway",
    });
    log.info(
      "[CommercialAuth] 默认开启本地化：存量库 nuwaxLoadMode 迁移为 gateway",
    );
  }
  if (existingStep1) writeSetting(LOADMODE_DEFAULT_MIGRATED_KEY, true);
  const deviceId = getDeviceId();
  if (readSetting("nuwax.registrationDeviceId") !== deviceId) {
    // 设备身份盐变更（1.0.4 起 nuwax:device:v1）/换设备时清注册派生凭据，
    // 但保留 savedKey：现行后端注册必须携带 savedKey（首登 Bearer-only 返回
    // 4000），且实测接受「旧 savedKey + 新 deviceId」重注册——若一并清掉，
    // 1.0.3 存量用户升级后将永远无法重新注册（savedKey 无处再获取）。
    clearRegistration({ preserveSavedKey: true });
    writeSetting("nuwax.registrationDeviceId", deviceId);
  }
  const flow = new AuthLifecycle({
    authenticated: () => !!readTicketCookieValue([currentBusinessOrigin()]),
    register: async (signal: AbortSignal) => {
      const origin = currentBusinessOrigin();
      let ticket = readTicketCookieValue([origin]);
      if (!ticket) throw new Error("Login required");
      const ticketSession = await import("../services/commercialTicketSession");
      const requestEpoch = ticketSession.ticketEpoch();
      const ports = getConfiguredPorts();
      const sessionResponse = await net.fetch(`${origin}/api/user/getLoginInfo`, {
        method: "GET", redirect: "error", credentials: "omit",
        headers: { ...nativeTicketHeaders(ticket), "x-client-type": "nuwax" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
      await ticketSession.mirrorNativeResponseTicket(sessionResponse, origin, requestEpoch);
      if (sessionResponse.status === 401) expired?.();
      ticket = readTicketCookieValue([origin]);
      if (!ticket) throw new Error("Session expired during registration");
      if (!sessionResponse.ok) throw new Error(`Session HTTP ${sessionResponse.status}`);
      const sessionPayload = await sessionResponse.json();
      const username = sessionPayload?.data?.userName;
      if (sessionPayload?.code !== "0000" || typeof username !== "string" || !username)
        throw new Error("Cookie session is not authenticated");
      if (origin !== currentBusinessOrigin() || ticket !== readTicketCookieValue([origin]))
        throw new Error("Session changed during registration");
      const savedKey = readSetting("auth.saved_key");
      const response = await net.fetch(`${origin}/api/sandbox/config/reg`, {
        method: "POST",
        redirect: "error",
        // net.fetch otherwise adds defaultSession's jar cookie even when our
        // paired mirror was rejected. Only the explicit, token-matched ticket
        // below may authenticate registration (Electron retains it with omit).
        credentials: "omit",
        headers: {
          "Content-Type": "application/json",
          "x-client-type": "nuwax",
          ...nativeTicketHeaders(ticket),
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        body: JSON.stringify({
          username,
          password: "",
          ...(savedKey ? { savedKey } : {}),
          deviceId,
          computerName: getComputerName(),
          sandboxConfigValue: {
            hostWithScheme: LOCAL_HOST_URL,
            agentPort: ports.agent,
            vncPort: 0,
            fileServerPort: ports.fileServer,
            guiMcpPort: DEFAULT_GUI_MCP_PORT,
            adminServerPort: ports.agent,
            ttydPort: ports.ttyd,
            apiKey: "",
            maxUsers: 1,
          },
        }),
      });
      await ticketSession.mirrorNativeResponseTicket(response, origin, requestEpoch);
      if (response.status === 401) expired?.();
      ticket = readTicketCookieValue([origin]);
      if (!ticket) throw new Error("Session expired during registration");
      signal.throwIfAborted();
      if (origin !== currentBusinessOrigin() || ticket !== readTicketCookieValue([origin]))
        throw new Error("Session changed during registration");
      if (!response.ok) throw new Error(`Registration HTTP ${response.status}`);
      const payload = await response.json();
      signal.throwIfAborted();
      if (origin !== currentBusinessOrigin() || ticket !== readTicketCookieValue([origin]))
        throw new Error("Session changed during registration");
      if (["4010", "4011"].includes(payload.code)) expired?.();
      if (payload.code !== "0000")
        throw new Error(payload.message || `Registration ${payload.code}`);
      const value = payload.data;
      if (
        !value?.configKey ||
        !value?.serverHost ||
        !Number.isInteger(value?.serverPort) ||
        value.serverPort <= 0 ||
        value.serverPort > 65535
      )
        throw new Error("Incomplete registration response");
      return { ...value, origin, username };
    },
    commit: (value) => {
      writeSetting("auth.config_key", value.configKey);
      writeSetting("auth.saved_key", value.configKey);
      writeSetting("auth.username", value.username);
      writeSetting("auth.online_status", value.online);
      writeSetting("auth.user_info", {
        id: value.id,
        username: value.username,
        displayName: value.name,
        currentDomain: value.origin,
      });
      writeSetting("lanproxy.server_host", value.serverHost);
      writeSetting("lanproxy.server_port", value.serverPort);
      writeSetting("lanproxy_config", {
        ...((readSetting("lanproxy_config") as object) || {}),
        serverIp: value.serverHost.replace(/^https?:\/\//, ""),
        serverPort: value.serverPort,
        enabled: true,
      });
      // 注册返回的 ticket 不覆盖 ACCESS_TOKEN；商业版仅由网页登录建立登录态。
    },
    start,
    stop,
    changed,
    // 退出期附加清理：CUA daemon 不随引擎树/进程注册表回收（detached/PPID=1），
    // 由 before-quit 的 cleanupAllProcesses 经本钩子停止（will-quit 钩子在
    // app.exit(0) 主退出路径上不触发，双触发幂等）。
    stopExtras: () => stopDaemon(),
  });
  setCommercialLifecycle(flow);
  return flow;
}
