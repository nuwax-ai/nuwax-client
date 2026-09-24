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
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
import log from "electron-log";
import { getDb, readSetting, writeSetting } from "../../db";
import { APP_DATA_DIR_NAME } from "../constants";

const pexec = promisify(execFile);

const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";
const IS_LINUX = process.platform === "linux";

const HELPER_APP_NAME = "Nuwax Computer Use.app";
const HELPER_EXEC_NAME = "Nuwax Computer Use";
const HELPER_EXE_NAME = "NuwaxComputerUse.exe";
const HELPER_BIN_NAME = "NuwaxComputerUse";
const MCP_SERVER_ID = "cua";
const STEP1_KEY = "step1_config";
const MCP_LOCAL_CONFIG_KEY = "mcp_local_config";
const HELPER_TEAM_ID = "89GQ2RJVW7";
const CUA_DENIED_TOOLS = ["check_for_update", "install_ffmpeg"];
// 仅暴露已审过的 driver 工具；driver 升级新增的工具须显式审核后加入。
const CUA_ALLOWED_TOOLS = [
  "bring_to_front", "browser_click", "browser_dialog", "browser_download",
  "browser_navigate", "browser_pointer", "browser_prepare", "browser_set_input_files",
  "browser_type", "check_permissions", "click", "clipboard_read", "clipboard_write",
  "debug_window_info", "double_click", "drag", "end_session", "escalate_session",
  "get_accessibility_tree", "get_agent_cursor_state", "get_browser_state", "get_config",
  "get_cursor_position", "get_desktop_state", "get_recording_state", "get_screen_size",
  "get_session", "get_session_state", "get_window_state", "health_report", "hotkey",
  "invoke_menu", "kill_app", "launch_app", "list_apps", "list_sessions",
  "list_windows", "move_cursor", "page", "press_key", "replay_trajectory",
  "right_click", "scroll", "set_agent_cursor_enabled", "set_agent_cursor_motion",
  "set_agent_cursor_theme", "set_config", "set_value", "set_window_frame",
  "start_recording", "start_session", "stop_recording", "type_text", "verify_state", "zoom",
];

/** 平台对应的 helper 产物名（mac=.app bundle；win=exe；linux=裸二进制）。 */
function helperArtifactName(): string {
  if (IS_MAC) return HELPER_APP_NAME;
  return IS_WIN ? HELPER_EXE_NAME : HELPER_BIN_NAME;
}

const LEGACY_SOCKET_PATH = IS_WIN
  ? "\\\\.\\pipe\\nuwax-computer-use"
  : path.join(os.tmpdir(), "nuwax-computer-use.sock");
const ENDPOINT_TOKEN_ENV = "CUA_DRIVER_NUWAX_TOKEN_FILE";
type CuaEndpoint = { root: string; socketPath: string; tokenFile: string; token: string };
let endpointCache: CuaEndpoint | null = null;

/** 随安装保留的随机端点和能力文件；Unix 目录 0700，token 文件 0600。 */
function endpoint(): CuaEndpoint {
  const root = stableInstallDir();
  if (endpointCache?.root === root) return endpointCache;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() ||
      (process.getuid && rootStat.uid !== process.getuid())) {
    throw new Error("endpointDirectoryUntrusted");
  }
  if (!IS_WIN) fs.chmodSync(root, 0o700);
  const manifest = path.join(root, "endpoint.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as {
      socketPath?: string; tokenFile?: string;
    };
    const socketPath = parsed.socketPath ?? "";
    const privateDir = IS_WIN ? root : path.dirname(socketPath);
    const dirStat = fs.lstatSync(privateDir);
    const winPipePrefix = "\\\\.\\pipe\\nuwax-computer-use-";
    const id = IS_WIN
      ? socketPath.slice(winPipePrefix.length)
      : path.basename(privateDir).slice(2);
    const trusted = IS_WIN
      ? socketPath.startsWith(winPipePrefix) &&
        /^[0-9a-f]{32}$/.test(id)
      : path.dirname(privateDir) === os.tmpdir() &&
        /^c-[0-9a-f]{32}$/.test(path.basename(privateDir)) &&
        path.basename(socketPath) === "s" &&
        dirStat.isDirectory() && !dirStat.isSymbolicLink() &&
        (!process.getuid || dirStat.uid === process.getuid()) &&
        (dirStat.mode & 0o077) === 0;
    const tokenFile = path.join(root, `endpoint-token-${id}`);
    if (!trusted || parsed.tokenFile !== tokenFile) throw new Error("endpointManifestUntrusted");
    const tokenStat = fs.lstatSync(tokenFile);
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    if (tokenStat.isFile() && !tokenStat.isSymbolicLink() &&
        (!process.getuid || tokenStat.uid === process.getuid()) &&
        (IS_WIN || (tokenStat.mode & 0o077) === 0) &&
        /^[0-9a-f]{64}$/.test(token)) {
      endpointCache = { root, socketPath, tokenFile, token };
      return endpointCache;
    }
  } catch { /* 首次安装或端点目录已由系统清理；重新生成 */ }
  const id = randomBytes(16).toString("hex");
  const privateDir = path.join(os.tmpdir(), `c-${id}`);
  if (!IS_WIN) fs.mkdirSync(privateDir, { mode: 0o700 });
  const socketPath = IS_WIN
    ? `\\\\.\\pipe\\nuwax-computer-use-${id}`
    : path.join(privateDir, "s");
  const token = randomBytes(32).toString("hex");
  const tokenFile = path.join(root, `endpoint-token-${id}`);
  fs.writeFileSync(tokenFile, token, { flag: "wx", mode: 0o600 });
  if (!IS_WIN) fs.chmodSync(tokenFile, 0o600);
  const staged = `${manifest}.${randomUUID()}.stage`;
  fs.writeFileSync(staged, JSON.stringify({ socketPath, tokenFile }), { flag: "wx", mode: 0o600 });
  fs.renameSync(staged, manifest);
  endpointCache = { root, socketPath, tokenFile, token };
  return endpointCache;
}

