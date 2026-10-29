/**
 * Computer Use（cua helper）服务 —— 商业版实现（overlay 托管）。
 * 契约/配方出处：docs/20260917-computer-use-integration-v2.md（附录 D spike 实证）：
 *  - helper = 独立 .app（TCC 自有身份），LaunchServices `open` 拉起 `serve --socket <私有路径>`；
 *    Windows 无 TCC，helper = 独立 exe 直接 spawn（照 sandbox-helper 模式）。
 *  - MCP 条目 = `cua` StdioMcpServerEntry（bundled Node stdio → 主进程网关 → helper mcp），
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
import { CuaTaskController, CUA_FINAL_REASONS } from "./taskController";
import { CuaTaskRegistry } from "./taskRegistry";
import { CUA_WINDOW_TASK_TOOLS, taskCuaCall } from "./taskPolicy";
import { CUA_DISABLED_NOTICE, CUA_ENABLED_NOTICE, publishCuaCapabilityNotice } from "./cuaSessionNotice";
import { callIdentity, CuaConfirmationGate, isDeniedCuaApp, readCuaAuthMode, readCuaBlacklist, type CuaAuthMode } from "./cuaSafety";
import { CuaElementIndex, resolveAndGuardCuaCall } from "./cuaTargeting";
import { cleanupStaleScreenshots, cuaScreenshotHome, listLocalScreenshotNames, sanitizeCuaObservation } from "./cuaPrivacy";
import { discoverInstalledApps, type InstalledApp } from "./cuaApps";
import type { CuaWindowFrame } from "./windowBadges";
import type { CuaExecutionMode } from "@shared/features/computer-use/contract";
import { CuaMcpGateway, CUA_STDIO_RELAY } from "./mcpGateway";
import { computerUseHost } from "./ports";
import { readCuaPreferences, writeCuaPreferences } from "./preferences";
import { cuaSessionAuthority } from "./sessionAuthority";
import type { CuaRuntime, CuaControlResult, CuaCheck, CuaScope, CuaWindow } from "@shared/features/computer-use/contract";
import { CuaBrowserBindings, cuaPolicy, scopeCuaCall, visibleCuaTools } from "./windowScope";
import log from "electron-log";

const pexec = promisify(execFile);

const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";
const IS_LINUX = process.platform === "linux";

const HELPER_APP_NAME = "Nuwax Computer Use.app";
const HELPER_EXEC_NAME = "Nuwax Computer Use";
const HELPER_EXE_NAME = "NuwaxComputerUse.exe";
const HELPER_BIN_NAME = "NuwaxComputerUse";
const MCP_SERVER_ID = "cua";
const conversationForOwner = (owner: string) => cuaSessionAuthority.conversationForOwner(owner);
const cuaTasks = new CuaTaskController({ conversationForOwner });
const windowTasks = new CuaTaskRegistry(4, conversationForOwner);
let runtimeRevision = 0;
cuaTasks.subscribe(() => { runtimeRevision++; });
windowTasks.subscribe(() => { runtimeRevision++; });
windowTasks.onDeadline((id, reason) => { void pauseWindowTask(id, reason).catch(() => undefined); });
let multiwindow = false;
let multiwindowCapable = false;
let previewCapable = false;
let previewSequence = 0;
let previewSuppressed = false;
export function setCuaPreviewSuspended(value: boolean) { previewSuppressed = value; windowTasks.notify(); }
let nativeStoppedEpoch = -1;
const taskControls = new Map<string, Promise<unknown>>();
const frameListeners = new Set<(frames: CuaWindowFrame[]) => void>();
let frameMonitor: ReturnType<typeof setInterval> | undefined;
let framePollBusy = false;
export function onCuaWindowFrames(listener: (frames: CuaWindowFrame[]) => void) {
  frameListeners.add(listener); return () => { frameListeners.delete(listener); };
}
function publishFrames(frames: CuaWindowFrame[]) {
  for (const listener of frameListeners) { try { listener(frames); } catch { /* Never delay a native revoke. */ } }
}
async function pollWindowTasks() {
  if (framePollBusy || !multiwindow || !multiwindowCapable || runtimeSuspended) return;
  const live = windowTasks.list().filter((task) => ["running", "paused"].includes(task.phase));
  if (!live.length) { publishFrames([]); return; }
  framePollBusy = true;
  const pollEpoch = cuaDisableEpoch;
  try {
    const reply = await requestDaemon("nuwax_task", "states", {});
    if (pollEpoch !== cuaDisableEpoch || !multiwindow || runtimeSuspended) { publishFrames([]); return; }
    const values = reply?.result?.tasks;
    if (!reply?.ok || !Array.isArray(values)) { publishFrames([]); return; }
    const frames: CuaWindowFrame[] = [];
    for (const value of values) {
      const task = windowTasks.byId(value.task_id);
      if (!task || !task.target || value.binding_id !== task.bindingId || value.epoch !== task.epoch ||
        !["running", "paused"].includes(task.controller.snapshot().phase) || !live.some((item) => item.taskId === task.id)) continue;
      const state = value.window;
      windowTasks.setColor(task.id, value.color);
      if (state?.valid !== true && task.controller.snapshot().phase === "running")
        void pauseWindowTask(task.id, "targetClosed");
      else if (state?.foreground === true && task.mode === "background" && task.controller.snapshot().phase === "running")
        void pauseWindowTask(task.id, "userTakingControl");
      if (state?.bounds && ["x", "y", "width", "height"].every((key) => Number.isFinite(state.bounds[key]))) {
        frames.push({ taskId: task.id, color: task.color, phase: task.controller.snapshot().phase,
          visible: state.visible === true, controlPending: task.pending, reason: task.controller.snapshot().reason, bounds: state.bounds });
      }
    }
    publishFrames(frames);
  } finally { framePollBusy = false; }
}
let cuaGateway: CuaMcpGateway | null = null;
const cuaBindings = new CuaBrowserBindings();
let runtimeSuspended = false;
let shortcutAvailable = false;
let pendingControls = 0;
let preparingRuntime = false;
let cuaScope: CuaScope = { kind: "desktop" };
let scopeInitialized = false;
const confirmationGate = new CuaConfirmationGate();
const cuaElements = new CuaElementIndex();

export function allowCuaSensitiveOnce(taskId?: string): boolean {
  const task = taskId ? windowTasks.byId(taskId) : undefined;
  if (taskId && !task) return false;
  return confirmationGate.allow(task?.owner);
}
function initializeScopePreference() {
  if (scopeInitialized) return;
  scopeInitialized = true;
  const saved = readStep1() as { computerUseScopeKind?: string } | null;
  multiwindow = !IS_LINUX && (saved?.computerUseScopeKind === "window" || (saved as { computerUseMultiwindow?: boolean } | null)?.computerUseMultiwindow === true);
  // Native IDs are not durable. A previous window scope must never widen on restart.
  if (!multiwindow && saved?.computerUseScopeKind === "window") cuaScope = { kind: "window", pid: 0, windowId: 0, label: "" };
}
export const getCuaRuntime = (): CuaRuntime => ({ ...(multiwindow ? windowTasks.snapshot() : cuaTasks.snapshot()),
  presentationConversationId: computerUseHost().getConversationId?.() ?? null,
  ...(!multiwindow ? { scope: structuredClone(cuaScope) } : {}), revision: runtimeRevision,
  recoverable: runtimeSuspended && readEnabled(),
  shortcutAvailable, controlPending: pendingControls > 0 || (multiwindow && windowTasks.list().some((task) => task.controlPending)) });
export const onCuaRuntime = (listener: (state: CuaRuntime) => void) => {
  const emit = () => listener(getCuaRuntime());
  const legacy = cuaTasks.subscribe(emit), tasks = windowTasks.subscribe(emit);
  return () => { legacy(); tasks(); };
};
export function setCuaShortcutAvailable(value: boolean) { shortcutAvailable = value; cuaTasks.notify(); }
/** Presentation changes get the same monotonic revision as task updates, including IPC replies. */
export function notifyCuaPresentation() { cuaTasks.notify(); }

