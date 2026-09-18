/**
 * Computer Use（cua helper）服务 —— 商业版实现（overlay 托管）。
 * 契约/配方出处：docs/20260917-computer-use-integration-v2.md（附录 D spike 实证）：
 *  - helper = 独立 .app（TCC 自有身份），LaunchServices `open` 拉起 `serve --socket <私有路径>`；
 *  - 授权触发 = helper 权限宿主（`__permissions-host-request --result-file $TMPDIR/cua-driver-permissions-*.json`，
 *    文件名与目录均被上游白名单校验，勿改）；
 *  - 产品态 helper 随包 Resources 分发（P1 接 binaryLocator 双通道）；当前 dev 态装在 /Applications。
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import log from "electron-log";
import { readSetting, writeSetting } from "../../db";

const pexec = promisify(execFile);

const HELPER_CANDIDATES = ["/Applications/Nuwax Computer Use.app"];
const SOCKET_PATH = path.join(os.tmpdir(), "nuwax-computer-use.sock");
const STEP1_KEY = "step1_config";

export interface CuaStatus {
  supported: boolean;
  installed: boolean;
  running: boolean;
  enabled: boolean;
  socketPath: string;
  helperPath: string | null;
  accessibility: boolean | null;
  screenRecording: boolean | null;
}

export interface CuaPermissionsResult {
  success: boolean;
  error?: string;
  accessibility: boolean | null;
  screenRecording: boolean | null;
}

// 最近一次权限宿主探测的结果（授权后重跑即返回 true 且不再弹窗，可安全重复调用）
let lastPermissionHint: {
  accessibility: boolean | null;
  screenRecording: boolean | null;
} = { accessibility: null, screenRecording: null };

function findHelperApp(): string | null {
  for (const p of HELPER_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function probeSocket(sockPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(sockPath);
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(500, () => done(false));
    s.on("connect", () => done(true));
    s.on("error", () => done(false));
  });
}

function readEnabled(): boolean {
  const step1 = readSetting(STEP1_KEY) as {
    computerUseEnabled?: boolean;
  } | null;
  return step1?.computerUseEnabled === true;
}

function persistEnabled(enabled: boolean) {
  const step1 = (readSetting(STEP1_KEY) ?? {}) as Record<string, unknown>;
  writeSetting(STEP1_KEY, { ...step1, computerUseEnabled: enabled });
}

export async function getCuaStatus(): Promise<CuaStatus> {
  const helperPath = findHelperApp();
  const running = fs.existsSync(SOCKET_PATH)
    ? await probeSocket(SOCKET_PATH)
    : false;
  return {
    supported: true,
    installed: !!helperPath,
    running,
    enabled: readEnabled(),
    socketPath: SOCKET_PATH,
    helperPath,
    ...lastPermissionHint,
  };
}

export async function setCuaEnabled(enabled: boolean): Promise<{
  success: boolean;
  error?: string;
  status: CuaStatus;
}> {
  const helperPath = findHelperApp();
  if (enabled && !helperPath) {
    return {
      success: false,
      error: "helper-not-installed",
      status: await getCuaStatus(),
    };
  }
  persistEnabled(enabled);
  if (enabled) {
    const alive = fs.existsSync(SOCKET_PATH) && (await probeSocket(SOCKET_PATH));
    if (!alive && helperPath) {
      const child = spawn(
        "open",
        ["-n", helperPath, "--args", "serve", "--socket", SOCKET_PATH],
        { detached: true, stdio: "ignore" },
      );
      child.unref();
      log.info("[Cua] daemon launch dispatched:", SOCKET_PATH);
    }
  } else {
    try {
      await pexec("pkill", ["-f", `serve --socket ${SOCKET_PATH}`]);
    } catch {
      // 未在运行，无需清理
    }
  }
  return { success: true, status: await getCuaStatus() };
}

/**
 * 触发/检查 helper 的 TCC 授权（权限宿主流）。
 * 未授权时系统会弹出「Nuwax Computer Use 想要控制…」引导窗（用户点「打开系统设置」完成）；
 * 已授权时立即返回结果且不再弹窗——因此可安全地作为状态复查动作重复调用。
 */
export async function requestCuaPermissions(): Promise<CuaPermissionsResult> {
  const helperPath = findHelperApp();
  if (!helperPath) {
    return {
      success: false,
      error: "helper-not-installed",
      accessibility: null,
      screenRecording: null,
    };
  }
  const resultFile = path.join(
    os.tmpdir(),
    `cua-driver-permissions-${process.pid}.json`,
  );
  try {
    fs.rmSync(resultFile, { force: true });
    fs.writeFileSync(resultFile, "", { mode: 0o600 });
  } catch {
    // 结果文件写不进去时宿主自身会以安全码退出，此处不拦截
  }
  const child = spawn(
    "open",
    [
      "-n",
      "-g",
      helperPath,
      "--args",
      "__permissions-host-request",
      "--result-file",
      resultFile,
      "--probe-direct-capture",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  // 权限宿主完成探测即退出并写结果；等待上限 20s
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const raw = fs.readFileSync(resultFile, "utf-8");
      if (raw.trim()) {
        const sc = (JSON.parse(raw).structuredContent ?? {}) as {
          accessibility?: boolean;
          screen_recording?: boolean;
        };
        lastPermissionHint = {
          accessibility: sc.accessibility ?? null,
          screenRecording: sc.screen_recording ?? null,
        };
        return { success: true, ...lastPermissionHint };
      }
    } catch {
      // 尚未写完，继续轮询
    }
  }
  return { success: false, error: "timeout", ...lastPermissionHint };
}

// ========== 视觉模型配置（加速验证：壳侧自持的 OpenAI 兼容 VLM 通道） ==========

export interface CuaVlmConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

const DEFAULT_VLM: CuaVlmConfig = {
  baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  model: "",
  apiKey: "",
};

function readVlm(): CuaVlmConfig {
  const step1 = readSetting(STEP1_KEY) as {
    computerUseVlm?: Partial<CuaVlmConfig>;
  } | null;
  return { ...DEFAULT_VLM, ...(step1?.computerUseVlm ?? {}) };
}

export function getVlmConfig(): CuaVlmConfig {
  return readVlm();
}

export function setVlmConfig(
  patch: Partial<CuaVlmConfig>,
): { success: boolean; error?: string } {
  const merged: CuaVlmConfig = { ...readVlm(), ...patch };
  merged.baseUrl = merged.baseUrl.trim().replace(/\/+$/, "");
  merged.model = merged.model.trim();
  const step1 = (readSetting(STEP1_KEY) ?? {}) as Record<string, unknown>;
  writeSetting(STEP1_KEY, { ...step1, computerUseVlm: merged });
  return { success: true };
}

/**
 * 连通性测试：对配置端点发一次最小 chat/completions（文本 ping）。
 * apiKey 只进请求头，严禁写入日志/错误信息。
 */
export async function testVlm(): Promise<{
  success: boolean;
  error?: string;
  latencyMs?: number;
}> {
  const cfg = readVlm();
  if (!cfg.model || !cfg.apiKey) {
    return { success: false, error: "vlm-not-configured" };
  }
  const started = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const text = (await res.text()).slice(0, 200);
      return { success: false, error: `HTTP ${res.status}: ${text}`, latencyMs };
    }
    return { success: true, latencyMs };
  } catch (e) {
    const err = e as { name?: string; message?: string };
    return {
      success: false,
      error:
        err?.name === "AbortError"
          ? "timeout"
          : String(err?.message ?? e).slice(0, 200),
    };
  }
}
