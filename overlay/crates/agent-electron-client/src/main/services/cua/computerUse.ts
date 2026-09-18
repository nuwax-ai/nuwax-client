/**
 * Computer Use（cua helper）服务 —— 商业版实现（overlay 托管）。
 * 契约/配方出处：docs/20260917-computer-use-integration-v2.md（附录 D spike 实证）：
 *  - helper = 独立 .app（TCC 自有身份），LaunchServices `open` 拉起 `serve --socket <私有路径>`；
 *    Windows 无 TCC，helper = 独立 exe 直接 spawn（照 sandbox-helper 模式）。
 *  - MCP 条目 = `cua` StdioMcpServerEntry（command=helper 可执行, args=mcp --socket <私有路径>），
 *    写 db `mcp_local_config` 并 sync 到 MCP Proxy（照 guiMcpLocalConfig 先例，消费链在
 *    unifiedAgent.loadLocalMcpConfig，引擎启动时自动合并，本地条目优先）。
 *  - 授权触发 = helper 权限宿主（`__permissions-host-request --result-file $TMPDIR/cua-driver-permissions-*.json`，
 *    文件名与目录均被上游白名单校验，勿改）——仅 mac（TCC 概念）。
 *  - helper 分发：产品态随包 Resources（installable），首用安装到 userData 稳定路径（B3 安装流）；
 *    /Applications 为 spike/dev 态兼容探测位。
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
import log from "electron-log";
import { getDb, readSetting, writeSetting } from "../../db";

const pexec = promisify(execFile);

const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";

const HELPER_APP_NAME = "Nuwax Computer Use.app";
const HELPER_EXEC_NAME = "Nuwax Computer Use";
const HELPER_EXE_NAME = "NuwaxComputerUse.exe";
const MCP_SERVER_ID = "cua";
const STEP1_KEY = "step1_config";
const MCP_LOCAL_CONFIG_KEY = "mcp_local_config";

/** 私有 socket/pipe 端点（daemon 与 stdio MCP 代理共用）。 */
export const SOCKET_PATH = IS_WIN
  ? "\\\\.\\pipe\\nuwax-computer-use"
  : path.join(os.tmpdir(), "nuwax-computer-use.sock");

/** helper 安装的稳定路径（首用安装流目标；学 ZCode：数据目录 + 安装锁）。 */
function stableInstallDir(): string {
  return path.join(app.getPath("userData"), "computer-use");
}

/** helper 候选探测：稳定安装位 → /Applications（仅 dev 态回退，spike/dev 机）→ 随包 Resources。 */
function helperCandidates(): Array<{ kind: "installed" | "bundled"; root: string }> {
  const stable = path.join(stableInstallDir(), IS_WIN ? HELPER_EXE_NAME : HELPER_APP_NAME);
  const list: Array<{ kind: "installed" | "bundled"; root: string }> = [];
  if (fs.existsSync(stable)) list.push({ kind: "installed", root: stable });
  // 打包版只认稳定安装位与随包 Resources；/Applications 探测仅服务 dev 检出
  // （开发机 helper 手工装在 /Applications），避免用户目录同名物的误配风险
  if (IS_MAC && !app.isPackaged && fs.existsSync(path.join("/Applications", HELPER_APP_NAME))) {
    list.push({ kind: "installed", root: path.join("/Applications", HELPER_APP_NAME) });
  }
  const bundled = path.join(
    process.resourcesPath,
    "computer-use",
    IS_WIN ? HELPER_EXE_NAME : HELPER_APP_NAME,
  );
  if (fs.existsSync(bundled)) list.push({ kind: "bundled", root: bundled });
  return list;
}

/** 已安装（可直接拉起 daemon）的 helper 路径；bundled 态不算已安装（须先走首装流）。 */
function findHelperApp(): string | null {
  return helperCandidates().find((c) => c.kind === "installed")?.root ?? null;
}

/** 随包 Resources 里有 helper 但未安装（首用安装流的输入）。 */
function findBundledHelper(): string | null {
  return helperCandidates().find((c) => c.kind === "bundled")?.root ?? null;
}