/** helper 安装的稳定路径（首用安装流目标；学 ZCode：数据目录 + 安装锁）。 */
function stableInstallDir(): string {
  return path.join(app.getPath("userData"), "computer-use");
}

/** helper 候选探测：稳定安装位 → /Applications（仅 dev 态回退，spike/dev 机）→ 随包 Resources。 */
function helperCandidates(): Array<{ kind: "installed" | "bundled"; root: string }> {
  const stable = path.join(stableInstallDir(), helperArtifactName());
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
    helperArtifactName(),
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

/** daemon serve 用的可执行文件（mac=.app 内可执行；win=exe 本体；linux=二进制本体）。 */
function helperExecutable(helperRoot: string): string {
  if (IS_MAC) {
    return path.join(helperRoot, "Contents", "MacOS", HELPER_EXEC_NAME);
  }
  return helperRoot;
}

async function isDaemonAlive(): Promise<boolean> {
  const reply = await requestDaemon("metadata");
  return reply?.ok === true && typeof reply.result?.driver_version === "string";
}

interface DaemonReply {
  ok?: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

async function requestDaemon(method: string, name?: string, args?: Record<string, unknown>): Promise<DaemonReply | null> {
  return new Promise((resolve) => {
    let selected: CuaEndpoint;
    try { selected = endpoint(); }
    catch { resolve(null); return; }
    const socket = net.connect(selected.socketPath);
    let settled = false;
    let response = "";
    let proofAccepted = false;
    const nonce = randomBytes(16).toString("hex");
    const finish = (result: DaemonReply | null = null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(3000, () => finish());
    socket.on("error", () => finish());
    socket.on("close", () => finish());
    socket.on("end", () => finish());
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ method: "metadata", args: { nuwax_nonce: nonce } })}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
      if (response.length > 65536) return finish();
      while (response.includes("\n")) {
        const lineEnd = response.indexOf("\n");
        const line = response.slice(0, lineEnd);
        response = response.slice(lineEnd + 1);
        try {
          const reply = JSON.parse(line) as DaemonReply;
          if (!proofAccepted) {
            const actual = reply.result?.nuwax_endpoint_proof;
            const expected = createHmac("sha256", selected.token).update(nonce).digest("hex");
            if (reply.ok !== true || typeof actual !== "string" ||
                actual.length !== expected.length ||
                !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) return finish();
            proofAccepted = true;
            socket.write(`${JSON.stringify({
              method, name, args,
              observation_origin: "direct", client_kind: "cli",
              nuwax_client_token: selected.token,
            })}\n`);
          } else {
            return finish(reply);
          }
        } catch {
          return finish();
        }
      }
    });
  });
}

