import { app, net } from "electron";
import * as os from "os";
import { readSetting, writeSetting, getDb } from "../db";
import {
  DEFAULT_SERVER_HOST,
  LOCAL_HOST_URL,
  DEFAULT_GUI_MCP_PORT,
} from "@shared/constants";
import { getConfiguredPorts } from "../services/startupPorts";
import { getDeviceId } from "../services/system/deviceId";
import {
  AuthLifecycle,
  setCommercialLifecycle,
  type ServiceResult,
} from "../services/auth/lifecycle";

export function currentBusinessOrigin(): string {
  const raw =
    (readSetting("step1_config") as { serverHost?: string } | null)
      ?.serverHost || DEFAULT_SERVER_HOST;
  return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).origin;
}
/** 注册上报的电脑名（三平台）：os.hostname 通吃 macOS/Windows/Linux，
 * 仅剥 macOS Bonjour 的 .local 尾巴（DONG-MBP128.local → DONG-MBP128）。 */
export function getComputerName(): string {
  return os.hostname().replace(/\.local$/i, "").trim();
}
export function currentAccessToken(): string | null {
  const value = readSetting(`nuwax.accessToken.${currentBusinessOrigin()}`);
  return typeof value === "string" && value ? value : null;
}
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
  const { serverIp, serverPort, clientKey, ...preferences } = lp;
  writeSetting("lanproxy_config", preferences);
  if (opts?.preserveSavedKey) {
    if (legacySavedKey != null) writeSetting("auth.saved_key", legacySavedKey);
    if (legacyUsername != null) writeSetting("auth.username", legacyUsername);
  }
}
export function initializeCommercialAuth(
  start: (signal: AbortSignal) => Promise<ServiceResult>,
  stop: () => Promise<ServiceResult>,
  changed: (phase: string, error?: string) => void,
  expired?: () => void,
) {
  // 新安装使用随包前端，离线也能打开登录/企业域名配置；已有模式偏好保留。
  // dev 全新库同种种值：不种则业务域候选/注册回落 DEFAULT_SERVER_HOST（生产域），
  // 与 dev 前端联调的测试域 token 错域。NUWAX_SERVER_HOST 指定业务域，直连形态
  // （不种 gateway——dev 走 NUWAX_WEBVIEW_ORIGIN 直连本地前端，不起网关）。
  if (!readSetting("step1_config")) {
    const devSeedHost = process.env.NUWAX_SERVER_HOST?.trim();
    if (app?.isPackaged) {
      writeSetting("step1_config", {
        serverHost: DEFAULT_SERVER_HOST,
        nuwaxLoadMode: "gateway",
      });
    } else if (devSeedHost) {
      writeSetting("step1_config", { serverHost: devSeedHost });
    }
  }
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
    authenticated: () => !!currentAccessToken(),
    register: async (signal: AbortSignal) => {
      const origin = currentBusinessOrigin();
      const token = currentAccessToken();
      const ports = getConfiguredPorts();
      let username = "";
      try {
        username =
          JSON.parse(Buffer.from(token!.split(".")[1], "base64url").toString())
            .sub || "";
      } catch {
        /* opaque tokens are valid too */
      }
      const savedKey = readSetting("auth.saved_key");
      const response = await net.fetch(`${origin}/api/sandbox/config/reg`, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "x-client-type": "nuwax",
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
      if (response.status === 401) expired?.();
      if (!response.ok) throw new Error(`Registration HTTP ${response.status}`);
      const payload = await response.json();
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
  });
  setCommercialLifecycle(flow);
  return flow;
}