/** daemon serve 用的可执行文件（.app 内 macOS 可执行 / win exe 本体）。 */
function helperExecutable(helperRoot: string): string {
  return IS_WIN
    ? helperRoot
    : path.join(helperRoot, "Contents", "MacOS", HELPER_EXEC_NAME);
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

async function isDaemonAlive(): Promise<boolean> {
  return fs.existsSync(SOCKET_PATH) && (await probeSocket(SOCKET_PATH));
}

/** 等待 daemon 就绪（open 拉起为异步，socket 文件出现即可握手）。 */
async function waitForSocket(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isDaemonAlive()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** 拉起 daemon（幂等：先探活）。mac 走 LaunchServices（TCC 归 helper .app）；win 直跑 exe。 */
async function launchDaemon(helperRoot: string): Promise<void> {
  if (await isDaemonAlive()) return;
  if (IS_MAC) {
    const child = spawn(
      "open",
      ["-n", helperRoot, "--args", "serve", "--socket", SOCKET_PATH],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    log.info("[Cua] daemon launch dispatched:", SOCKET_PATH);
    return;
  }
  if (IS_WIN) {
    const child = spawn(helperExecutable(helperRoot), [
      "serve",
      "--socket",
      SOCKET_PATH,
    ], { detached: true, stdio: "ignore" });
    child.unref();
    log.info("[Cua] daemon spawn dispatched:", SOCKET_PATH);
    return;
  }
  log.warn("[Cua] unsupported platform for daemon launch:", process.platform);
}

/** 停 daemon：协议优先（`stop --socket`，官方 stop 子命令），失败兜底按端点匹配强杀。 */
async function stopDaemon(): Promise<void> {
  const helperPath = findHelperApp();
  if (helperPath) {
    try {
      await pexec(helperExecutable(helperPath), ["stop", "--socket", SOCKET_PATH], {
        timeout: 4000,
      });
      log.info("[Cua] daemon stopped via protocol");
      return;
    } catch {
      // 协议停失败（未运行/超时）→ 回退强杀
    }
  }
  try {
    if (IS_WIN) {
      // 命名管道端点无独立 pid 可 pgrep，按命令行匹配杀
      await pexec(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*serve --socket nuwax-computer-use*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
        ],
      );
    } else {
      await pexec("pkill", ["-f", `serve --socket ${SOCKET_PATH}`]);
    }
  } catch {
    // 未在运行，无需清理
  }
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

// ========== MCP 条目注入（照 guiMcpLocalConfig.syncGuiAgentLocalMcpConfig 先例） ==========

import type { McpServerEntry } from "../packages/mcp";

function readMcpLocalConfig(): { mcpServers: Record<string, McpServerEntry> } {
  const db = getDb();
  if (!db) return { mcpServers: {} };
  const saved = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(MCP_LOCAL_CONFIG_KEY) as { value: string } | undefined;
  if (!saved?.value) return { mcpServers: {} };
  try {
    const parsed = JSON.parse(saved.value) as {
      mcpServers?: Record<string, McpServerEntry>;
    };
    return {
      mcpServers:
        parsed?.mcpServers && typeof parsed.mcpServers === "object"
          ? parsed.mcpServers
          : {},
    };
  } catch (e) {
    log.warn("[Cua] Failed to parse mcp_local_config, reset:", e);
    return { mcpServers: {} };
  }
}

function isMcpInjected(): boolean {
  return !!readMcpLocalConfig().mcpServers?.[MCP_SERVER_ID];
}

/**
 * 开关 → `cua` MCP 条目 upsert/remove，并同步 MCP Proxy 内存（运行中立即生效；
 * 引擎侧由 unifiedAgent.loadLocalMcpConfig 在下次引擎启动合并，本地条目优先）。
 */
export async function syncCuaMcpConfig(enabled: boolean): Promise<void> {
  const db = getDb();
  if (!db) {
    log.warn("[Cua] Database not ready, skip MCP sync");
    return;
  }
  const config = readMcpLocalConfig();
  const servers = { ...(config.mcpServers ?? {}) };
  if (enabled) {
    const helperRoot = findHelperApp();
    if (!helperRoot) {
      delete servers[MCP_SERVER_ID];
    } else {
      servers[MCP_SERVER_ID] = {
        command: helperExecutable(helperRoot),
        args: ["mcp", "--socket", SOCKET_PATH],
        enabled: true,
      };
    }
  } else {
    delete servers[MCP_SERVER_ID];
  }
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
    MCP_LOCAL_CONFIG_KEY,
    JSON.stringify({ ...config, mcpServers: servers }),
  );
  try {
    const { syncMcpConfigToProxyAndReload } = await import(
      "../packages/mcp"
    );
    const { filterEnabledMcpServers } = await import(
      "../utils/mcpServerMerge"
    );
    await syncMcpConfigToProxyAndReload(filterEnabledMcpServers(servers));
  } catch (e) {
    // Proxy 未起（如未登录态）时同步失败可容忍：条目已落库，引擎启动仍会读到
    log.warn("[Cua] MCP proxy sync skipped:", e);
  }
  log.info(`[Cua] Synced ${MCP_SERVER_ID} in mcp_local_config: enabled=${enabled}`);
}

export async function getCuaStatus(): Promise<CuaStatus> {
  const helperPath = findHelperApp();
  return {
    supported: IS_MAC || IS_WIN,
    installed: !!helperPath,
    installable: !helperPath && !!findBundledHelper(),
    running: await isDaemonAlive(),
    enabled: readEnabled(),
    mcpInjected: isMcpInjected(),
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
      error: findBundledHelper() ? "helperNotInstalledBundled" : "helperNotInstalled",
      status: await getCuaStatus(),
    };
  }
  persistEnabled(enabled);
  if (enabled) {
    await launchDaemon(helperPath!);
    const ready = await waitForSocket(5000);
    if (!ready) log.warn("[Cua] daemon not ready in 5s, MCP entry injected anyway");
    await syncCuaMcpConfig(true);
  } else {
    await syncCuaMcpConfig(false);
    await stopDaemon();
  }
  return { success: true, status: await getCuaStatus() };
}

/**
 * 启动期收敛（幂等）：开关开着则拉起 daemon 并确保 MCP 条目在位；
 * helper 已不存在则清掉条目防僵尸（升级/卸载残留场景）。挂在商业版
 * lifecycle start 回调（restartAllServicesNow 之后，不阻塞启动主链）。
 */
export async function ensureCuaOnBoot(): Promise<void> {
  if (!readEnabled()) return;
  const helperPath = findHelperApp();
  if (!helperPath) {
    await syncCuaMcpConfig(false);
    return;
  }
  try {
    await launchDaemon(helperPath);
    const ready = await waitForSocket(8000);
    if (!ready) log.warn("[Cua] boot: daemon not ready in 8s");
  } catch (e) {
    log.warn("[Cua] boot: daemon launch failed", e);
  }
  await syncCuaMcpConfig(true);
}

// ========== 首用安装流（Resources → userData 稳定路径；学 ZCode：签名/bundle id 校验+安装锁） ==========

const HELPER_BUNDLE_ID = "com.nuwax-ai.nuwax-computer-use";
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

export interface CuaInstallResult {
  success: boolean;
  error?: string;
  installedPath?: string | null;
}

/** 校验 helper 签名与 bundle id（防同名近似条目/被篡改的 bundled 源；win 无签名校验）。 */
async function verifyHelperSignature(
  appPath: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!IS_MAC) return { ok: true };
  try {
    // codesign -dv 的详细信息输出在 stderr
    const r = await pexec("codesign", ["-dv", "--verbose=2", appPath]);
    const out = `${r.stderr ?? ""}\n${r.stdout ?? ""}`;
    const id = /^Identifier=(.+)$/m.exec(out)?.[1]?.trim();
    const team = /^TeamIdentifier=(.+)$/m.exec(out)?.[1]?.trim();
    if (id !== HELPER_BUNDLE_ID) {
      return { ok: false, error: `bundle-id-mismatch:${id ?? "none"}` };
    }
    if (!team || team === "not set") {
      // ad-hoc（无 Team）只可能出现在 dev；产品 CI 产线必须 Developer ID 正签
      log.warn("[Cua] helper has no TeamIdentifier (ad-hoc? dev tolerance)");
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `codesign-failed:${String(e).slice(0, 120)}` };
  }
}