/** 通过 helper 自己的 daemon 查询 TCC；不从主客户端进程推断授权，也不触发系统弹窗。 */
async function probeDaemonPermissions(): Promise<{
  accessibility: boolean | null;
  screenRecording: boolean | null;
}> {
  const unknown = { accessibility: null, screenRecording: null };
  if (!IS_MAC) return unknown;
  const reply = await requestDaemon("call", "check_permissions", { prompt: false });
  const sc = reply?.result?.structuredContent as Record<string, unknown> | undefined;
  const source = sc?.source as { attribution?: unknown } | undefined;
  if (!reply?.ok || source?.attribution !== "driver-daemon" ||
      (source as { bundle_id?: unknown }).bundle_id !== HELPER_BUNDLE_ID) return unknown;
  return {
    accessibility: typeof sc?.accessibility === "boolean" ? sc.accessibility : null,
    screenRecording: typeof sc?.screen_recording === "boolean" ? sc.screen_recording : null,
  };
}

/** 初启 gate 会短暂返回 permissions_pending；在上限内复查，超时保持关闭。 */
async function waitForDaemonPermissions(timeoutMs: number): Promise<{
  accessibility: boolean | null; screenRecording: boolean | null;
}> {
  const deadline = Date.now() + timeoutMs;
  let latest = { accessibility: null, screenRecording: null } as {
    accessibility: boolean | null; screenRecording: boolean | null;
  };
  do {
    latest = await probeDaemonPermissions();
    if (latest.accessibility === true && latest.screenRecording === true) return latest;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 400));
  } while (true);
  return latest;
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

async function waitForDaemonStopped(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isDaemonAlive())) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return !(await isDaemonAlive());
}

/**
 * 驱动自有落盘的统一宿主目录（补丁 3 的 CUA_DRIVER_DATA_HOME）：~/.nuwax/computer-use
 * （与 nuwax.db 同源=APP_DATA_DIR_NAME 派生）——pid/telemetry·install 标记/history/
 * 浏览器 profile/libei restore token 全部内聚于此，机器上不再出现 cua-* 外部目录。
 */
function cuaDataHome(): string {
  return path.join(app.getPath("home"), APP_DATA_DIR_NAME, "computer-use");
}

/** daemon 进程环境：数据目录内聚 env（须与补丁 3 的开关同名）。 */
function daemonEnv(policyPath: string): { [key: string]: string } {
  const inherited = { ...process.env };
  delete inherited.CUA_DRIVER_RS_MCP_HTTP_PORT;
  delete inherited.CUA_DRIVER_RS_MCP_HTTP_TOKEN;
  delete inherited.CUA_DRIVER_ENVELOPE_HTTP_PORT;
  delete inherited.CUA_DRIVER_ENVELOPE_PERMISSION_MODE;
  return {
    ...inherited,
    CUA_DRIVER_DATA_HOME: cuaDataHome(),
    CUA_DRIVER_MANAGED_POLICY_FILE: policyPath,
    [ENDPOINT_TOKEN_ENV]: endpoint().tokenFile,
  } as { [key: string]: string };
}

function policyDigest(filename: string, contents: Buffer): string {
  const hash = createHash("sha256");
  const length = (value: number) => {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64BE(BigInt(value));
    return bytes;
  };
  hash.update("cua-driver-policy-v1\0");
  hash.update(length(Buffer.byteLength(filename)));
  hash.update(filename);
  hash.update(length(contents.length));
  hash.update(contents);
  return hash.digest("hex");
}

/** 主进程托管的驱动策略同时覆盖 MCP 与同用户私有 socket 直连。 */
function prepareCuaPolicy(): { path: string; sha256: string } {
  const dir = cuaDataHome();
  const filename = "nuwax-capabilities.yaml";
  const target = path.join(dir, filename);
  const contents = Buffer.from([
    "allow:", "  tools:",
    ...CUA_ALLOWED_TOOLS.map((tool) => `    - ${tool}`),
    "deny:", "  tools:",
    ...CUA_DENIED_TOOLS.map((tool) => `    - ${tool}`),
    "",
  ].join("\n"));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(target) || !fs.readFileSync(target).equals(contents)) {
    const stage = path.join(dir, `.${filename}.${randomUUID()}.stage`);
    try {
      fs.writeFileSync(stage, contents, { mode: 0o600 });
      fs.renameSync(stage, target);
    } finally {
      fs.rmSync(stage, { force: true });
    }
  }
  return { path: target, sha256: policyDigest(filename, contents) };
}

async function verifyDaemonAuthorization(expectedSha256: string): Promise<boolean> {
  const reply = await requestDaemon("authorization_status");
  const status = reply?.result;
  return reply?.ok === true &&
    status?.permission_mode === "unrestricted" &&
    status?.permission_mode_valid === true &&
    status?.managed_policy_active === true &&
    status?.managed_policy_valid === true &&
    status?.managed_policy_sha256 === expectedSha256;
}