async function ensureCuaGateway(helperRoot: string): Promise<string> {
  const selected = endpoint();
  const socketPath = IS_WIN ? `${selected.socketPath}-gateway` : path.join(path.dirname(selected.socketPath), "g");
  if (!cuaGateway) {
    cuaGateway = new CuaMcpGateway({
      controller: multiwindow ? windowTasks : cuaTasks,
      tasks: multiwindow ? windowTasks : undefined,
      discoverWindows: listAllowedNativeCuaWindows,
      prepareTarget: async (owner, tool, raw) => {
        if (!["get_window_state", "get_accessibility_tree", "get_desktop_state"].includes(tool)) return;
        if (!multiwindow) {
          if (cuaScope.kind !== "window" || cuaScope.windowId > 0) return;
          const args = raw as { pid?: unknown; window_id?: unknown } | null;
          const target = (await listCuaWindows()).find(window => window.pid === args?.pid && window.windowId === args?.window_id);
          if (!target) throw new Error("targetClosed");
          // Linux has no multiwindow native protocol. Rebuild the narrow helper
          // policy after validation, preserving the existing agent connection.
          const gateway = cuaGateway;
          gateway?.pauseTransports();
          cuaScope = { kind: "window", ...target };
          await ensureCuaOnBoot();
          if (runtimeSuspended) throw new Error("daemonNotReady");
          await gateway?.resumeTransports();
          return;
        }
        const task = windowTasks.ensure(owner);
        if (task.target) return;
        const args = raw as { pid?: unknown; window_id?: unknown } | null;
        if (!Number.isSafeInteger(args?.pid) || !Number.isSafeInteger(args?.window_id)) throw new Error("targetRequired");
        const bound = await bindWindowTask(task.id, { pid: args!.pid, windowId: args!.window_id });
        if (!bound.success) throw new Error(bound.error ?? "targetClosed");
        const resumed = await resumeWindowTask(task.id);
        if (!resumed.success) throw new Error(resumed.error ?? "cannotResume");
      },
      allowedTools: CUA_ALLOWED_TOOLS.filter(tool => !tool.startsWith("set_agent_cursor_")),
      visibleTools: () => multiwindow ? [...CUA_WINDOW_TASK_TOOLS, "list_windows"] : visibleCuaTools(cuaScope, CUA_ALLOWED_TOOLS),
      scope: (owner) => multiwindow ? windowTasks.scopeFor(owner ?? "") : cuaScope,
      authorize: (grant) => cuaSessionAuthority.authorize(grant),
      transformCall: (tool, args, owner) => {
        // 先把坐标收成最新观察的 element_index，再拦敏感控件，最后才套窗口 scope。
        const guarded = resolveAndGuardCuaCall(tool, args, cuaElements.latest(owner ?? ""));
        if (!multiwindow) return scopeCuaCall(cuaScope, guarded.tool, guarded.args, cuaBindings);
        const task = windowTasks.ensure(owner!);
        if (!task.target) throw new Error("targetRequired");
        return taskCuaCall(windowTasks.scopeFor(owner!), task.mode, guarded.tool, guarded.args);
      },
      beforeCall: multiwindow ? async (owner, call) => {
        const context = windowTasks.nativeContext(owner);
        const reply = await requestDaemon("nuwax_task", "bind", context);
        if (!reply?.ok) throw new Error("targetClosed");
        return { ...call, args: { ...(call.args as Record<string, unknown>), _nuwax_task: context } };
      } : undefined,
      onResult: (tool, args, outcome, structured, owner) => {
        cuaBindings.record(cuaScope, tool, args, outcome, structured);
        if (owner && outcome === "ok") confirmationGate.observe(owner, tool, args, structured);
        cuaElements.remember(owner ?? "", tool, outcome, structured);
      },
      agentCursor: () => readAgentCursorEnabled(),
      requireConfirmation: (tool, args, owner) => readCuaAuthMode(readStep1().computerUseAuthMode) === "ask"
        && confirmationGate.requires(owner, tool, args, false),
      confirmDispatch: (tool, args, owner) => readCuaAuthMode(readStep1().computerUseAuthMode) !== "ask"
        || !confirmationGate.requires(owner, tool, args),
      rejectTarget: async (tool, raw) => {
        const blacklist = readCuaBlacklist(readStep1().computerUseBlacklist);
        const args = (raw ?? {}) as Record<string, unknown>;
        const id = callIdentity(args);
        const bound = cuaBindings.nativeTarget(args);
        const pid = id.pid ?? bound?.pid, windowId = args.window_id ?? bound?.window_id;
        // Model labels never establish native identity. Resolve the final scoped target live.
        const windows = await readLiveCuaWindows();
        const matching = windows.filter(window => (!pid || window.pid === pid) && (!windowId || window.window_id === windowId));
        if (tool === "get_desktop_state") return windows.some(window =>
          isDeniedCuaApp([window.app_name, window.title], blacklist)) ? "blacklisted" : null;
        if (pid || windowId) return !matching.length ? "targetClosed" : matching.some(window =>
          isDeniedCuaApp([window.app_name, window.title], blacklist)) ? "blacklisted" : null;
        if (["check_permissions", "health_report", "get_config", "start_session", "end_session"].includes(tool)) return null;
        if (tool === "launch_app") return isDeniedCuaApp(Object.values(args).filter(value => typeof value === "string") as string[], blacklist)
          ? "blacklisted" : "scopeViolation";
        // With only built-in protection, permit untargeted canvas input only
        // while no protected window is present. User blacklists remain fail-closed.
        if (!blacklist.length && !windows.some(window => isDeniedCuaApp([window.app_name, window.title]))) return null;
        return "scopeViolation";
      },
      sanitizeResult: (tool, result) => {
        if (["get_window_state", "get_desktop_state", "get_accessibility_tree", "get_browser_state"].includes(tool))
          sanitizeCuaObservation(result);
      },
      launch: () => spawn(helperExecutable(helperRoot), ["mcp", "--socket", selected.socketPath], {
        env: { ...process.env, CUA_DRIVER_RS_TELEMETRY_ENABLED: "false", [ENDPOINT_TOKEN_ENV]: selected.tokenFile }, stdio: ["pipe", "pipe", "pipe"],
      }),
      onFailure: (reason, owner) => {
        const task = owner && multiwindow ? windowTasks.stateForOwner(owner) : undefined;
        if (task) void pauseWindowTask(task.taskId, reason).catch(() => undefined);
        else void pauseCuaTask(reason).catch(() => undefined);
      },
    });
  }
  if (!cuaGateway.ready && !IS_WIN) fs.rmSync(socketPath, { force: true });
  await cuaGateway.listen(socketPath, selected.token);
  if (!IS_WIN) fs.chmodSync(socketPath, 0o600);
  const relayScript = stdioRelayScriptPath();
  cuaSessionAuthority.configure(path.join(stableInstallDir(), `session-grants-${process.pid}`),
    (file) => ({ command: computerUseHost().resolveNodeBinary()!, args: [relayScript],
      env: { NUWAX_CUA_GATEWAY: socketPath, NUWAX_CUA_GATEWAY_TOKEN: selected.tokenFile, NUWAX_CUA_SESSION_FILE: file } }),
    (owner, cancelled) => {
      confirmationGate.retire(owner); cuaElements.forget(owner);
      if (multiwindow) {
        const task = windowTasks.stateForOwner(owner);
        if (task) void finishWindowTask(task.taskId, cancelled).catch(() => undefined);
        return;
      }
      if (cuaTasks.owns(owner)) {
        if (cancelled || cuaTasks.hasPending(owner) || cuaTasks.snapshot().phase === "paused") void suspendCua("sessionEnded").catch(() => undefined);
        else { cuaTasks.complete(owner); sweepCuaScreenshots(); void cuaGateway?.releaseOwner(owner).catch(() => undefined); }
      }
      cuaTasks.retire(owner);
    });
  return socketPath;
}