/**
 * 首用透明安装：随包 Resources 的 helper → userData/computer-use 稳定路径。
 * 安装后自动触发一次权限探测（已授权静默返回；未授权弹系统引导窗=TCC 归属自校验）。
 * 幂等：已安装直接返回成功。
 */
export async function installCuaHelper(): Promise<CuaInstallResult> {
  const existing = findHelperApp();
  if (existing) return { success: true, installedPath: existing };
  const bundled = findBundledHelper();
  if (!bundled) return { success: false, error: "bundledNotFound" };
  const verify = await verifyHelperSignature(bundled);
  if (!verify.ok) return { success: false, error: verify.error };
  const dest = path.join(
    stableInstallDir(),
    IS_WIN ? HELPER_EXE_NAME : HELPER_APP_NAME,
  );
  try {
    fs.mkdirSync(stableInstallDir(), { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(bundled, dest, { recursive: true, verbatimSymlinks: true });
    if (IS_MAC) {
      // 清 quarantine/resource fork 残留（spike 坑④：cp 带的 xattr 会让 verify 报错）
      await pexec("xattr", ["-cr", dest]).catch(() => undefined);
      const v2 = await verifyHelperSignature(dest);
      if (!v2.ok) return { success: false, error: `install-verify:${v2.error}` };
      // 路径搬迁会留脏 LS 记录/Spotlight 未索引（spike 配方：lsregister -f + mdimport）
      await pexec(LSREGISTER, ["-f", dest]).catch(() => undefined);
      await pexec("mdimport", [dest]).catch(() => undefined);
    }
    // 安装锁：溯源标记（安装时间+来源），兼作并发安装的完成信号
    fs.writeFileSync(
      path.join(stableInstallDir(), ".install-lock"),
      JSON.stringify(
        { installedAt: new Date().toISOString(), source: bundled },
        null,
        1,
      ),
    );
  } catch (e) {
    return { success: false, error: String(e).slice(0, 200) };
  }
  log.info("[Cua] helper installed to", dest);
  void requestCuaPermissions().catch(() => undefined);
  return { success: true, installedPath: dest };
}

/** 退出清理：app 退出即停 daemon（协议优先，失败强杀兜底；下次启动 ensureCuaOnBoot 幂等拉回）。 */
export function registerCuaQuitCleanup(): void {
  app.on("will-quit", () => {
    void stopDaemon();
  });
}

// ========== TCC 授权（仅 mac；win 无此概念） ==========

export interface CuaStatus {
  supported: boolean;
  installed: boolean;
  /** 随包 Resources 有 helper 但未安装（首用安装流输入）。 */
  installable: boolean;
  running: boolean;
  enabled: boolean;
  mcpInjected: boolean;
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

/**
 * 触发/检查 helper 的 TCC 授权（权限宿主流）。
 * 未授权时系统会弹出「Nuwax Computer Use 想要控制…」引导窗（用户点「打开系统设置」完成）；
 * 已授权时立即返回结果且不再弹窗——因此可安全地作为状态复查动作重复调用。
 */
export async function requestCuaPermissions(): Promise<CuaPermissionsResult> {
  const helperPath = findHelperApp();
  if (!IS_MAC || !helperPath) {
    return {
      success: false,
      error: IS_MAC ? "helperNotInstalled" : "unsupportedPlatform",
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
    return { success: false, error: "vlmNotConfigured" };
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