/** 用户在设置页一次性确认全范围操作后，daemon 固定用无需逐次审批的模式启动。 */
function daemonServeArgs(): string[] {
  return [
    "serve", "--socket", endpoint().socketPath,
    "--permission-mode", "unrestricted", "--dangerously-bypass-approvals",
  ];
}

/** 拉起 daemon（幂等：先探活）。mac 走 LaunchServices（TCC 归 helper .app）；win/linux 直跑二进制。 */
async function launchDaemon(helperRoot: string): Promise<string> {
  const policy = prepareCuaPolicy();
  if (await isDaemonAlive()) return policy.sha256;
  if (IS_MAC) {
    const child = spawn(
      "open",
      [
        "-n",
        "--env",
        `CUA_DRIVER_DATA_HOME=${cuaDataHome()}`,
        "--env",
        `CUA_DRIVER_MANAGED_POLICY_FILE=${policy.path}`,
        "--env",
        `${ENDPOINT_TOKEN_ENV}=${endpoint().tokenFile}`,
        helperRoot,
        "--args",
        ...daemonServeArgs(),
      ],
      { detached: true, stdio: "ignore", env: daemonEnv(policy.path) },
    );
    child.unref();
    log.info("[Cua] daemon launch dispatched:", endpoint().socketPath);
    return policy.sha256;
  }
  if (IS_WIN || IS_LINUX) {
    const child = spawn(helperExecutable(helperRoot), daemonServeArgs(), {
      detached: true, stdio: "ignore", env: daemonEnv(policy.path),
    });
    child.unref();
    log.info("[Cua] daemon spawn dispatched:", endpoint().socketPath);
    return policy.sha256;
  }
  throw new Error(`unsupportedPlatform:${process.platform}`);
}

/**
 * 停 daemon：协议优先（`stop --socket`，官方 stop 子命令），失败兜底按端点匹配强杀。
 * 导出供退出清理链消费（commercialAuth.stopExtras 与 will-quit 钩子双触发，幂等）。
 */