const HELPER_TEAM_ID = "89GQ2RJVW7";
// Opaque trajectory replay would bypass per-action observation and step budgets.
const CUA_DENIED_TOOLS = ["check_for_update", "install_ffmpeg", "replay_trajectory"];
// 仅暴露已审过的 driver 工具；driver 升级新增的工具须显式审核后加入。
const CUA_ALLOWED_TOOLS = [
  "bring_to_front", "browser_click", "browser_dialog", "browser_download",
  "browser_navigate", "browser_pointer", "browser_prepare", "browser_set_input_files",
  "browser_type", "check_permissions", "click", "clipboard_read", "clipboard_write",
  "double_click", "drag", "end_session", "escalate_session",
  "get_accessibility_tree", "get_agent_cursor_state", "get_browser_state", "get_config",
  "get_cursor_position", "get_desktop_state", "get_recording_state", "get_screen_size",
  "get_session", "get_session_state", "get_window_state", "health_report", "hotkey",
  "invoke_menu", "kill_app", "launch_app", "list_apps", "list_sessions",
  "list_windows", "move_cursor", "page", "press_key",
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

/**
 * stdio 中继脚本落盘路径（原子写，内容不变即复用）。引擎侧在 Windows 经 shell
 * 拼接启动 MCP stdio 服务器，多行 `-e` 内联参数会在首个换行被截断（node 报
 * "-e requires an argument"）；必须以脚本文件路径传参，与其他 MCP 条目同构。
 */
function stdioRelayScriptPath(): string {
  const file = path.join(stableInstallDir(), "cua-stdio-relay.cjs");
  try { if (fs.readFileSync(file, "utf8") === CUA_STDIO_RELAY) return file; } catch { /* 首次或被清理 */ }
  const staged = `${file}.${randomUUID()}.stage`;
  fs.writeFileSync(staged, CUA_STDIO_RELAY, { mode: 0o644 });
  fs.renameSync(staged, file);
  return file;
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

async function requestDaemon(method: string, name?: string, args?: Record<string, unknown>, maxResponseBytes = 65536): Promise<DaemonReply | null> {
  return new Promise((resolve) => {
    let selected: CuaEndpoint;
    try { selected = endpoint(); }
    catch { resolve(null); return; }
    const socket = net.connect(selected.socketPath);
    let settled = false;
    let response = "";
    let proofAccepted = false;
    // Direct host reads must not reuse the daemon's expiring implicit session.
    // A control lease on this connection reaps only this call's session on EOF.
    const hostSession = method === "call" ? `nuwax-host-${randomUUID()}` : undefined;
    let sessionReady = !hostSession;
    const nonce = randomBytes(16).toString("hex");
    const sendRequest = () => socket.write(`${JSON.stringify({
      method, name, args, ...(hostSession ? { session_id: hostSession } : {}),
      observation_origin: "direct", client_kind: "cli", nuwax_client_token: selected.token,
    })}\n`);
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
      if (Buffer.byteLength(response, "utf8") > maxResponseBytes) return finish();
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
            if (hostSession) socket.write(`${JSON.stringify({ method: "session_begin", session_id: hostSession,
              nuwax_client_token: selected.token })}\n`);
            else sendRequest();
          } else if (!sessionReady) {
            if (reply.ok !== true || reply.result?.session_begin !== true) return finish();
            sessionReady = true;
            sendRequest();
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
  for (;;) {
    latest = await probeDaemonPermissions();
    if (latest.accessibility === true && latest.screenRecording === true) return latest;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
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
 * （与 nuwax.db 同源=APP_DATA_DIR_NAME 派生，由宿主经 FeatureContext.dataDir 注入）——
 * pid/telemetry·install 标记/history/浏览器 profile/libei restore token 全部内聚于此，
 * 机器上不再出现 cua-* 外部目录。
 */
function cuaDataHome(): string {
  return computerUseHost().dataHome;
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
    CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
    CUA_DRIVER_MANAGED_POLICY_FILE: policyPath,
    [ENDPOINT_TOKEN_ENV]: endpoint().tokenFile,
    CUA_DRIVER_NUWAX_WINDOW_TASKS: multiwindow ? "1" : "0",
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
  initializeScopePreference();
  const dir = cuaDataHome();
  const filename = "nuwax-capabilities.yaml";
  const target = path.join(dir, filename);
  const contents = Buffer.from(multiwindow
    ? cuaPolicy({ kind: "desktop" }, [...CUA_WINDOW_TASK_TOOLS, "list_windows", "bring_to_front", "set_agent_cursor_enabled"], CUA_DENIED_TOOLS)
    : cuaPolicy(cuaScope, CUA_ALLOWED_TOOLS, CUA_DENIED_TOOLS));
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
  if (multiwindow) {
    const metadata = await requestDaemon("metadata");
    multiwindowCapable = metadata?.result?.nuwax_window_tasks === 1;
    previewCapable = metadata?.result?.nuwax_window_preview === 1;
    if (!multiwindowCapable) return false;
    windowTasks.setAvailable(true);
  }
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
    // Startup/status reconciliation must never open a native permission gate.
    // Explicit enable uses the dedicated permission host before MCP injection.
    "--no-permissions-gate",
  ];
}

/** SIGKILL cannot unlink a Unix socket. Never replace a listening or foreign endpoint. */
async function reclaimStaleDaemonSocket(): Promise<void> {
  if (IS_WIN) return;
  const selected = endpoint();
  const directory = path.dirname(selected.socketPath);
  const before = fs.lstatSync(selected.socketPath, { throwIfNoEntry: false });
  if (!before) return;
  const parent = fs.lstatSync(directory);
  const owned = (stat: fs.Stats) => !process.getuid || stat.uid === process.getuid();
  const privateDirectory = (stat: fs.Stats) => stat.isDirectory() && !stat.isSymbolicLink() && owned(stat) && (stat.mode & 0o077) === 0;
  if (!privateDirectory(parent) || !before.isSocket() || !owned(before) || (before.mode & 0o077) !== 0)
    throw new Error("endpointSocketUntrusted");

  const state = await new Promise<"stale" | "gone" | "busy">((resolve) => {
    const socket = net.connect(selected.socketPath);
    let settled = false;
    const finish = (result: "stale" | "gone" | "busy") => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(750, () => finish("busy"));
    socket.on("connect", () => finish("busy"));
    socket.on("close", () => finish("busy"));
    socket.on("error", (error: NodeJS.ErrnoException) =>
      finish(error.code === "ECONNREFUSED" ? "stale" : error.code === "ENOENT" ? "gone" : "busy"));
  });
  if (state === "gone") return;
  if (state !== "stale") throw new Error("helperStillRunning");
  const current = fs.lstatSync(selected.socketPath, { throwIfNoEntry: false });
  if (!current) return;
  const currentParent = fs.lstatSync(directory);
  if (!privateDirectory(currentParent) || currentParent.dev !== parent.dev || currentParent.ino !== parent.ino ||
      !current.isSocket() || !owned(current) || (current.mode & 0o077) !== 0 ||
      current.dev !== before.dev || current.ino !== before.ino)
    throw new Error("endpointSocketUntrusted");
  fs.unlinkSync(selected.socketPath);
}

/** 拉起 daemon（幂等：先探活）。mac 走 LaunchServices（TCC 归 helper .app）；win/linux 直跑二进制。 */
async function launchDaemon(helperRoot: string): Promise<string> {
  const policy = prepareCuaPolicy();
  if (await isDaemonAlive()) return policy.sha256;
  await reclaimStaleDaemonSocket();
  if (IS_MAC) {
    const child = spawn(
      "open",
      [
        "-n",
        "--env", "CUA_DRIVER_NUWAX_WINDOW_TASKS=" + (multiwindow ? "1" : "0"),
        "--env",
        `CUA_DRIVER_DATA_HOME=${cuaDataHome()}`,
        "--env", "CUA_DRIVER_RS_TELEMETRY_ENABLED=false",
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
export async function stopDaemon(preservePermissionLinger = false): Promise<void> {
  if (!preservePermissionLinger) cancelCuaPermissionRequest();
  const helperPath = findHelperApp();
  const literal = (value: string) => value.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
  const executable = helperPath ? literal(helperExecutable(helperPath))
    : IS_MAC ? "/.*/Nuwax Computer Use" : "/.*/NuwaxComputerUse";
  const servingPrefix = `^${executable} serve --socket `;
  let stopped = false;
  if (helperPath) {
    try {
      await pexec(helperExecutable(helperPath), ["stop", "--socket", endpoint().socketPath], {
        timeout: 1500,
        env: { ...process.env, CUA_DRIVER_RS_TELEMETRY_ENABLED: "false", [ENDPOINT_TOKEN_ENV]: endpoint().tokenFile },
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
      await pexec("pkill", ["-KILL", "-f", `${servingPrefix}${literal(endpoint().socketPath)}( |$)`], { timeout: 1500 });
    }
  } catch {
    // 未在运行，无需清理
  } finally {
    // 升级前固定端点上的旧 unrestricted daemon 也必须收掉。
    if (helperPath) {
      const legacyEnv: NodeJS.ProcessEnv = { ...process.env, CUA_DRIVER_RS_TELEMETRY_ENABLED: "false" };
      delete legacyEnv[ENDPOINT_TOKEN_ENV];
      await pexec(helperExecutable(helperPath), ["stop", "--socket", LEGACY_SOCKET_PATH], {
        timeout: 1500, env: legacyEnv,
      }).catch(() => undefined);
    }
    if (IS_WIN) {
      // 包含升级前固定 pipe 与新的随机 pipe；按同产品 serve 命令线兜底清理。
      await pexec("powershell", [
        "-NoProfile", "-Command",
        "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'NuwaxComputerUse.exe' -and $_.CommandLine -like '*serve --socket *nuwax-computer-use*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
      ], { timeout: 1500 }).catch(() => undefined);
    } else {
      await pexec("pkill", ["-KILL", "-f", `${servingPrefix}${literal(LEGACY_SOCKET_PATH)}( |$)`], { timeout: 1500 }).catch(() => undefined);
      // token/manifest 丢失时无法恢复旧随机端点；按产品 helper 名清理孤儿 daemon。
      await pexec("pkill", ["-KILL", "-f", servingPrefix + ".*"], { timeout: 1500 }).catch(() => undefined);
    }
  }
}

function readEnabled(): boolean { return readCuaPreferences().computerUseEnabled === true; }

function persistEnabled(enabled: boolean, reason = "userPreference") {
  if (!writeCuaPreferences({ computerUseEnabled: enabled })) throw new Error("databaseNotReady");
  log.info("[Cua] enabled preference persisted", { enabled, reason });
}
function consentPending(): boolean { return readCuaPreferences().computerUseConsentPending === true; }
function persistConsentPending(pending: boolean): void {
  if (!writeCuaPreferences({ computerUseConsentPending: pending })) throw new Error("databaseNotReady");
}
function readStep1(): Record<string, unknown> { return readCuaPreferences(); }
function patchStep1(patch: Record<string, unknown>): boolean { return writeCuaPreferences(patch); }

export async function setCuaAuthMode(mode: unknown): Promise<{ success: boolean; error?: string; status: CuaStatus }> {
  if (!patchStep1({ computerUseAuthMode: readCuaAuthMode(mode) })) {
    return { success: false, error: "databaseNotReady", status: await getCuaStatus() };
  }
  confirmationGate.clear();
  return { success: true, status: await getCuaStatus() };
}

export async function setCuaBlacklist(list: unknown): Promise<{ success: boolean; error?: string; status: CuaStatus }> {
  if (!patchStep1({ computerUseBlacklist: readCuaBlacklist(list) })) {
    return { success: false, error: "databaseNotReady", status: await getCuaStatus() };
  }
  return { success: true, status: await getCuaStatus() };
}

export async function listCuaInstalledApps(): Promise<InstalledApp[]> {
  return discoverInstalledApps();
}

function sweepCuaScreenshots(): void {
  try { cleanupStaleScreenshots(cuaScreenshotHome(cuaDataHome())); }
  catch { log.warn("[Cua] screenshot retention sweep failed"); }
}

export function listCuaScreenshotFiles(): string[] {
  return listLocalScreenshotNames(cuaScreenshotHome(cuaDataHome()));
}

/** 缺省开：未写入或显式 true 都开模拟光标。不改变 Background 投递。 */
function readAgentCursorEnabled(): boolean {
  const step1 = readStep1() as { computerUseAgentCursor?: boolean };
  return step1?.computerUseAgentCursor !== false;
}

function persistAgentCursorEnabled(enabled: boolean): boolean {
  return patchStep1({ computerUseAgentCursor: enabled });
}

export async function setCuaAgentCursorEnabled(enabled: boolean): Promise<{
  success: boolean;
  error?: string;
  status: CuaStatus;
}> {
  if (!persistAgentCursorEnabled(enabled === true)) {
    return { success: false, error: "databaseNotReady", status: await getCuaStatus() };
  }
  return { success: true, status: await getCuaStatus() };
}

// ========== MCP 条目注入（宿主代管 mcp_local_config + MCP Proxy 同步；照 guiMcpLocalConfig 先例） ==========

function isMcpInjected(): boolean {
  return computerUseHost().hasLocalMcpServer(MCP_SERVER_ID);
}

/**
 * 开关 → `cua` MCP 条目 upsert/remove，宿主写入 `mcp_local_config` 并同步 MCP Proxy
 * 内存（运行中立即生效；引擎侧由 unifiedAgent.loadLocalMcpConfig 在下次引擎启动合并，
 * 本地条目优先）。
 */
export async function syncCuaMcpConfig(enabled: boolean): Promise<void> {
  const host = computerUseHost();
  if (enabled) {
    const helperRoot = findHelperApp();
    if (!helperRoot) {
      await host.setLocalMcpServer(MCP_SERVER_ID, null);
    } else {
      const node = host.resolveNodeBinary();
      if (!node) throw new Error("nodeRuntimeMissing");
      const gatewayPath = await ensureCuaGateway(helperRoot);
      await host.setLocalMcpServer(MCP_SERVER_ID, {
        command: node,
        args: [stdioRelayScriptPath()],
        env: { NUWAX_CUA_GATEWAY: gatewayPath, NUWAX_CUA_GATEWAY_TOKEN: endpoint().tokenFile },
        enabled: true,
        allowTools: CUA_ALLOWED_TOOLS,
        denyTools: CUA_DENIED_TOOLS,
      });
    }
  } else {
    await host.setLocalMcpServer(MCP_SERVER_ID, null);
  }
  log.info(`[Cua] Synced ${MCP_SERVER_ID} in mcp_local_config: enabled=${enabled}`);
}

/** Same subject used by installation, native permission requests and drag-add. */
export function getCuaHelperAppPath(): string | null { return findHelperApp(); }

export async function getCuaStatus(): Promise<CuaStatus> {
  const helperPath = findHelperApp();
  let running = await isDaemonAlive();
  // daemon 活着才是 helper TCC 的活证据；启用但掉线时不能把上次 granted 画成绿点。
  let permissions = lastPermissionHint;
  if (running && IS_MAC) {
    permissions = await probeDaemonPermissions();
    lastPermissionHint = permissions;
  } else if (IS_MAC && readEnabled()) {
    permissions = {
      accessibility: lastPermissionHint.accessibility === true ? null : lastPermissionHint.accessibility,
      screenRecording: lastPermissionHint.screenRecording === true ? null : lastPermissionHint.screenRecording,
    };
  }
  let policyValid = true;
  if (running && readEnabled()) {
    try { policyValid = await verifyDaemonAuthorization(prepareCuaPolicy().sha256); }
    catch { policyValid = false; }
  }
  // 启动期尚未跑 ensureCuaOnBoot 时 monitor 不存在，不能把“尚未拉起”误判为掉线。
  if (readEnabled() && !runtimeSuspended && !cuaBootReconciling && !cuaLifecycleBusy &&
      ((!running && cuaMonitor !== null) ||
       (running && (!policyValid ||
        (IS_MAC && (!permissions.accessibility || !permissions.screenRecording)))))) {
    lastCuaError = !running ? "daemonNotReady" :
      !policyValid ? "policyNotActive" : "permissionsRequired";
    await serializeCua(async () => {
      if (readEnabled()) {
        cuaTasks.fail(lastCuaError ?? "daemonNotReady");
        await suspendCuaRuntimeResources();
      }
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
    agentCursor: readAgentCursorEnabled(),
    authMode: readCuaAuthMode(readStep1().computerUseAuthMode),
    blacklist: readCuaBlacklist(readStep1().computerUseBlacklist),
    screenshotHome: cuaScreenshotHome(cuaDataHome()),
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
  if (frameMonitor) clearInterval(frameMonitor);
  frameMonitor = undefined;
  publishFrames([]);
}

function startCuaMonitor(): void {
  stopCuaMonitor();
  cuaMonitor = setInterval(() => {
    void getCuaStatus().catch((e) => log.warn("[Cua] status monitor failed", e));
  }, 30_000);
  cuaMonitor.unref();
  if (multiwindow) {
    frameMonitor = setInterval(() => { void pollWindowTasks().catch(() => publishFrames([])); }, 250);
    frameMonitor.unref();
  }
}

/** Cleanup still runs when config removal fails; report an unconfirmed stop first. */
async function removeMcpAndStopDaemon(preservePermissionLinger = false): Promise<void> {
  const config = await syncCuaMcpConfig(false).then(
    () => ({ ok: true as const }),
    error => ({ ok: false as const, error }),
  );
  await stopDaemon(preservePermissionLinger);
  if (!(await waitForDaemonStopped(3000))) throw new Error("helperStillRunning");
  confirmWindowTasksStopped();
  if (!config.ok) throw config.error;
}

async function disableCua(preserveEnabled = false, preservePermissionLinger = false): Promise<void> {
  confirmationGate.clear(); cuaElements.forget();
  windowTasks.setAvailable(false); windowTasks.stop("disabled");
  cuaTasks.setAvailable(false);
  cuaTasks.stop("disabled");
  runtimeSuspended = true;
  const gateway = cuaGateway;
  cuaGateway = null;
  await gateway?.close();
  stopCuaMonitor();
  let persistenceError: unknown;
  try {
    if (!preserveEnabled) persistEnabled(false);
    persistConsentPending(false);
  } catch (error) { persistenceError = error; }
  // Revocation must finish even when the settings database cannot be written.
  await removeMcpAndStopDaemon(preservePermissionLinger);
  if (persistenceError) throw persistenceError;
}

export async function setCuaEnabled(enabled: boolean): Promise<{
  success: boolean;
  error?: string;
  status: CuaStatus;
}> {
  if (!enabled) { cuaDisableEpoch++; cancelCuaPermissionRequest(); }
  const epoch = cuaDisableEpoch;
  return serializeCua(() => setCuaEnabledUnlocked(enabled, epoch));
}

async function setCuaEnabledUnlocked(enabled: boolean, epoch: number): Promise<{
  success: boolean; error?: string; status: CuaStatus;
}> {
  const previouslyEnabled = readEnabled();
  if (!enabled) {
    try {
      await disableCua();
      lastPermissionHint = { accessibility: null, screenRecording: null };
      lastCuaError = null;
      publishCuaCapabilityNotice(CUA_DISABLED_NOTICE);
      sweepCuaScreenshots();
      return { success: true, status: await getCuaStatus() };
    } catch (e) {
      lastCuaError = "disableFailed";
      log.warn("[Cua] disable failed", e);
      return { success: false, error: lastCuaError, status: await getCuaStatus() };
    }
  }
  try {
    // 此调用只在用户接受一次性全范围确认后发出；系统授权未完成时保留待办。
    if (epoch !== cuaDisableEpoch) throw new Error("disabledDuringEnable");
    persistConsentPending(true);
    // 任何旧条目先撤销；直到安装、系统授权和 daemon 双重探测全部通过才持久启用。
    if (!previouslyEnabled) persistEnabled(false);
    await syncCuaMcpConfig(false);
    const installed = await installCuaHelper();
    if (epoch !== cuaDisableEpoch) throw new Error("disabledDuringEnable");
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
    persistEnabled(true, "enableConfirmed");
    runtimeSuspended = false;
    cuaTasks.setAvailable(true);
    cuaTasks.reset();
    persistConsentPending(false);
    lastCuaError = null;
    startCuaMonitor();
    publishCuaCapabilityNotice(CUA_ENABLED_NOTICE);
    return { success: true, status: await getCuaStatus() };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    lastCuaError = reason;
    log.warn("[Cua] enable rejected", reason);
    await disableCua(previouslyEnabled, reason === "timeout").catch((cleanupError) =>
      log.warn("[Cua] enable cleanup failed", cleanupError),
    );
    if (reason === "permissionsRequired" || reason === "timeout") persistConsentPending(true);
    return { success: false, error: reason, status: await getCuaStatus() };
  }
}

/**
 * 启动期收敛（幂等）：开关开着则拉起 daemon 并确保 MCP 条目在位；
 * helper 已不存在则清掉条目防僵尸（升级/卸载残留场景）。挂在商业版
 * lifecycle start 回调（引擎启动前替换旧 MCP 条目，避免读取旧的直连入口）。
 */
export async function ensureCuaOnBoot(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  const epoch = cuaDisableEpoch;
  const abort = () => { void suspendCua("sessionEnded").catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  try { await serializeCua(() => ensureCuaOnBootUnlocked(epoch)); }
  finally { signal?.removeEventListener("abort", abort); }
}

async function ensureCuaOnBootUnlocked(epoch: number): Promise<void> {
  sweepCuaScreenshots();
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
    runtimeSuspended = false;
    cuaTasks.setAvailable(true);
    startCuaMonitor();
  } catch (e) {
    if (epoch !== cuaDisableEpoch) return; // the queued revocation owns cleanup and the final state
    log.warn("[Cua] boot: daemon launch failed", e);
    lastCuaError = e instanceof Error ? e.message : String(e);
    cuaTasks.fail(["permissionsRequired", "policyNotActive", "daemonNotReady"].includes(lastCuaError) ? lastCuaError : "daemonNotReady");
    await suspendCuaRuntimeResources().catch((cleanupError) =>
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

/** Revoke synchronously before waiting for any lifecycle queue or OS operation. */
export function suspendCua(reason = "sessionEnded"): Promise<void> {
  cuaDisableEpoch++;
  // Capture both promises before cancel so quit still awaits owned-host pkill.
  const permissionCleanup = Promise.all([
    permissionAttempt?.promise ?? Promise.resolve(),
    permissionLinger?.promise ?? Promise.resolve(),
  ]);
  cancelCuaPermissionRequest();
  pendingControls++;
  runtimeSuspended = true;
  cuaTasks.setAvailable(false);
  cuaTasks.stop(reason);
  windowTasks.setAvailable(false);
  windowTasks.stop(reason);
  cuaBindings.clear();
  cuaGateway?.cancelPending(reason);
  // Standalone permission IPC is outside the lifecycle queue. Cancellation
  // interrupts the 20s poll and any post-timeout linger; await only owned-host
  // cleanup so an enable request cannot form a queue cycle.
  return Promise.allSettled([serializeCua(suspendCuaRuntimeResources), permissionCleanup]).then(results => {
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }).finally(() => { pendingControls--; cuaTasks.notify(); });
}

async function suspendCuaRuntimeResources(): Promise<void> {
  runtimeSuspended = true;
  cuaTasks.setAvailable(false);
  stopCuaMonitor();
  const gateway = cuaGateway;
  cuaGateway = null;
  await gateway?.close();
  await removeMcpAndStopDaemon();
}

export async function pauseCuaTask(reason = "userPaused"): Promise<CuaControlResult> {
  if (multiwindow) {
    await Promise.all(windowTasks.list().filter((task) => !["completed", "stopped", "failed"].includes(task.phase))
      .map((task) => pauseWindowTask(task.taskId, reason)));
    return { success: !windowTasks.list().some((task) => task.controlPending), runtime: getCuaRuntime() };
  }
  pendingControls++;
  cuaDisableEpoch++;
  cancelCuaPermissionRequest();
  runtimeSuspended = true;
  cuaTasks.pause(reason);
  cuaBindings.clear();
  cuaGateway?.cancelPending(reason);
  cuaGateway?.pauseTransports();
  try {
    await serializeCua(async () => {
      await stopDaemon();
      if (!(await waitForDaemonStopped(3000))) throw new Error("helperStillRunning");
    });
    return { success: true, runtime: { ...getCuaRuntime(), controlPending: pendingControls > 1 } };
  } catch {
    cuaTasks.fail("helperStillRunning");
    return { success: false, error: "helperStillRunning", runtime: getCuaRuntime() };
  } finally { pendingControls--; cuaTasks.notify(); }
}

export async function resumeCuaTask(): Promise<CuaControlResult> {
  if (multiwindow) {
    const tasks = windowTasks.list().filter((task) => !["completed", "stopped", "failed"].includes(task.phase));
    return tasks.length === 1 ? resumeWindowTask(tasks[0].taskId)
      : { success: false, error: "taskSelectionRequired", runtime: getCuaRuntime() };
  }
  const runtime = getCuaRuntime();
  if (preparingRuntime || pendingControls || runtime.phase !== "paused" || !readEnabled() ||
      CUA_FINAL_REASONS.includes(runtime.reason ?? ""))
    return { success: false, error: "cannotResume", runtime: getCuaRuntime() };
  preparingRuntime = true;
  const epoch = cuaDisableEpoch;
  try {
    await ensureCuaOnBoot();
    if (!runtimeSuspended && epoch === cuaDisableEpoch) {
      try { await cuaGateway?.resumeTransports(); }
      catch {
        if (epoch === cuaDisableEpoch) await suspendCua("gatewayFailed");
        return { success: false, error: "gatewayFailed", runtime: getCuaRuntime() };
      }
    }
    const success = epoch === cuaDisableEpoch && !runtimeSuspended && cuaTasks.resume();
    return { success, ...(success ? {} : { error: "cannotResume" }), runtime: getCuaRuntime() };
  } finally { preparingRuntime = false; }
}

export async function stopCuaTask(): Promise<CuaControlResult> {
  try {
    await suspendCua("userStopped");
    sweepCuaScreenshots();
    return { success: true, runtime: getCuaRuntime() };
  } catch {
    cuaTasks.fail("helperStillRunning");
    return { success: false, error: "helperStillRunning", runtime: getCuaRuntime() };
  }
}

export async function recoverCua(): Promise<CuaControlResult> {
  if (preparingRuntime || pendingControls || !readEnabled())
    return { success: false, error: "cannotResume", runtime: getCuaRuntime() };
  preparingRuntime = true;
  try {
    const stopping = suspendCua("recovering");
    const epoch = cuaDisableEpoch;
    await stopping;
    if (epoch !== cuaDisableEpoch) return { success: false, error: "operationCancelled", runtime: getCuaRuntime() };
    await ensureCuaOnBoot();
    const success = epoch === cuaDisableEpoch && !runtimeSuspended && cuaGateway?.ready === true;
    if (success) { cuaTasks.reset(); windowTasks.clearHistory(); }
    return { success, ...(success ? {} : { error: lastCuaError ?? "daemonNotReady" }), runtime: getCuaRuntime() };
  } finally { preparingRuntime = false; }
}

export function clearCuaHistory(): boolean { return multiwindow ? windowTasks.clearHistory() : cuaTasks.clearHistory(); }

async function readLiveCuaWindows(): Promise<Array<{ pid: number; window_id: number; app_name?: string; title?: string }>> {
  const reply = await requestDaemon("call", "list_windows", {});
  const items = (reply?.result?.structuredContent as { windows?: unknown } | undefined)?.windows;
  if (!reply?.ok || !Array.isArray(items)) throw new Error("daemonNotReady");
  return items.filter(item => Number.isSafeInteger(item.pid) && item.pid > 0 && Number.isSafeInteger(item.window_id) && item.window_id > 0).slice(0, 250);
}
export async function listCuaWindows(): Promise<CuaWindow[]> {
  return (await listAllowedNativeCuaWindows()).map(window => ({ pid: window.pid, windowId: window.window_id,
    label: `${String(window.app_name ?? "").slice(0, 80)} — ${String(window.title ?? "").slice(0, 160)}` }));
}
async function listAllowedNativeCuaWindows() {
  const blacklist = readCuaBlacklist(readStep1().computerUseBlacklist);
  // MCP advertises the helper's WindowInfo output schema. Keep its native rows
  // intact (bounds, app_name, visibility, nullable stacking); project only for UI.
  return (await readLiveCuaWindows()).filter(window => !isDeniedCuaApp([window.app_name, window.title], blacklist));
}

export async function setCuaScope(requested: unknown): Promise<CuaControlResult> {
  if (multiwindow) return { success: false, error: "taskSelectionRequired", runtime: getCuaRuntime() };
  if (preparingRuntime || pendingControls || ["running", "paused"].includes(getCuaRuntime().phase) || !readEnabled())
    return { success: false, error: "scopeBusy", runtime: getCuaRuntime() };
  const value = requested as Partial<CuaWindow> & { kind?: string } | null;
  if (value?.kind !== "window" && value?.kind !== "desktop") return { success: false, error: "scopeViolation", runtime: getCuaRuntime() };
  preparingRuntime = true;
  try {
    const epoch = cuaDisableEpoch;
    const target = value.kind === "window" ? (await listCuaWindows()).find((item) => item.pid === value.pid && item.windowId === value.windowId) : undefined;
    if (epoch !== cuaDisableEpoch || (value.kind === "window" && !target)) return { success: false, error: "targetClosed", runtime: getCuaRuntime() };
    const stopping = suspendCua("scopeChanged");
    const nextEpoch = cuaDisableEpoch;
    await stopping;
    if (nextEpoch !== cuaDisableEpoch) return { success: false, error: "sessionEnded", runtime: getCuaRuntime() };
    const nextScope: CuaScope = target ? { kind: "window", ...target } : { kind: "desktop" };
    if (!patchStep1({ computerUseScopeKind: nextScope.kind }))
      return { success: false, error: "scopeSaveFailed", runtime: getCuaRuntime() };
    scopeInitialized = true;
    cuaScope = nextScope;
    await ensureCuaOnBoot();
    const success = nextEpoch === cuaDisableEpoch && !runtimeSuspended;
    if (success) cuaTasks.reset();
    return { success, ...(success ? {} : { error: "daemonNotReady" }), runtime: getCuaRuntime() };
  } finally { preparingRuntime = false; }
}

export function getCuaTasks() { return multiwindow ? windowTasks.list() : []; }

function taskResult(success: boolean, error?: string): CuaControlResult {
  return { success, ...(error ? { error } : {}), runtime: getCuaRuntime() };
}
function confirmWindowTasksStopped() {
  nativeStoppedEpoch = cuaDisableEpoch;
  for (const task of windowTasks.list()) {
    const owner = windowTasks.byId(task.taskId)?.owner;
    if (owner) windowTasks.releaseDrained(owner);
    windowTasks.pending(task.taskId, false);
  }
}
function serializeTask<T>(id: string, work: () => Promise<T>): Promise<T> {
  const next = (taskControls.get(id) ?? Promise.resolve()).catch(() => undefined).then(work);
  taskControls.set(id, next);
  void next.finally(() => { if (taskControls.get(id) === next) taskControls.delete(id); }).catch(() => undefined);
  return next;
}
async function drainWindowTask(id: string): Promise<boolean> {
  const task = windowTasks.byId(id);
  if (!task) return false;
  if (!task.target) return true;
  const context = windowTasks.nativeContext(task.owner);
  const stopped = () => runtimeSuspended && nativeStoppedEpoch === cuaDisableEpoch;
  if (stopped()) return true;
  const revoke = await requestDaemon("nuwax_task", "revoke", context);
  if (!revoke?.ok) return stopped();
  const deadline = Date.now() + 10_000;
  let reply = revoke;
  while (reply.result?.drained !== true && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    reply = await requestDaemon("nuwax_task", "status", context) ?? { ok: false };
    if (!reply.ok) return stopped();
  }
  if (reply.result?.drained !== true) return stopped();
  await cuaGateway?.ownerDrained(task.owner);
  if (["completed", "stopped", "failed"].includes(task.controller.snapshot().phase))
    await requestDaemon("nuwax_task", "forget", context);
  return true;
}
export function pauseWindowTask(id: string, reason = "userPaused"): Promise<CuaControlResult> {
  const task = windowTasks.byId(id);
  if (!multiwindow || !task) return Promise.resolve(taskResult(false, "taskUnavailable"));
  windowTasks.pauseTask(id, reason);
  windowTasks.pending(id, true);
  cuaGateway?.holdOwner(task.owner, reason);
  return serializeTask(id, async () => {
    const drained = await drainWindowTask(id);
    windowTasks.pending(id, !drained);
    return taskResult(drained, drained ? undefined : "handoffPending");
  });
}
export async function resumeWindowTask(id: string): Promise<CuaControlResult> {
  const task = windowTasks.byId(id);
  if (!multiwindow || !multiwindowCapable || !task?.target || task.pending || !readEnabled() || runtimeSuspended)
    return taskResult(false, "cannotResume");
  const context = windowTasks.nativeContext(task.owner);
  const epoch = cuaDisableEpoch;
  const state = await requestDaemon("nuwax_task", "window", context);
  if (epoch !== cuaDisableEpoch || context.epoch !== task.epoch || context.binding_id !== task.bindingId ||
    context.mode !== task.mode || task.pending || !multiwindow || runtimeSuspended) return taskResult(false, "operationCancelled");
  if (!state?.ok || state.result?.valid !== true) return taskResult(false, "targetClosed");
  if (task.mode === "background" && state.result?.foreground === true) return taskResult(false, "userTakingControl");
  const success = windowTasks.resumeTask(id);
  return taskResult(success, success ? undefined : "cannotResume");
}
export async function stopWindowTask(id: string): Promise<CuaControlResult> {
  const task = windowTasks.byId(id);
  if (!multiwindow || !task) return taskResult(false, "taskUnavailable");
  windowTasks.pending(id, true); windowTasks.stopTask(id);
  cuaGateway?.holdOwner(task.owner, "userStopped");
  return serializeTask(id, async () => {
    const drained = await drainWindowTask(id);
    windowTasks.pending(id, !drained);
    return taskResult(drained, drained ? undefined : "handoffPending");
  });
}
async function finishWindowTask(id: string, cancelled: boolean) {
  const task = windowTasks.byId(id);
  if (!task) return;
  if (cancelled || task.controller.hasPending(task.owner) || task.controller.snapshot().phase === "paused") await stopWindowTask(id);
  else {
    windowTasks.complete(task.owner); windowTasks.pending(id, true);
    const drained = await drainWindowTask(id); windowTasks.pending(id, !drained);
  }
  windowTasks.retire(task.owner);
  sweepCuaScreenshots();
}
export async function bindWindowTask(id: string, target: unknown): Promise<CuaControlResult> {
  const task = windowTasks.byId(id);
  const requested = target as Partial<CuaWindow> | null;
  if (!multiwindow || !task || !Number.isSafeInteger(requested?.pid) || !Number.isSafeInteger(requested?.windowId))
    return taskResult(false, "scopeViolation");
  if (task.target) {
    const stopped = await pauseWindowTask(id);
    if (!stopped.success) return stopped;
  }
  const epoch = cuaDisableEpoch;
  const found = (await listCuaWindows()).find((item) => item.pid === requested!.pid && item.windowId === requested!.windowId);
  if (!found || epoch !== cuaDisableEpoch || !multiwindow) return taskResult(false, "targetClosed");
  try { windowTasks.bind(id, found); }
  catch (error) { return taskResult(false, error instanceof Error ? error.message : "scopeViolation"); }
  windowTasks.pending(id, true);
  const context = windowTasks.nativeContext(task.owner);
  // Establish native identity when the user binds it, not at the first delayed write.
  const reply = await requestDaemon("nuwax_task", "bind", context);
  if (context.epoch !== task.epoch || context.binding_id !== task.bindingId || epoch !== cuaDisableEpoch) return taskResult(false, "operationCancelled");
  if (!reply?.ok) {
    windowTasks.pauseTask(id, "targetClosed"); windowTasks.pending(id, false); return taskResult(false, "targetClosed");
  }
  const revoked = await requestDaemon("nuwax_task", "revoke", context);
  if (context.epoch !== task.epoch || epoch !== cuaDisableEpoch) return taskResult(false, "operationCancelled");
  if (!revoked?.ok || revoked.result?.drained !== true) return taskResult(false, "handoffPending");
  windowTasks.pending(id, false);
  return taskResult(true);
}
export async function setWindowTaskMode(id: string, mode: unknown): Promise<CuaControlResult> {
  if (!multiwindow || !windowTasks.byId(id) || !["foreground", "background"].includes(String(mode)))
    return taskResult(false, "scopeViolation");
  if (mode === "foreground") {
    const results = await Promise.all(windowTasks.list().filter((task) => ["running", "paused"].includes(task.phase) || task.controlPending)
      .map((task) => pauseWindowTask(task.taskId)));
    if (results.some((result) => !result.success)) return taskResult(false, "handoffPending");
  } else {
    const paused = await pauseWindowTask(id);
    if (!paused.success) return paused;
  }
  try { windowTasks.setMode(id, mode as CuaExecutionMode); return taskResult(true); }
  catch (error) { return taskResult(false, error instanceof Error ? error.message : "cannotResume"); }
}
export async function setMultiwindowEnabled(enabled: boolean): Promise<CuaControlResult> {
  if (typeof enabled !== "boolean" || (enabled && IS_LINUX)) return taskResult(false, "unsupportedPlatform");
  if (enabled && !readEnabled()) return taskResult(false, "disabled");
  if (enabled === multiwindow) return taskResult(true);
  if (preparingRuntime || pendingControls) return taskResult(false, "scopeBusy");
  preparingRuntime = true;
  try {
    const stopping = suspendCua("modeChanged");
    const epoch = cuaDisableEpoch;
    await stopping;
    if (epoch !== cuaDisableEpoch) return taskResult(false, "operationCancelled");
    if (!patchStep1({ computerUseMultiwindow: enabled }))
      return taskResult(false, "scopeSaveFailed");
    multiwindow = enabled; multiwindowCapable = false;
    await ensureCuaOnBoot();
    if (epoch !== cuaDisableEpoch) return taskResult(false, "operationCancelled");
    if (enabled && !multiwindowCapable) return taskResult(false, "helperUpgradeRequired");
    return taskResult(!runtimeSuspended, runtimeSuspended ? "daemonNotReady" : undefined);
  } finally { preparingRuntime = false; }
}

export async function getCuaDiagnostics() {
  const status = await getCuaStatus();
  const metadata = status.running ? await requestDaemon("metadata") : null;
  const version = metadata?.result?.driver_version;
  const helperVersion = typeof version === "string" && /^[A-Za-z0-9._+-]{1,80}$/.test(version) ? version : null;
  return { schemaVersion: 1, helperVersion, createdAt: new Date().toISOString(), platform: process.platform,
    appVersion: app.getVersion(), runtime: { ...getCuaRuntime(), scope: { kind: cuaScope.kind },
      ...(multiwindow ? { tasks: windowTasks.list().map(({ scope: _scope, ...task }) => ({ ...task, scope: { kind: "window" } })) } : {}) },
    status: { supported: status.supported, installed: status.installed, enabled: status.enabled,
      running: status.running, accessibility: status.accessibility, screenRecording: status.screenRecording,
      gateway: cuaGateway?.ready === true },
    screenshotHome: status.screenshotHome,
    screenshots: listLocalScreenshotNames(cuaScreenshotHome(cuaDataHome())),
  };
}

/** No input injection or screenshot capture: a readiness check, not a task acceptance claim. */
export async function selfTestCua(): Promise<CuaCheck[]> {
  const status = await getCuaStatus();
  const check = (name: CuaCheck["name"], ok: boolean, reason: string): CuaCheck =>
    ({ name, status: ok ? "passed" : "failed", ...(ok ? {} : { reason }) });
  return [
    check("helper", status.installed, "helperNotInstalled"),
    check("permissions", !IS_MAC || (status.accessibility === true && status.screenRecording === true), "permissionsRequired"),
    check("driver", status.running, "daemonNotReady"),
    check("policy", status.running && await verifyDaemonAuthorization(prepareCuaPolicy().sha256), "policyNotActive"),
    check("gateway", cuaGateway?.ready === true, "gatewayFailed"),
    { name: "model", status: "manual", reason: "agentModelRequiresTaskVerification" },
  ];
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
  /** 模拟光标 overlay；缺省开。与 Background 投递独立。 */
  agentCursor: boolean;
  authMode: CuaAuthMode;
  blacklist: string[];
  screenshotHome: string;
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

/** 启用流程最多卡 20s；超时后继续看结果文件，避免慢勾系统设置必须再点一次。 */
const PERMISSION_HOST_WAIT_MS = 20_000;
const PERMISSION_HOST_LINGER_MS = 90_000;

type PermissionHostLease = {
  epoch: number;
  helperPath: string;
  resultFile: string;
};

type PermissionAttempt = PermissionHostLease & {
  controller: AbortController;
  error: "operationCancelled" | "timeout" | "permissionHostFailed";
  promise: Promise<CuaPermissionsResult>;
};
let permissionAttempt: PermissionAttempt | undefined;

type PermissionLinger = PermissionHostLease & {
  controller: AbortController;
  promise: Promise<void>;
};
let permissionLinger: PermissionLinger | undefined;

function emptyPermissionHint(): { accessibility: boolean | null; screenRecording: boolean | null } {
  return { accessibility: null, screenRecording: null };
}

/** 读宿主私有结果文件；文件空或仍在写时返回 null，不把半截 JSON 当授权。 */
function readPermissionHostFile(resultFile: string): {
  hint: { accessibility: boolean | null; screenRecording: boolean | null };
  sc: {
    accessibility?: boolean; screen_recording?: boolean;
    screen_recording_capturable?: boolean; direct_capture_verification_error?: unknown;
    direct_capture_verification?: { bundle_id?: string };
    source?: { attribution?: string; bundle_id?: string };
  };
} | null {
  try {
    const raw = fs.readFileSync(resultFile, "utf-8");
    if (!raw.trim()) return null;
    const sc = JSON.parse(raw).structuredContent ?? {};
    return {
      sc,
      hint: {
        accessibility: typeof sc.accessibility === "boolean" ? sc.accessibility : null,
        screenRecording: typeof sc.screen_recording === "boolean" ? sc.screen_recording : null,
      },
    };
  } catch {
    return null;
  }
}

function cancelPermissionLinger(): boolean {
  const linger = permissionLinger;
  if (!linger) return false;
  linger.controller.abort();
  return true;
}

/** Cancels the in-flight request and any post-timeout linger; never kills a daemon. */
export function cancelCuaPermissionRequest(): boolean {
  const attempt = permissionAttempt;
  const linger = permissionLinger;
  if (!attempt && !linger) return false;
  lastPermissionHint = emptyPermissionHint();
  // Revoke the host's private result-file lease before OS process cleanup.
  if (attempt) {
    try { fs.rmSync(attempt.resultFile, { force: true }); } catch { /* Cleanup retries below. */ }
    attempt.controller.abort();
  }
  cancelPermissionLinger();
  return true;
}

async function removePermissionHost(lease: Pick<PermissionHostLease, "helperPath" | "resultFile">): Promise<void> {
  // LaunchServices' `open` process is not the helper host. Match the exact helper
  // executable, subcommand and unguessable result file rather than a process name.
  const literal = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const command = `^${literal(helperExecutable(lease.helperPath))} __permissions-host-request --result-file ${literal(lease.resultFile)}( |$)`;
  await pexec("pkill", ["-KILL", "-f", command], { timeout: 1500 }).catch(() => undefined);
}

async function cleanupPermissionHost(lease: Pick<PermissionHostLease, "helperPath" | "resultFile">): Promise<void> {
  try { fs.rmSync(lease.resultFile, { force: true }); }
  catch { log.warn("[Cua] permission host result cleanup failed"); }
  await removePermissionHost(lease);
}

/** 软超时后继续读同一结果文件，把迟到授权写进 hint 供设置页轮询变绿。 */
function startPermissionLinger(lease: PermissionHostLease): void {
  cancelPermissionLinger();
  const linger: PermissionLinger = {
    epoch: lease.epoch, helperPath: lease.helperPath, resultFile: lease.resultFile,
    controller: new AbortController(), promise: undefined!,
  };
  permissionLinger = linger;
  linger.promise = (async () => {
    const deadline = Date.now() + PERMISSION_HOST_LINGER_MS;
    while (!linger.controller.signal.aborted && linger.epoch === cuaDisableEpoch && Date.now() < deadline) {
      const parsed = readPermissionHostFile(linger.resultFile);
      if (linger.controller.signal.aborted || linger.epoch !== cuaDisableEpoch) break;
      if (parsed) lastPermissionHint = parsed.hint;
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }
  })().finally(async () => {
    await cleanupPermissionHost(linger);
    if (permissionLinger === linger) permissionLinger = undefined;
  });
}

function finishPermissionAttempt(attempt: PermissionAttempt, result: CuaPermissionsResult): CuaPermissionsResult {
  if (attempt.epoch !== cuaDisableEpoch) {
    return { success: false, error: attempt.error, ...emptyPermissionHint() };
  }
  // 超时把当前 hint 带回 UI；硬取消/退出仍清空，避免把已撤销宿主当授权。
  if (attempt.controller.signal.aborted && attempt.error === "timeout") {
    return { success: false, error: "timeout", ...lastPermissionHint };
  }
  if (attempt.controller.signal.aborted) {
    return { success: false, error: attempt.error, ...emptyPermissionHint() };
  }
  return result;
}

/** Only an explicit enable action enters this single-flight, cancellable request. */
export function requestCuaPermissions(): Promise<CuaPermissionsResult> {
  if (permissionAttempt && !permissionAttempt.controller.signal.aborted && permissionAttempt.epoch === cuaDisableEpoch)
    return permissionAttempt.promise;
  // 新一轮检查替换超时续看，避免双宿主；hint 由本次探测重写。
  cancelPermissionLinger();
  const helperPath = findHelperApp();
  if (!IS_MAC || !helperPath) return Promise.resolve({
    success: false, error: IS_MAC ? "helperNotInstalled" : "unsupportedPlatform",
    accessibility: null, screenRecording: null,
  });
  const attempt: PermissionAttempt = {
    epoch: cuaDisableEpoch, helperPath,
    resultFile: path.join(os.tmpdir(), `cua-driver-permissions-${process.pid}-${randomUUID()}.json`),
    controller: new AbortController(), error: "operationCancelled",
    promise: undefined!,
  };
  permissionAttempt = attempt;
  attempt.promise = runPermissionRequest(attempt).then((result) => finishPermissionAttempt(attempt, result));
  return attempt.promise;
}

async function runPermissionRequest(attempt: PermissionAttempt): Promise<CuaPermissionsResult> {
  const empty = emptyPermissionHint();
  const current = () => permissionAttempt === attempt && !attempt.controller.signal.aborted && attempt.epoch === cuaDisableEpoch;
  let timer: NodeJS.Timeout | undefined;
  const aborted = new Promise<never>((_, reject) => {
    attempt.controller.signal.addEventListener("abort", () => reject(new Error(attempt.error)), { once: true });
  });
  // Attach a rejection observer even if launch/file creation fails before polling.
  void aborted.catch(() => undefined);
  try {
    fs.writeFileSync(attempt.resultFile, "", { mode: 0o600, flag: "wx" });
    lastPermissionHint = empty;
    timer = setTimeout(() => { attempt.error = "timeout"; attempt.controller.abort(); }, PERMISSION_HOST_WAIT_MS);
    const child = spawn("open", [
      "-n", "-g", "--env", `CUA_DRIVER_DATA_HOME=${cuaDataHome()}`,
      "--env", "CUA_DRIVER_RS_TELEMETRY_ENABLED=false",
      attempt.helperPath, "--args", "__permissions-host-request",
      "--result-file", attempt.resultFile, "--probe-direct-capture",
    ], { detached: true, stdio: "ignore" });
    child.on("error", () => {
      if (!current()) return;
      attempt.error = "permissionHostFailed";
      attempt.controller.abort();
    });
    child.unref();
    while (current()) {
      await Promise.race([new Promise<void>(resolve => setTimeout(resolve, 500)), aborted]);
      if (!current()) break;
      const parsed = readPermissionHostFile(attempt.resultFile);
      if (!parsed) continue;
      lastPermissionHint = parsed.hint;
      const sc = parsed.sc;
      if (sc.accessibility && sc.screen_recording &&
          (sc.source?.attribution !== "driver-daemon" || sc.source.bundle_id !== HELPER_BUNDLE_ID))
        return { success: false, error: "helperIdentityUnverified", ...parsed.hint };
      if (!sc.accessibility || !sc.screen_recording || sc.screen_recording_capturable !== true ||
          sc.direct_capture_verification_error != null || sc.direct_capture_verification?.bundle_id !== HELPER_BUNDLE_ID)
        return { success: false, error: "permissionsRequired", ...parsed.hint };
      return { success: true, ...parsed.hint };
    }
    return { success: false, error: attempt.error, ...empty };
  } catch {
    return { success: false, error: attempt.controller.signal.aborted ? attempt.error : "permissionHostFailed", ...empty };
  } finally {
    if (timer) clearTimeout(timer);
    const lingerTimeout = attempt.error === "timeout"
      && attempt.epoch === cuaDisableEpoch
      && fs.existsSync(attempt.resultFile);
    if (lingerTimeout) startPermissionLinger(attempt);
    else await cleanupPermissionHost(attempt);
    if (permissionAttempt === attempt) permissionAttempt = undefined;
  }
}

// The conversation model owns task reasoning; this endpoint is an explicit synthetic-image diagnostic.
export { getVlmConfig, setVlmConfig, testVlm } from "./vlmDiagnostics";


export function getCuaPreviewIdentity(id: string) {
  const task = windowTasks.byId(id);
  if (!multiwindow || runtimeSuspended || previewSuppressed || !readEnabled() || !task?.target ||
      !["running", "paused"].includes(task.controller.snapshot().phase) ||
      task.controller.snapshot().reason === "screenLocked") return null;
  return { taskId: id, bindingId: task.bindingId, epoch: task.epoch };
}
export async function captureCuaTaskPreview(id: string): Promise<import("@shared/features/computer-use/contract").CuaPreviewUpdate> {
  const task = windowTasks.byId(id), identity = getCuaPreviewIdentity(id);
  if (!task || !identity) return { taskId: id, status: "ended" };
  if (!previewCapable) return { taskId: id, status: "helperUpgradeRequired" };
  const disableEpoch = cuaDisableEpoch;
  const reply = await requestDaemon("nuwax_task", "preview", windowTasks.nativeContext(task.owner), 1024 * 1024);
  if (disableEpoch !== cuaDisableEpoch || JSON.stringify(identity) !== JSON.stringify(getCuaPreviewIdentity(id)))
    return { taskId: id, status: "ended" };
  const data = reply?.result;
  if (!reply?.ok || !data || typeof data.jpeg !== "string" || data.jpeg.length > 700000 ||
      data.task_id !== id || data.binding_id !== identity.bindingId || data.epoch !== identity.epoch ||
      !Number.isSafeInteger(data.width) || !Number.isSafeInteger(data.height) ||
      Number(data.width) < 1 || Number(data.height) < 1 || Number(data.width) > 960 || Number(data.height) > 960 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(data.jpeg)) {
    const permissions = await probeDaemonPermissions();
    return { taskId: id, status: permissions.screenRecording === false ? "permissionsRequired" :
      reply?.error === "preview_minimized" ? "minimized" : "unavailable" };
  }
  return { taskId: id, status: "ready", frame: { ...identity, sequence: ++previewSequence,
    capturedAt: Date.now(), width: Number(data.width), height: Number(data.height), jpeg: data.jpeg } };
}
/** Legacy handoff revokes automation; exact native focus is available in window-task mode. */
export async function takeOverCua(): Promise<CuaControlResult> {
  if (multiwindow) return takeOverWindowTask(getCuaRuntime().taskId ?? "");
  return pauseCuaTask("userTakingControl");
}
export async function takeOverWindowTask(id: string): Promise<CuaControlResult> {
  if (!previewCapable || !getCuaPreviewIdentity(id)) return taskResult(false, "helperUpgradeRequired");
  const result = await pauseWindowTask(id, "userTakingControl");
  if (!result.success) return result;
  return serializeTask(id, async () => {
    const task = windowTasks.byId(id);
    if (!task?.target || task.pending || task.controller.snapshot().phase !== "paused" || !getCuaPreviewIdentity(id))
      return taskResult(false, "operationCancelled");
    if (task.mode === "foreground") windowTasks.setMode(id, "background");
    const context = windowTasks.nativeContext(task.owner);
    // Refresh the revoked context after returning the desktop lease; this never grants inputs.
    const revoked = await requestDaemon("nuwax_task", "revoke", context);
    if (!revoked?.ok || revoked.result?.drained !== true) return taskResult(false, "handoffPending");
    const reply = await requestDaemon("nuwax_task", "takeover", context);
    if (context.epoch !== task.epoch || !getCuaPreviewIdentity(id)) return taskResult(false, "operationCancelled");
    const success = reply?.ok === true && reply.result?.activated === true;
    return taskResult(success, success ? undefined : "targetActivationFailed");
  });
}