export async function stopDaemon(): Promise<void> {
  const helperPath = findHelperApp();
  let stopped = false;
  if (helperPath) {
    try {
      await pexec(helperExecutable(helperPath), ["stop", "--socket", endpoint().socketPath], {
        timeout: 4000,
        env: { ...process.env, [ENDPOINT_TOKEN_ENV]: endpoint().tokenFile },
      });
      log.info("[Cua] daemon stopped via protocol");
      stopped = true;
    } catch {
      // 协议停失败（未运行/超时）→ 回退强杀
    }
  }
  try {
    if (stopped) return;
    if (!IS_WIN) {
      await pexec("pkill", ["-f", `serve --socket ${endpoint().socketPath}`]);
    }
  } catch {
    // 未在运行，无需清理
  } finally {
    // 升级前固定端点上的旧 unrestricted daemon 也必须收掉。
    if (helperPath) {
      const legacyEnv = { ...process.env };
      delete legacyEnv[ENDPOINT_TOKEN_ENV];
      await pexec(helperExecutable(helperPath), ["stop", "--socket", LEGACY_SOCKET_PATH], {
        timeout: 4000, env: legacyEnv,
      }).catch(() => undefined);
    }
    if (IS_WIN) {
      // 包含升级前固定 pipe 与新的随机 pipe；按同产品 serve 命令线兜底清理。
      await pexec("powershell", [
        "-NoProfile", "-Command",
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*serve --socket *nuwax-computer-use*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
      ]).catch(() => undefined);
    } else {
      await pexec("pkill", ["-f", `serve --socket ${LEGACY_SOCKET_PATH}`]).catch(() => undefined);
      // token/manifest 丢失时无法恢复旧随机端点；按产品 helper 名清理孤儿 daemon。
      const helperPattern = IS_MAC
        ? "Nuwax Computer Use.*serve --socket"
        : "NuwaxComputerUse.*serve --socket";
      await pexec("pkill", ["-f", helperPattern]).catch(() => undefined);
    }
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

function consentPending(): boolean {
  const step1 = readSetting(STEP1_KEY) as { computerUseConsentPending?: boolean } | null;
  return step1?.computerUseConsentPending === true;
}

function persistConsentPending(pending: boolean): void {
  const step1 = (readSetting(STEP1_KEY) ?? {}) as Record<string, unknown>;
  writeSetting(STEP1_KEY, { ...step1, computerUseConsentPending: pending });
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
    if (enabled) throw new Error("databaseNotReady");
    log.warn("[Cua] Database not ready, skip MCP removal");
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
        args: ["mcp", "--socket", endpoint().socketPath],
        env: { [ENDPOINT_TOKEN_ENV]: endpoint().tokenFile },
        enabled: true,
        allowTools: CUA_ALLOWED_TOOLS,
        denyTools: CUA_DENIED_TOOLS,
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
  let running = await isDaemonAlive();
  const permissions = running && IS_MAC
    ? await probeDaemonPermissions()
    : lastPermissionHint;
  if (running && IS_MAC) lastPermissionHint = permissions;
  let policyValid = true;
  if (running && readEnabled()) {
    try { policyValid = await verifyDaemonAuthorization(prepareCuaPolicy().sha256); }
    catch { policyValid = false; }
  }
  // 启动期尚未跑 ensureCuaOnBoot 时 monitor 不存在，不能把“尚未拉起”误判为掉线。
  if (readEnabled() && !cuaBootReconciling && !cuaLifecycleBusy &&
      ((!running && cuaMonitor !== null) ||
       (running && (!policyValid ||
        (IS_MAC && (!permissions.accessibility || !permissions.screenRecording)))))) {
    lastCuaError = !running ? "daemonNotReady" :
      !policyValid ? "policyNotActive" : "permissionsRequired";
    await serializeCua(async () => {
      if (readEnabled()) await disableCua();
    }).catch((e) => log.warn("[Cua] status cleanup failed", e));
    running = await isDaemonAlive();
  }
  return {
    supported: IS_MAC || IS_WIN || IS_LINUX,
    installed: !!helperPath,
    installable: !helperPath && !!findBundledHelper(),
    running,
    enabled: readEnabled(),
    consentPending: consentPending(),
    mcpInjected: isMcpInjected(),
    socketPath: endpoint().socketPath,
    helperPath,
    ...permissions,
    error: lastCuaError,
  };
}

let lastCuaError: string | null = null;
let cuaBootReconciling = false;
let cuaMonitor: NodeJS.Timeout | null = null;
let cuaLifecycle: Promise<void> = Promise.resolve();
let cuaLifecycleBusy = false;
let cuaDisableEpoch = 0;

function serializeCua<T>(action: () => Promise<T>): Promise<T> {
  const next = cuaLifecycle.then(async () => {
    cuaLifecycleBusy = true;
    try { return await action(); }
    finally { cuaLifecycleBusy = false; }
  });
  cuaLifecycle = next.then(() => undefined, () => undefined);
  return next;
}

function stopCuaMonitor(): void {
  if (cuaMonitor) clearInterval(cuaMonitor);
  cuaMonitor = null;
}

function startCuaMonitor(): void {
  stopCuaMonitor();
  cuaMonitor = setInterval(() => {
    void getCuaStatus().catch((e) => log.warn("[Cua] status monitor failed", e));
  }, 30_000);
  cuaMonitor.unref();
}

async function disableCua(): Promise<void> {
  stopCuaMonitor();
  persistEnabled(false);
  persistConsentPending(false);
  try {
    await syncCuaMcpConfig(false);
  } finally {
    await stopDaemon();
    if (!(await waitForDaemonStopped(3000))) throw new Error("helperStillRunning");
  }
}

export async function setCuaEnabled(enabled: boolean): Promise<{
  success: boolean;
  error?: string;
  status: CuaStatus;
}> {
  if (!enabled) cuaDisableEpoch++;
  const epoch = cuaDisableEpoch;
  return serializeCua(() => setCuaEnabledUnlocked(enabled, epoch));
}

async function setCuaEnabledUnlocked(enabled: boolean, epoch: number): Promise<{
  success: boolean; error?: string; status: CuaStatus;
}> {
  if (!enabled) {
    try {
      await disableCua();
      lastPermissionHint = { accessibility: null, screenRecording: null };
      lastCuaError = null;
      return { success: true, status: await getCuaStatus() };
    } catch (e) {
      lastCuaError = "disableFailed";
      log.warn("[Cua] disable failed", e);
      return { success: false, error: lastCuaError, status: await getCuaStatus() };
    }
  }
  try {
    // 此调用只在用户接受一次性全范围确认后发出；系统授权未完成时保留待办。
    persistConsentPending(true);
    // 任何旧条目先撤销；直到安装、系统授权和 daemon 双重探测全部通过才持久启用。
    persistEnabled(false);
    await syncCuaMcpConfig(false);
    const installed = await installCuaHelper();
    if (!installed.success || !installed.installedPath) {
      throw new Error(installed.error ?? "helperNotInstalled");
    }
    if (IS_MAC) {
      const permission = await requestCuaPermissions();
      if (!permission.success || !permission.accessibility || !permission.screenRecording) {
        throw new Error(permission.error ?? "permissionsRequired");
      }
    }
    if (epoch !== cuaDisableEpoch) throw new Error("disabledDuringEnable");
    await stopDaemon();
    if (!(await waitForDaemonStopped(3000))) throw new Error("helperStillRunning");
    const policySha256 = await launchDaemon(installed.installedPath);
    if (!(await waitForSocket(8000))) throw new Error("daemonNotReady");
    if (!(await verifyDaemonAuthorization(policySha256))) throw new Error("policyNotActive");
    if (IS_MAC) {
      const confirmed = await waitForDaemonPermissions(8000);
      lastPermissionHint = confirmed;
      if (!confirmed.accessibility || !confirmed.screenRecording) {
        throw new Error("permissionsRequired");
      }
    }
    if (epoch !== cuaDisableEpoch) throw new Error("disabledDuringEnable");
    await syncCuaMcpConfig(true);
    if (epoch !== cuaDisableEpoch) throw new Error("disabledDuringEnable");
    persistEnabled(true);
    persistConsentPending(false);
    lastCuaError = null;
    startCuaMonitor();
    return { success: true, status: await getCuaStatus() };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    lastCuaError = reason;
    log.warn("[Cua] enable rejected", reason);
    await disableCua().catch((cleanupError) =>
      log.warn("[Cua] enable cleanup failed", cleanupError),
    );
    if (reason === "permissionsRequired" || reason === "timeout") persistConsentPending(true);
    return { success: false, error: reason, status: await getCuaStatus() };
  }
}

/**
 * 启动期收敛（幂等）：开关开着则拉起 daemon 并确保 MCP 条目在位；
 * helper 已不存在则清掉条目防僵尸（升级/卸载残留场景）。挂在商业版
 * lifecycle start 回调（restartAllServicesNow 之后，不阻塞启动主链）。
 */
export async function ensureCuaOnBoot(): Promise<void> {
  const epoch = cuaDisableEpoch;
  return serializeCua(() => ensureCuaOnBootUnlocked(epoch));
}

async function ensureCuaOnBootUnlocked(epoch: number): Promise<void> {
  if (!readEnabled()) {
    if (isMcpInjected()) await syncCuaMcpConfig(false);
    return;
  }
  cuaBootReconciling = true;
  try {
    const installed = await installCuaHelper();
    if (!installed.success || !installed.installedPath) {
      throw new Error(installed.error ?? "helperNotInstalled");
    }
    if (epoch !== cuaDisableEpoch) throw new Error("disabledDuringBoot");
    await stopDaemon();
    if (!(await waitForDaemonStopped(3000))) throw new Error("helperStillRunning");
    const policySha256 = await launchDaemon(installed.installedPath);
    if (!(await waitForSocket(8000))) throw new Error("daemonNotReady");
    if (!(await verifyDaemonAuthorization(policySha256))) throw new Error("policyNotActive");
    if (epoch !== cuaDisableEpoch) throw new Error("disabledDuringBoot");
    if (IS_MAC) {
      const confirmed = await waitForDaemonPermissions(8000);
      lastPermissionHint = confirmed;
      if (!confirmed.accessibility || !confirmed.screenRecording) {
        throw new Error("permissionsRequired");
      }
    }
    await syncCuaMcpConfig(true);
    if (epoch !== cuaDisableEpoch) throw new Error("disabledDuringBoot");
    lastCuaError = null;
    startCuaMonitor();
  } catch (e) {
    log.warn("[Cua] boot: daemon launch failed", e);
    lastCuaError = e instanceof Error ? e.message : String(e);
    await disableCua().catch((cleanupError) =>
      log.warn("[Cua] boot cleanup failed", cleanupError),
    );
  } finally {
    cuaBootReconciling = false;
  }
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

/** 校验 helper 签名与 bundle id（防同名近似条目/被篡改的 bundled 源）。 */
async function verifyHelperSignature(
  appPath: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!IS_MAC) return { ok: true };
  try {
    await pexec("codesign", ["--verify", "--strict", appPath]);
    // codesign -dv 的详细信息输出在 stderr
    const r = await pexec("codesign", ["-dv", "--verbose=2", appPath]);
    const out = `${r.stderr ?? ""}\n${r.stdout ?? ""}`;
    const id = /^Identifier=(.+)$/m.exec(out)?.[1]?.trim();
    const team = /^TeamIdentifier=(.+)$/m.exec(out)?.[1]?.trim();
    if (id !== HELPER_BUNDLE_ID) {
      return { ok: false, error: `bundle-id-mismatch:${id ?? "none"}` };
    }
    if (app.isPackaged && team !== HELPER_TEAM_ID) {
      return { ok: false, error: `team-id-mismatch:${team ?? "none"}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `codesign-failed:${String(e).slice(0, 120)}` };
  }
}

/** 以路径、类型和文件内容生成稳定校验值，避免仅凭“文件存在”跳过 helper 升级。 */
function helperDigest(root: string): string {
  const hash = createHash("sha256");
  const visit = (target: string, relative: string) => {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      hash.update(`L:${relative}:${fs.readlinkSync(target)}\n`);
    } else if (stat.isDirectory()) {
      hash.update(`D:${relative}\n`);
      for (const name of fs.readdirSync(target).sort()) {
        visit(path.join(target, name), path.join(relative, name));
      }
    } else if (stat.isFile()) {
      hash.update(`F:${relative}:${stat.size}\n`);
      hash.update(fs.readFileSync(target));
    } else {
      throw new Error(`unsupported helper entry: ${relative}`);
    }
  };
  visit(root, "");
  return hash.digest("hex");
}

function recoverInterruptedHelperInstall(): void {
  const dest = path.join(stableInstallDir(), helperArtifactName());
  if (fs.existsSync(dest) || !fs.existsSync(stableInstallDir())) return;
  const prefix = IS_MAC
    ? `${helperArtifactName().slice(0, -4)}.backup-`
    : `${helperArtifactName()}.backup-`;
  const backups = fs.readdirSync(stableInstallDir())
    .filter((name) => name.startsWith(prefix))
    .map((name) => path.join(stableInstallDir(), name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (backups[0]) fs.renameSync(backups[0], dest);
}

/**
 * 首用透明安装：随包 Resources 的 helper → userData/computer-use 稳定路径。
 * 校验 bundled → 临时副本 → 原子替换稳定路径；失败恢复旧版本。
 * 系统授权仅在用户显式开启时请求，安装本身不弹权限窗。
 */
export async function installCuaHelper(): Promise<CuaInstallResult> {
  try {
    recoverInterruptedHelperInstall();
  } catch (e) {
    return { success: false, error: `install-recovery:${String(e).slice(0, 120)}` };
  }
  const bundled = findBundledHelper();
  const existing = findHelperApp();
  if (!bundled) {
    if (existing && !app.isPackaged) return { success: true, installedPath: existing };
    return { success: false, error: "bundledNotFound" };
  }
  const verify = await verifyHelperSignature(bundled);
  if (!verify.ok) return { success: false, error: verify.error };
  const dest = path.join(stableInstallDir(), helperArtifactName());
  const suffix = `${process.pid}-${randomUUID()}`;
  const staged = IS_MAC ? `${dest.slice(0, -4)}.stage-${suffix}.app` : `${dest}.stage-${suffix}`;
  const backup = IS_MAC ? `${dest.slice(0, -4)}.backup-${suffix}.app` : `${dest}.backup-${suffix}`;
  const lock = path.join(stableInstallDir(), ".install-lock");
  const lockTemp = `${lock}.stage-${suffix}`;
  let movedOld = false;
  let movedNew = false;
  try {
    fs.mkdirSync(stableInstallDir(), { recursive: true });
    const sourceDigest = helperDigest(bundled);
    if (fs.existsSync(dest) && helperDigest(dest) === sourceDigest) {
      const installedVerify = await verifyHelperSignature(dest);
      if (installedVerify.ok) return { success: true, installedPath: dest };
    }
    fs.cpSync(bundled, staged, { recursive: true, verbatimSymlinks: true });
    if (IS_LINUX) {
      fs.chmodSync(staged, 0o755);
    }
    if (IS_MAC) {
      await pexec("xattr", ["-cr", staged]).catch(() => undefined);
      const v2 = await verifyHelperSignature(staged);
      if (!v2.ok) return { success: false, error: `install-verify:${v2.error}` };
    }
    if (helperDigest(staged) !== sourceDigest) throw new Error("helperCopyMismatch");
    if (fs.existsSync(dest)) {
      await stopDaemon();
      if (!(await waitForDaemonStopped(3000))) throw new Error("helperStillRunning");
      fs.renameSync(dest, backup);
      movedOld = true;
    }
    fs.renameSync(staged, dest);
    movedNew = true;
    fs.writeFileSync(lockTemp, JSON.stringify({
      installedAt: new Date().toISOString(), source: bundled, sha256: sourceDigest,
    }));
    fs.renameSync(lockTemp, lock);
    if (IS_MAC) {
      await pexec(LSREGISTER, ["-f", dest]).catch(() => undefined);
      await pexec("mdimport", [dest]).catch(() => undefined);
    }
    if (movedOld) {
      try { fs.rmSync(backup, { recursive: true, force: true }); }
      catch (e) { log.warn("[Cua] stale helper backup cleanup failed", e); }
    }
  } catch (e) {
    try {
      if (movedNew) fs.rmSync(dest, { recursive: true, force: true });
      if (movedOld) fs.renameSync(backup, dest);
    } catch (rollbackError) {
      return { success: false, error: `install-rollback:${String(rollbackError).slice(0, 120)}` };
    }
    return { success: false, error: String(e).slice(0, 200) };
  } finally {
    try { fs.rmSync(staged, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(lockTemp, { force: true }); } catch { /* best effort */ }
  }
  log.info("[Cua] helper installed to", dest);
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
  /** 已接受一次性确认、仍待系统授权；仅显式重试可继续启用。 */
  consentPending: boolean;
  mcpInjected: boolean;
  socketPath: string;
  helperPath: string | null;
  accessibility: boolean | null;
  screenRecording: boolean | null;
  /** 最近一次启用或运行时检查失败原因；禁用/重试成功后清除。 */
  error: string | null;
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
    `cua-driver-permissions-${process.pid}-${randomUUID()}.json`,
  );
  lastPermissionHint = { accessibility: null, screenRecording: null };
  try {
    fs.rmSync(resultFile, { force: true });
    fs.writeFileSync(resultFile, "", { mode: 0o600 });
  } catch {
    // 结果文件写不进去时宿主自身会以安全码退出，此处不拦截
  }
  let spawnFailed = false;
  try {
    const child = spawn(
      "open",
      [
        "-n", "-g", "--env", `CUA_DRIVER_DATA_HOME=${cuaDataHome()}`,
        helperPath, "--args", "__permissions-host-request",
        "--result-file", resultFile, "--probe-direct-capture",
      ],
      { detached: true, stdio: "ignore" },
    );
    child.on("error", () => { spawnFailed = true; });
    child.unref();
  } catch {
    fs.rmSync(resultFile, { force: true });
    return { success: false, error: "permissionHostFailed", ...lastPermissionHint };
  }
  // 权限宿主完成探测即退出并写结果；等待上限 20s
  for (let i = 0; i < 40; i++) {
    if (spawnFailed) {
      fs.rmSync(resultFile, { force: true });
      return { success: false, error: "permissionHostFailed", ...lastPermissionHint };
    }
    await new Promise((r) => setTimeout(r, 500));
    try {
      const raw = fs.readFileSync(resultFile, "utf-8");
      if (raw.trim()) {
        const sc = (JSON.parse(raw).structuredContent ?? {}) as {
          accessibility?: boolean;
          screen_recording?: boolean;
          screen_recording_capturable?: boolean;
          direct_capture_verification_error?: unknown;
          direct_capture_verification?: { bundle_id?: string };
          source?: { attribution?: string; bundle_id?: string };
        };
        lastPermissionHint = {
          accessibility: typeof sc.accessibility === "boolean" ? sc.accessibility : null,
          screenRecording: typeof sc.screen_recording === "boolean" ? sc.screen_recording : null,
        };
        fs.rmSync(resultFile, { force: true });
        if (!sc.accessibility || !sc.screen_recording ||
            sc.screen_recording_capturable !== true ||
            sc.direct_capture_verification_error != null ||
            sc.direct_capture_verification?.bundle_id !== HELPER_BUNDLE_ID ||
            sc.source?.attribution !== "driver-daemon" ||
            sc.source.bundle_id !== HELPER_BUNDLE_ID) {
          return { success: false, error: "permissionsRequired", ...lastPermissionHint };
        }
        return { success: true, ...lastPermissionHint };
      }
    } catch {
      // 尚未写完，继续轮询
    }
  }
  fs.rmSync(resultFile, { force: true });
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
