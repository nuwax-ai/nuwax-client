/**
 * ACP Client - Agent Client Protocol connection manager for Electron
 *
 * Spawns an ACP-compatible agent binary as a subprocess and communicates
 * via NDJSON over stdio. Uses @agentclientprotocol/sdk's ClientSideConnection + ndJsonStream.
 *
 * Supported engines:
 * - claude-code:  spawn `claude-code-acp-ts` (npm-local dependency)
 * - nuwaxcode:    spawn `nuwaxcode acp` (npm-local dependency)
 *
 * References Tauri client's rcoder_impl.rs pattern:
 * - Binaries installed as npm-local dependencies in ~/.nuwaclaw/node_modules/.bin/
 * - CLAUDE_CODE_ACP_PATH env var points to claude-code-acp-ts binary
 * - ACP protocol uses NDJSON (newline-delimited JSON) over stdin/stdout
 */

import type { ChildProcess } from "child_process";
import { spawnAcpProcess } from "./acpProcess";
import { Readable, Writable, Transform } from "stream";
import * as path from "path";
import * as fs from "fs";
import { app } from "electron";
import log from "electron-log";
import { resolveCodexRoute, takeAliasedEnv } from "./acpEnvAliases";
import {
  getAppEnv,
  applySharedPackageManagerCacheEnv,
  getNuwaxcodeBundledBinPath,
  getHarnessAcpBundledDir,
  resolveBundledHarnessEnginePath,
  getNodeBinPathWithFallback,
  getClaudeCodeAcpBundledDir,
} from "../../system/dependencies";
import { APP_DATA_DIR_NAME, LOGS_DIR_NAME } from "../../constants";
import { resolveHarnessAcp } from "@nuwax-ai/agent-kit";
import { getAppDataDir } from "../../system/appPaths";
import {
  resolveIsolatedHomePath,
  type IsolatedHomeScope,
} from "./isolatedHomePaths";
import { prepareOpencodePluginShareForHome } from "./opencodePluginShare";
import { isWindows } from "../../system/shellEnv";
import { createPlatformAdapter } from "../../system/platformAdapter";
import {
  resolveNpmPackageEntry,
  resolveNpmBinShimSpawnTarget,
} from "../../utils/spawnNoWindow";
import { processRegistry } from "../../system/processRegistry";
import { killProcessTreeGraceful } from "../../utils/processTree";
import { writeBundledDevShellProfiles } from "../../utils/shellProfile";
import { perfEmitter } from "../perf/perfEmitter";
import { firstTokenTrace } from "../perf/firstTokenTrace";
import { resolveCustomAgentBinary } from "../../agentInstaller";
import {
  applyOpenAICompatibleEnv,
  resolveOpenAICompatModel,
} from "./openAICompatRouting";

export interface AcpProcessErrorMetadata {
  code?: string;
  errno?: number | string;
  syscall?: string;
}

const processErrors = new WeakMap<ChildProcess, AcpProcessErrorMetadata>();

// Only retain system error tokens, never messages, paths or arbitrary properties.
function safeProcessError(error: Error): AcpProcessErrorMetadata {
  const { code, errno, syscall } = error as NodeJS.ErrnoException;
  const metadata: AcpProcessErrorMetadata = {};
  if (typeof code === "string" && /^E[A-Z0-9_]{1,63}$/.test(code)) {
    metadata.code = code;
  }
  if (typeof errno === "number" && Number.isFinite(errno)) {
    metadata.errno = errno;
  } else if (typeof errno === "string" && /^E[A-Z0-9_]{1,63}$/.test(errno)) {
    metadata.errno = errno;
  }
  // Node can report e.g. "spawn /private/path/to/binary".
  if (typeof syscall === "string") {
    const call = /^([a-z][a-z0-9_]{0,63})(?:\s|$)/i.exec(syscall);
    if (call) metadata.syscall = call[1];
  }
  return metadata;
}

export function getAcpProcessSnapshot(proc: ChildProcess | null) {
  return {
    pid: proc?.pid ?? null,
    exitCode: proc?.exitCode ?? null,
    signalCode: proc?.signalCode ?? null,
    killed: proc?.killed ?? false,
    processError: proc ? { ...processErrors.get(proc) } : {},
  };
}

function extractSessionIdFromLine(line: string): string | undefined {
  try {
    const obj = JSON.parse(line) as {
      sessionId?: unknown;
      params?: { sessionId?: unknown };
      result?: { sessionId?: unknown };
      data?: { sessionId?: unknown };
      update?: { sessionId?: unknown };
    };
    const candidates = [
      obj.sessionId,
      obj.params?.sessionId,
      obj.result?.sessionId,
      obj.data?.sessionId,
      obj.update?.sessionId,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c) return c;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

type McpTransportStatus = "stable" | "reconnecting";

interface McpTransportTelemetry {
  status: McpTransportStatus;
  lastDisconnectAt?: number;
  lastReconnectAttemptAt?: number;
  lastReconnectAt?: number;
  lastSignal?: string;
}

/**
 * 后端未按模型下发上下文窗口时的兜底值。仅当 NUWAX_MODEL_CONTEXT_WINDOW /
 * CODEX_MODEL_CONTEXT_WINDOW 都没设置时使用；后端下发值优先（2026-11-09 事故复盘）。
 * 对外只暴露 NUWAX_ 前缀：日志与进程环境里不应出现上游引擎的名字。
 */
const DEFAULT_NUWAX_MODEL_CONTEXT_WINDOW = "200000";

const mcpTransportTelemetry = new WeakMap<
  ChildProcess,
  McpTransportTelemetry
>();

export interface McpTransportSnapshot {
  status: McpTransportStatus;
  lastDisconnectAt?: number;
  lastReconnectAttemptAt?: number;
  lastReconnectAt?: number;
  lastSignal?: string;
}

function ensureTelemetry(proc: ChildProcess): McpTransportTelemetry {
  const existing = mcpTransportTelemetry.get(proc);
  if (existing) return existing;
  const initial: McpTransportTelemetry = { status: "stable" };
  mcpTransportTelemetry.set(proc, initial);
  return initial;
}

function updateMcpTransportTelemetry(proc: ChildProcess, line: string): void {
  const telemetry = ensureTelemetry(proc);
  const lower = line.toLowerCase();
  const now = Date.now();
  const preview = line.length > 240 ? line.slice(0, 240) + "..." : line;

  const isDisconnect =
    (lower.includes("transport error") &&
      (lower.includes("sse stream disconnected") ||
        lower.includes("typeerror: terminated"))) ||
    lower.includes("sse stream disconnected");
  if (isDisconnect) {
    telemetry.status = "reconnecting";
    telemetry.lastDisconnectAt = now;
    telemetry.lastSignal = preview;
    return;
  }

  if (lower.includes("reconnecting in")) {
    telemetry.status = "reconnecting";
    telemetry.lastReconnectAttemptAt = now;
    telemetry.lastSignal = preview;
    return;
  }

  const isReconnected =
    lower.includes("mcp session reconnected") ||
    lower.includes("connected via streamablehttpclienttransport");
  if (isReconnected) {
    telemetry.status = "stable";
    telemetry.lastReconnectAt = now;
    telemetry.lastSignal = preview;
  }
}

export function getMcpTransportSnapshot(
  proc?: ChildProcess | null,
): McpTransportSnapshot | null {
  if (!proc) return null;
  const telemetry = mcpTransportTelemetry.get(proc);
  if (!telemetry) return null;
  return {
    status: telemetry.status,
    lastDisconnectAt: telemetry.lastDisconnectAt,
    lastReconnectAttemptAt: telemetry.lastReconnectAttemptAt,
    lastReconnectAt: telemetry.lastReconnectAt,
    lastSignal: telemetry.lastSignal,
  };
}

export function isMcpReconnectWindowActive(
  proc?: ChildProcess | null,
  windowMs = 4000,
): boolean {
  if (!proc) return false;
  const telemetry = mcpTransportTelemetry.get(proc);
  if (!telemetry) return false;
  const now = Date.now();
  const hasRecentDisconnect =
    telemetry.lastDisconnectAt !== undefined &&
    now - telemetry.lastDisconnectAt <= windowMs;
  const hasRecentReconnect =
    telemetry.lastReconnectAt !== undefined &&
    now - telemetry.lastReconnectAt <= Math.min(windowMs, 1500);
  return (
    telemetry.status === "reconnecting" ||
    hasRecentDisconnect ||
    hasRecentReconnect
  );
}

// ==================== Types ====================

/** ACP MCP Server types (matching @agentclientprotocol/sdk schema) */
export interface AcpEnvVariable {
  name: string;
  value: string;
}

export interface AcpHttpHeader {
  name: string;
  value: string;
}

export type AcpMcpServer =
  | { name: string; command: string; args: string[]; env: AcpEnvVariable[] }
  | { name: string; url: string; headers: AcpHttpHeader[]; type: "http" }
  | { name: string; url: string; headers: AcpHttpHeader[]; type: "sse" };

/** ACP SDK module shape (loaded dynamically since it's ESM) */
export interface AcpSdkModule {
  ndJsonStream: (
    input: WritableStream,
    output: ReadableStream<Uint8Array>,
  ) => unknown;
  ClientSideConnection: new (
    clientFactory: (agent: unknown) => unknown,
    stream: unknown,
  ) => AcpClientSideConnection;
  PROTOCOL_VERSION: number;
}

/** ClientSideConnection interface */
export interface AcpClientSideConnection {
  initialize(params: {
    protocolVersion: number;
    clientCapabilities?: Record<string, unknown>;
  }): Promise<{
    protocolVersion: number;
    agentInfo?: { name?: string; version?: string };
    agentCapabilities?: Record<string, unknown>;
  }>;

  authenticate?(params: {
    methodId: string;
  }): Promise<{ _meta?: Record<string, unknown> } | void>;

  newSession(params: {
    cwd: string;
    mcpServers: Array<AcpMcpServer>;
    _meta?: { [key: string]: unknown } | null;
  }): Promise<{ sessionId: string }>;

  /** Restores session context without replaying history (chat fallback when loadSession is unavailable). */
  resumeSession?(params: {
    sessionId: string;
    cwd: string;
    mcpServers: Array<AcpMcpServer>;
    _meta?: { [key: string]: unknown } | null;
  }): Promise<{
    modes?: unknown;
    configOptions?: unknown;
  }>;

  /** Loads session and replays history via session/update — chat path uses this with SSE suppression when resume is unavailable. */
  loadSession?(params: {
    sessionId: string;
    cwd: string;
    mcpServers: Array<AcpMcpServer>;
    _meta?: { [key: string]: unknown } | null;
  }): Promise<{
    modes?: unknown;
    configOptions?: unknown;
  }>;

  prompt(params: {
    sessionId: string;
    prompt: Array<{
      type: string;
      text?: string;
      uri?: string;
      mimeType?: string;
    }>;
    _meta?: { [key: string]: unknown } | null;
  }): Promise<{ stopReason: string }>;

  cancel(params: { sessionId: string }): Promise<void>;

  setSessionMode?(params: {
    sessionId: string;
    modeId: string;
  }): Promise<{ _meta?: Record<string, unknown> } | void>;

  /**
   * OpenCode/nuwaxcode currently exposes session model mutation as an unstable ACP
   * extension. Keep it optional so other engines remain unaffected.
   */
  unstable_setSessionModel?(params: {
    sessionId: string;
    modelId: string;
  }): Promise<{ _meta?: Record<string, unknown> } | void>;

  /**
   * Some ACP agents expose model switching through a generic config option API.
   * Keep this optional as a fallback for engines that don't implement the
   * unstable dedicated session model method.
   */
  setSessionConfigOption?(params: {
    sessionId: string;
    configId: string;
    value: string;
  }): Promise<{ _meta?: Record<string, unknown> } | void>;

  closed: Promise<void>;
}

/** ACP Client handler interface (callbacks from agent → client) */
export interface AcpClientHandler {
  sessionUpdate?(params: {
    sessionId: string;
    update: AcpSessionUpdate;
  }): Promise<void>;

  requestPermission?(
    params: AcpPermissionRequest,
  ): Promise<AcpPermissionResponse>;

  readTextFile?(params: {
    sessionId: string;
    uri: string;
  }): Promise<{ content: string }>;

  writeTextFile?(params: {
    sessionId: string;
    uri: string;
    content: string;
  }): Promise<Record<string, never>>;

  // --- ACP Terminal API (terminal/* methods) ---

  createTerminal?(params: {
    sessionId: string;
    command: string;
    args?: string[];
    env?: Array<{ name: string; value: string }>;
    cwd?: string | null;
    outputByteLimit?: number | null;
  }): Promise<{ terminalId: string }>;

  terminalOutput?(params: { sessionId: string; terminalId: string }): Promise<{
    output: string;
    truncated: boolean;
    exitStatus?: {
      exitCode: number | null;
      signal: string | null;
    } | null;
  }>;

  waitForTerminalExit?(params: {
    sessionId: string;
    terminalId: string;
  }): Promise<{ exitCode: number | null; signal: string | null }>;

  killTerminal?(params: {
    sessionId: string;
    terminalId: string;
  }): Promise<Record<string, never>>;

  releaseTerminal?(params: {
    sessionId: string;
    terminalId: string;
  }): Promise<Record<string, never>>;
}

/** ACP session update types */
export type AcpSessionUpdate =
  | AcpAgentMessageChunk
  | AcpAgentThoughtChunk
  | AcpToolCall
  | AcpToolCallUpdate
  | AcpSessionInfoUpdate
  | AcpUsageUpdate
  | { sessionUpdate: string; [key: string]: unknown };

export interface AcpAgentMessageChunk {
  sessionUpdate: "agent_message_chunk";
  content: { type: string; text?: string };
}

export interface AcpAgentThoughtChunk {
  sessionUpdate: "agent_thought_chunk";
  content: { type: string; text?: string };
}

export interface AcpToolCall {
  sessionUpdate: "tool_call";
  toolCallId: string;
  title: string;
  kind?: string;
  status: string;
  rawInput?: unknown;
  content?: Array<{ type: string; [key: string]: unknown }>;
  locations?: unknown[];
}

export interface AcpToolCallUpdate {
  sessionUpdate: "tool_call_update";
  toolCallId: string;
  status: string;
  /** nuwaxcode sends kind/title in update even though spec only requires them in tool_call */
  kind?: string;
  title?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: Array<{ path?: string; [key: string]: unknown }>;
  content?: Array<{ type: string; [key: string]: unknown }>;
}

export interface AcpSessionInfoUpdate {
  sessionUpdate: "session_info_update";
  title?: string;
  [key: string]: unknown;
}

export interface AcpUsageUpdate {
  sessionUpdate: "usage_update";
  [key: string]: unknown;
}

export type AcpPermissionOptionKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always";

export interface AcpPermissionOption {
  optionId: string;
  kind: AcpPermissionOptionKind;
  name: string;
}

export interface AcpPermissionRequest {
  sessionId: string;
  toolCall: {
    toolCallId: string;
    title?: string | null;
    kind?: string | null;
    rawInput?: unknown;
  };
  options: AcpPermissionOption[];
}

export interface AcpPermissionResponse {
  outcome: {
    outcome: "selected" | "cancelled";
    optionId?: string;
  };
}

/** Config for creating an ACP connection */
export interface AcpConnectionConfig {
  /** Binary path to spawn (e.g. claude-code-acp-ts or nuwaxcode) */
  binPath: string;
  /** Binary arguments (e.g. [] for claude-code-acp-ts, ['acp'] for nuwaxcode) */
  binArgs: string[];
  /** Whether the binary is a native executable (not a JS file) */
  isNative?: boolean;
  workspaceDir: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  apiProtocol?: string;
  env?: Record<string, string>;
  /** Engine type for process registry tracking */
  engineType?: "claude-code" | "nuwaxcode" | "codex" | "codex-cli";
  /** Purpose of this process (for process registry) */
  purpose?: "engine";
  /** Isolated HOME scope (project / ephemeral) */
  isolatedHomeScope?: IsolatedHomeScope;
}

/** Result of creating an ACP connection */
export interface AcpConnectionResult {
  connection: AcpClientSideConnection;
  process: ChildProcess;
  /** Isolated HOME directory created for this ACP process (for cleanup) */
  isolatedHome: string;
  /**
   * 🔧 FIX: Cleanup function to properly dispose of the ACP process.
   * Removes all event listeners to prevent handle leaks.
   *
   * IMPORTANT: Call this before destroying the process to release Windows handles!
   */
  cleanup: () => void;
}

// ==================== SDK Loader ====================

let _acpSdkPromise: Promise<AcpSdkModule> | null = null;

/**
 * Dynamically load the ACP SDK (@agentclientprotocol/sdk).
 *
 * Uses `new Function('s', 'return import(s)')` to bypass CJS → ESM restriction
 * (tsc compiles import() to require() in CJS mode).
 */
export function loadAcpSdk(): Promise<AcpSdkModule> {
  if (!_acpSdkPromise) {
    const dynamicImport = new Function(
      "specifier",
      "return import(specifier)",
    ) as (specifier: string) => Promise<AcpSdkModule>;

    _acpSdkPromise = dynamicImport("@agentclientprotocol/sdk").catch(
      (error) => {
        log.error("[AcpClient] Failed to load ACP SDK:", error);
        _acpSdkPromise = null;
        throw error;
      },
    );
  }

  return _acpSdkPromise;
}

// ==================== Binary Path ====================

/**
 * Get ACP package directory
 * 优先使用应用内集成的 bundled 路径，回退到 node_modules
 */
function getAcpPackageDir(packageName: string): string | null {
  // claude-code-acp-ts: 优先检查 bundled 目录
  if (packageName === "claude-code-acp-ts") {
    const bundledDir = getClaudeCodeAcpBundledDir();
    if (bundledDir) {
      return bundledDir;
    }
  }

  // 回退到 node_modules
  const nodeModules = path.join(
    app.getPath("home"),
    APP_DATA_DIR_NAME,
    "node_modules",
  );
  const packageDir = path.join(nodeModules, packageName);
  return fs.existsSync(packageDir) ? packageDir : null;
}

function getNuwaxcodePersistentLogDir(): string {
  return path.join(
    app.getPath("home"),
    APP_DATA_DIR_NAME,
    LOGS_DIR_NAME,
    "nuwaxcode",
  );
}

/**
 * Resolve ACP binary path for a given engine type.
 *
 * - claude-code → ~/.nuwaclaw/node_modules/claude-code-acp-ts (JS entry, spawned via node)
 * - nuwaxcode   → native Go binary (spawned directly, not via node)
 *
 * For nuwaxcode, we resolve the platform-specific native binary directly
 * instead of going through the JS wrapper (nuwaxcode/bin/nuwaxcode).
 *
 * Reasons:
 * 1. The JS wrapper uses `spawnSync(binary, args, { stdio: 'inherit' })`
 *    without `windowsHide: true`, causing console popup on Windows.
 * 2. The intermediate Node.js process adds an unnecessary process layer
 *    that can interfere with SIGTERM propagation and stdio piping.
 * 3. Spawning the native binary directly is faster and more reliable.
 *
 * Returns `isNative: true` when the binary should be spawned directly
 * (not via `node`).
 */
export function resolveAcpBinary(
  engine: "claude-code" | "nuwaxcode" | "codex" | "codex-cli" | (string & {}),
): {
  binPath: string;
  binArgs: string[];
  isNative: boolean;
} {
  if (engine === "claude-code") {
    const packageDir = getAcpPackageDir("claude-code-acp-ts");
    const entryPath = packageDir
      ? resolveNpmPackageEntry(packageDir, "claude-code-acp-ts")
      : null;
    return {
      binPath: entryPath || "",
      binArgs: [],
      isNative: false,
    };
  }

  if (engine === "nuwaxcode") {
    // nuwaxcode: resolve platform-specific native binary directly
    const nativePath = resolveNuwaxcodeNativeBinary();
    if (nativePath) {
      log.info(`[AcpClient] nuwaxcode: using native binary: ${nativePath}`);
      return {
        binPath: nativePath,
        binArgs: ["acp"],
        isNative: true,
      };
    }

    // Fallback: use JS wrapper (will have Windows popup issue)
    log.warn(
      "[AcpClient] nuwaxcode: native binary not found, falling back to JS wrapper",
    );
    const packageDir = getAcpPackageDir("nuwaxcode");
    const entryPath = packageDir
      ? resolveNpmPackageEntry(packageDir, "nuwaxcode")
      : null;
    return {
      binPath: entryPath || "",
      binArgs: ["acp"],
      isNative: false,
    };
  }

  // -- codex / codex-cli (backward compat) --

  if (engine === "codex" || engine === "codex-cli") {
    // Codex 统一经 harness adapter 启动；支持随包资源和应用内 npm 修复安装。
    const adapterDir =
      getHarnessAcpBundledDir() ||
      getAcpPackageDir("@nuwax-ai/nuwax-harness-acp-ts");
    const entryOverride = adapterDir
      ? path.join(adapterDir, "dist", "index.js")
      : undefined;
    const resolved = resolveHarnessAcp(
      entryOverride ? { entryOverride } : undefined,
    );
    log.info(
      `[AcpClient] codex: using Nuwax Harness adapter: ${resolved.args[0]}`,
    );
    return { binPath: resolved.args[0], binArgs: [], isNative: false };
  }

  // Unknown engine type → try to resolve as custom agent
  log.info(
    `[AcpClient] Unknown engine "${engine}", attempting custom agent resolution`,
  );

  // 服务端常下发 command:"node" + args:[bundle.mjs] 的自定义 ACP Agent。
  // Electron GUI 进程 PATH 通常不含 shell/nvm 的 node，必须用应用内 bundled Node，
  // 否则会回退成裸命令 "node"，再被 createAcpConnection 的 existsSync 误判为缺失。
  if (isNodeInterpreterCommand(engine)) {
    const nodePath = getNodeBinPathWithFallback();
    if (nodePath) {
      log.info(
        `[AcpClient] custom agent: resolving "${engine}" → bundled node: ${nodePath}`,
      );
      return { binPath: nodePath, binArgs: [], isNative: true };
    }
    log.warn(
      `[AcpClient] custom agent: "${engine}" requested but bundled/system node not found`,
    );
  }

  const customBinPath = resolveCustomAgentBinary(engine);
  const candidatePath =
    customBinPath ??
    (looksLikeFilesystemPath(engine) && fs.existsSync(engine) ? engine : null);

  if (candidatePath) {
    const shimResolved = resolveNpmBinShimSpawnTarget(candidatePath);
    if (shimResolved) {
      return {
        binPath: shimResolved.binPath,
        binArgs: [],
        isNative: shimResolved.isNative,
      };
    }
    return { binPath: candidatePath, binArgs: [], isNative: true };
  }

  // Final fallback: assume the command is in PATH
  log.warn(
    `[AcpClient] Custom agent "${engine}" not found, assuming it's in PATH`,
  );
  return { binPath: engine, binArgs: [], isNative: true };
}

/** 判断是否为 Node 解释器命令名（非文件系统路径） */
export function isNodeInterpreterCommand(command: string): boolean {
  return /^node(\.exe)?$/i.test(command.trim());
}

function looksLikeFilesystemPath(command: string): boolean {
  return (
    path.isAbsolute(command) ||
    /^[a-zA-Z]:[\\/]/.test(command) ||
    command.startsWith("\\\\") ||
    command.includes("/") ||
    command.includes("\\")
  );
}

/**
 * Resolve the platform-specific nuwaxcode native binary path.
 *
 * nuwaxcode npm package uses optionalDependencies with platform-specific packages:
 * - nuwaxcode-darwin-arm64/bin/nuwaxcode
 * - nuwaxcode-windows-x64/bin/nuwaxcode.exe
 * - nuwaxcode-linux-x64/bin/nuwaxcode
 * etc.
 *
 * Logic mirrors nuwaxcode/bin/nuwaxcode JS wrapper.
 */
function resolveNuwaxcodeNativeBinary(): string | null {
  // 应用内打包的二进制（唯一来源）
  const bundledPath = getNuwaxcodeBundledBinPath();
  if (bundledPath) {
    log.info("[AcpClient] nuwaxcode: using bundled binary:", bundledPath);
    return bundledPath;
  }

  log.error("[AcpClient] nuwaxcode: bundled binary not found");
  return null;
}

// ==================== Connection Factory ====================

/**
 * Create an ACP connection by spawning an agent binary and establishing
 * a ClientSideConnection over NDJSON stdin/stdout.
 *
 * Works with any ACP-compatible binary:
 * - claude-code-acp-ts (no args)
 * - nuwaxcode acp (args: ['acp'])
 */
export async function createAcpConnection(
  config: AcpConnectionConfig,
  clientHandler: AcpClientHandler,
): Promise<AcpConnectionResult> {
  const { binPath, binArgs } = config;
  let effectiveBinArgs = [...binArgs];

  // 仅对真实路径做存在性检查；裸命令名（如历史回退的 PATH 命令）交给 spawn 解析。
  // node 自定义 agent 应已在 resolveAcpBinary 中解析为 absolute bundled 路径。
  if (looksLikeFilesystemPath(binPath) && !fs.existsSync(binPath)) {
    throw new Error(
      `ACP binary not found at: ${binPath}. Please install it first.`,
    );
  }

  if (config.engineType === "nuwaxcode" && firstTokenTrace.isDeepMode()) {
    if (!effectiveBinArgs.includes("--print-logs")) {
      effectiveBinArgs.push("--print-logs");
    }
    if (!effectiveBinArgs.includes("--log-level")) {
      effectiveBinArgs.push(
        "--log-level",
        process.env.NUWAX_TRACE_NUWAXCODE_LOG_LEVEL || "DEBUG",
      );
    }
    if (!effectiveBinArgs.includes("--log-dir")) {
      const traceLogDir = firstTokenTrace.getNuwaxcodeLogDir();
      if (traceLogDir) {
        fs.mkdirSync(traceLogDir, { recursive: true });
        effectiveBinArgs.push("--log-dir", traceLogDir);
      }
    }
    firstTokenTrace.trace(
      "acp.conn.nuwaxcode.trace_flags",
      { engine: config.engineType },
      { binPath, args: effectiveBinArgs },
    );
  }

  const setupTimer = perfEmitter.start();

  // Build isolated environment (aligned with rcoder + engineManager pattern)
  // 1. Start with getAppEnv() for complete isolation (node/npm/uv paths, no system PATH)
  // 2. Create isolated HOME/config dir so Claude Code uses empty config (not user's global ~/.claude/)
  // 3. Only inject model vars from ACP-provided config

  // Create isolated HOME directory with empty .claude/ config
  // This prevents Claude Code from reading user's global ~/.claude/settings.json
  // 使用 ~/.nuwaclaw/run/ 而非 os.tmpdir()，避免 Unix socket 路径过长（macOS 限制 104 字符）
  const scope = config.isolatedHomeScope ?? { kind: "ephemeral" as const };
  const { homeDir: isolatedHome, runId } = resolveIsolatedHomePath(scope);
  fs.mkdirSync(path.join(isolatedHome, ".claude"), { recursive: true });
  log.info("[AcpClient] Isolated HOME resolved", {
    isolatedHome,
    runId,
    scopeKind: scope.kind,
    persistent: scope.kind === "project",
  });

  // 获取应用隔离环境变量（包含隔离的 PATH、npm、uv 配置等）
  const appEnv = getAppEnv();

  // Isolated Git Bash login shells on Windows rebuild PATH; inject full bundled dev env
  // (node/pnpm/uv/rg + PNPM_/UV_ exports) — same coverage as ttyd pickTtydBundledEnv.
  writeBundledDevShellProfiles(isolatedHome, appEnv);

  // 构建最终环境变量：以 appEnv 为基础，添加 ACP 特定配置
  const env: Record<string, string> = {
    ...appEnv, // 包含完全隔离的 PATH、NODE_PATH、npm/uv 配置等

    // Isolated HOME — Claude Code won't read user's global config
    HOME: isolatedHome,
    USERPROFILE: isolatedHome, // Windows

    // XDG 目录（Unix/Linux 标准，Windows 上也设置以兼容可能的工具）
    // 配置/数据仍隔离到 project home；包管理器缓存见下方二次覆盖
    XDG_CONFIG_HOME: path.join(isolatedHome, ".config"),
    XDG_DATA_HOME: path.join(isolatedHome, ".local", "share"),
    XDG_CACHE_HOME: path.join(isolatedHome, ".cache"),

    // 引擎配置目录
    CLAUDE_CONFIG_DIR: path.join(isolatedHome, ".claude"),
    NUWAXCODE_CONFIG_DIR: path.join(isolatedHome, ".nuwaxcode"),

    // Disable non-essential traffic (aligned with rcoder ENV_DISABLE_NONESSENTIAL)
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };

  // HOME/XDG 重定向后必须再写回共享缓存路径，避免每项目一份 .cache/pnpm、.npm
  applySharedPackageManagerCacheEnv(env, appEnv);

  // Set TMPDIR to isolatedHome/tmp so that sandboxed engines (e.g. claude-code
  // under macOS seatbelt strict mode) create temp files inside a writable path.
  // Without this, os.tmpdir() resolves to /private/tmp which is NOT in the
  // seatbelt writablePaths, causing EPERM on mkdir for Bash/Glob tools.
  const isolatedTmp = path.join(isolatedHome, "tmp");
  fs.mkdirSync(isolatedTmp, { recursive: true });
  env.TMPDIR = isolatedTmp;
  env.TEMP = isolatedTmp;
  env.TMP = isolatedTmp;

  const isNuwaxcodeEngine = config.engineType === "nuwaxcode";

  // nuwaxcode：共享 @opencode-ai/plugin，避免每个 project home 复制 ~60MB node_modules
  // Windows=junction / Unix=symlink；失败不阻断启动
  if (isNuwaxcodeEngine) {
    try {
      const pluginLink = await prepareOpencodePluginShareForHome(isolatedHome);
      if (pluginLink.ok) {
        log.info("[AcpClient] Opencode plugin share ready", {
          version: pluginLink.version,
          linkType: pluginLink.linkType,
          skipped: pluginLink.skipped,
          linkPath: pluginLink.linkPath,
        });
      } else if (!pluginLink.skipped) {
        log.warn("[AcpClient] Opencode plugin share unavailable", {
          reason: pluginLink.reason,
        });
      }
    } catch (err) {
      log.warn("[AcpClient] Opencode plugin share prepare error:", err);
    }
  }

  // Set model/api vars from ACP config only (never from user's global env)
  if (config.apiKey) {
    env.ANTHROPIC_API_KEY = config.apiKey;
    env.ANTHROPIC_AUTH_TOKEN = config.apiKey;
  }
  if (config.baseUrl) env.ANTHROPIC_BASE_URL = config.baseUrl;
  // config.model 必须由上层设置（ensureEngineForRequest 从 model_provider 或 agent_config env 提取）
  if (config.model) {
    env.ANTHROPIC_MODEL = config.model;
  } else {
    log.warn(
      "[AcpClient] ⚠️ config.model not set, engine will use built-in default model (not recommended)",
    );
  }
  // Per-source route capture BEFORE any merging (2026-11-09 review P1):
  // merging config.env into env first could weld the backend's OPENAI_BASE_URL
  // to the process env's OPENAI_API_KEY, presenting two gateways as one route.
  const processEnvRoute = {
    baseUrl: appEnv.OPENAI_BASE_URL,
    apiKey: appEnv.OPENAI_API_KEY,
  };
  const backendEnvRoute = {
    baseUrl: config.env?.OPENAI_BASE_URL,
    apiKey: config.env?.OPENAI_API_KEY,
  };

  if (config.env) Object.assign(env, config.env);

  // nuwaxcode runs on opencode and prefers OPENCODE_MODEL.
  // Keep this assignment before OpenAI compatibility injection so model-based
  // detection can use OPENCODE_MODEL when present.
  if (isNuwaxcodeEngine) {
    if (config.model && !env.OPENCODE_MODEL) {
      env.OPENCODE_MODEL = config.model;
    }
  }

  // harness adapter 使用 CODEX_* 配置模型、端点与认证。
  const codexResolvedModel = resolveOpenAICompatModel({
    model: config.model,
    envModel:
      env.OPENCODE_MODEL ||
      env.ANTHROPIC_MODEL ||
      env.NUWAX_MODEL ||
      env.CODEX_MODEL,
  });
  applyOpenAICompatibleEnv(config, env);

  if (config.engineType === "codex" || config.engineType === "codex-cli") {
    // 先把 NUWAX_/CODEX_ 两种拼写收敛成一份（NUWAX_ 优先，来自后端 agent_config.env
    // 或进程环境），再按明确优先级写回唯一拼写：适配器遇到"两种拼写、两个取值"
    // 会直接启动失败（2026-11-09 review P1）。
    const backend = {
      model: takeAliasedEnv(env, "MODEL"),
      baseUrl: takeAliasedEnv(env, "BASE_URL"),
      apiKey: takeAliasedEnv(env, "API_KEY"),
      providerId: takeAliasedEnv(env, "PROVIDER_ID"),
      wireApi: takeAliasedEnv(env, "WIRE_API"),
      apiProtocol: takeAliasedEnv(env, "API_PROTOCOL"),
      disableThinking: takeAliasedEnv(env, "DISABLE_THINKING"),
      reasoningEffort: takeAliasedEnv(env, "MODEL_REASONING_EFFORT"),
      contextWindow: takeAliasedEnv(env, "MODEL_CONTEXT_WINDOW"),
    };

    const route = resolveCodexRoute({
      configBaseUrl: config.baseUrl,
      configApiKey: config.apiKey,
      envBaseUrl: processEnvRoute.baseUrl,
      envApiKey: processEnvRoute.apiKey,
      backendEnvBaseUrl: backendEnvRoute.baseUrl,
      backendEnvApiKey: backendEnvRoute.apiKey,
      backendBaseUrl: backend.baseUrl,
      backendApiKey: backend.apiKey,
    });
    if (route.apiKey) {
      env.NUWAX_API_KEY = route.apiKey;
    } else {
      // Keyless route: drop every spelling the adapter would borrow from so a
      // credential from another source can never reach this endpoint.
      delete env.NUWAX_API_KEY;
      delete env.CODEX_API_KEY;
      delete env.OPENAI_API_KEY;
    }
    if (config.apiKey && route.apiKey === config.apiKey) {
      env.OPENAI_API_KEY = config.apiKey;
    }
    const model = codexResolvedModel?.providerModel || backend.model;
    if (model) {
      env.NUWAX_MODEL = model;
    }
    if (route.baseUrl) {
      env.NUWAX_BASE_URL = route.baseUrl;
    }
    // 后端显式下发过 provider id 就尊重它；否则沿用历史默认值。
    env.NUWAX_PROVIDER_ID = backend.providerId || "zhipu-glm-5";
    // 后端 agent_config.env 用 claude-code 的拼写下发「关闭思考」
    // （CLAUDE_CODE_DISABLE_THINKING），而适配器只认 NUWAX_/CODEX_ 前缀
    // （isThinkingDisabled 读 CODEX_DISABLE_THINKING/NUWAX_DISABLE_THINKING）。
    // 不映射的话这个意图直接丢失，适配器按自己的默认力度请求——模型平台
    // 会拒绝不匹配的组合（如「该模型始终思考，不支持关闭思考」）。
    // 后端未要求关闭时不下发，适配器便不 pin none，走模型默认力度。
    const disableThinking =
      backend.disableThinking ?? env.CLAUDE_CODE_DISABLE_THINKING;
    if (disableThinking) {
      env.NUWAX_DISABLE_THINKING = disableThinking;
    }
    if (backend.reasoningEffort) {
      env.NUWAX_MODEL_REASONING_EFFORT = backend.reasoningEffort;
    }
    // OpenAI 族：harness 默认走 Responses，国内平台多只支持 Chat，
    // NUWAX_WIRE_API=chat 强制 Chat→Responses 翻译。
    // Anthropic 族（model_provider.api_protocol=anthropic）：协议族由
    // NUWAX_API_PROTOCOL 选择，且不得携带 WIRE_API（适配器启动即拒绝）。
    const isAnthropicProtocol =
      (config.apiProtocol || "").trim().toLowerCase() === "anthropic";
    if (isAnthropicProtocol) {
      env.NUWAX_API_PROTOCOL = "anthropic";
      // 适配器对网关自定义模型（不在引擎内置表里的，如 GLM-5.3-Flash）兜底
      // effort=medium（适配器 createModelId 的 `?? "medium"`），桥把它作为
      // output_config.effort 发给上游。GLM-5.3 / 5.3-Flash / 5.3-FlashX 官方只接受
      // max/high/low（docs.bigmodel.cn 的 reasoning_effort 说明），medium 会拿到
      // 400/1210——抓包与官方文档双向证实。5.2 会把 medium 映射成 high 所以不报，
      // 这也是不同环境结论不同的原因。这里播种两代都接受的 low。
      // 后端显式下发 NUWAX_MODEL_REASONING_EFFORT 时优先用它——哪个模型/版本该用
      // 哪档只有后端知道；后端要求关闭思考时（上方已映射 NUWAX_DISABLE_THINKING）
      // 不设，让 none 生效。
      if (!env.NUWAX_DISABLE_THINKING && !env.NUWAX_MODEL_REASONING_EFFORT) {
        env.NUWAX_MODEL_REASONING_EFFORT = "low";
      }
    } else {
      env.NUWAX_WIRE_API = backend.wireApi || "chat";
      if (backend.apiProtocol) {
        env.NUWAX_API_PROTOCOL = backend.apiProtocol;
      }
    }
    // 后端可以通过 agent_config.env 下发 NUWAX_MODEL_CONTEXT_WINDOW（或旧拼写
    // CODEX_MODEL_CONTEXT_WINDOW），这里的默认值不得覆盖它：2026-11-09 事故里
    // 200000 把后端按模型下发的窗口盖掉，压缩阈值随之算错。
    env.NUWAX_MODEL_CONTEXT_WINDOW =
      backend.contextWindow || DEFAULT_NUWAX_MODEL_CONTEXT_WINDOW;
    env.CODEX_LOG_DIR = path.join(
      app.getPath("home"),
      APP_DATA_DIR_NAME,
      LOGS_DIR_NAME,
      "codex",
    );
    env.RUST_LOG = "debug";
    // 适配器（nuwax-harness-acp-ts）只认 NUWAX_PATH/CODEX_PATH 定位引擎二进制，
    // 其 homedir() 缓存兜底在下方隔离 HOME 下必然落空，必须显式指向 bundled
    // vendor 或 npm 兜底安装填充的真实 HOME 缓存（见 binaryLocator）。
    const harnessEnginePath = resolveBundledHarnessEnginePath();
    if (harnessEnginePath) {
      env.NUWAX_PATH = harnessEnginePath;
    } else {
      log.warn(
        "[AcpClient] codex: nuwax-harness engine binary not found; adapter app-server spawn will fail",
      );
    }
    // 适配器自身日志目录（文档保证不含 Key 与原始协议内容）
    env.APP_SERVER_LOGS = env.CODEX_LOG_DIR;

    // Windows 上 codex-rs 经 Known Folder API 解析真实 ~/.codex（不吃 HOME/USERPROFILE
    // 重定向），用户本机 .codex 状态（损坏 sqlite 库/并发 WAL 锁）会直接杀掉引擎。
    // CODEX_HOME 整体隔离 + CODEX_SQLITE_HOME 明确 sqlite 库落点，均指
    // isolatedHome/.codex：mac 与现状等价（HOME 重定向已生效），win 补齐隔离语义。
    // codex 不会自建这两个目录（CODEX_HOME 校验存在性、sqlite 建库不建父目录），
    // 必须先 mkdir；backend 显式下发同名 env 时不覆盖。
    const codexHome = path.join(isolatedHome, ".codex");
    fs.mkdirSync(codexHome, { recursive: true });
    if (!env.CODEX_HOME) env.CODEX_HOME = codexHome;
    if (!env.CODEX_SQLITE_HOME) env.CODEX_SQLITE_HOME = codexHome;
  }

  if (isNuwaxcodeEngine) {
    // Compatibility aliases used by opencode paths (nuwaxcode only).
    if (env.OPENAI_API_KEY && !env.OPENCODE_OPENAI_API_KEY) {
      env.OPENCODE_OPENAI_API_KEY = env.OPENAI_API_KEY;
    }
    if (env.OPENAI_BASE_URL && !env.OPENCODE_OPENAI_API_BASE) {
      env.OPENCODE_OPENAI_API_BASE = env.OPENAI_BASE_URL;
    }
  }

  // Ensure nuwaxcode writes detailed logs to persistent app logs directory.
  // Without this, logs default to isolated XDG paths under /tmp and are removed on destroy.
  if (config.engineType === "nuwaxcode" && !env.OPENCODE_LOG_DIR) {
    const persistentLogDir = getNuwaxcodePersistentLogDir();
    fs.mkdirSync(persistentLogDir, { recursive: true });
    env.OPENCODE_LOG_DIR = persistentLogDir;
  }

  // Set CLAUDE_CODE_ACP_PATH for claude-code-acp-ts (matching Tauri's rcoder pattern)
  if (binPath.includes("claude-code-acp-ts")) {
    env.CLAUDE_CODE_ACP_PATH = binPath;
  }

  const envMs = setupTimer.end("acp.conn.env", {
    engine: config.engineType ?? "unknown",
  });

  // 打印最终生效的模型配置（关键调试信息）
  log.info("[AcpClient] 🚀 Spawning ACP binary", {
    binPath,
    binArgs: effectiveBinArgs,
    cwd: config.workspaceDir,
    isolatedHome,
    ANTHROPIC_MODEL: env.ANTHROPIC_MODEL || "(not set)",
    ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL || "(not set)",
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY
      ? env.ANTHROPIC_API_KEY.slice(
          0,
          Math.min(8, Math.floor(env.ANTHROPIC_API_KEY.length / 2)),
        ) + "..."
      : "(not set)",
    OPENCODE_MODEL: env.OPENCODE_MODEL || "(not set)",
    OPENCODE_LOG_DIR: env.OPENCODE_LOG_DIR || "(not set)",
    OPENAI_BASE_URL: env.OPENAI_BASE_URL || "(not set)",
    OPENAI_API_KEY: env.OPENAI_API_KEY
      ? env.OPENAI_API_KEY.slice(
          0,
          Math.min(8, Math.floor(env.OPENAI_API_KEY.length / 2)),
        ) + "..."
      : "(not set)",
    OPENCODE_OPENAI_API_BASE: env.OPENCODE_OPENAI_API_BASE || "(not set)",
    OPENCODE_OPENAI_API_KEY: env.OPENCODE_OPENAI_API_KEY
      ? env.OPENCODE_OPENAI_API_KEY.slice(
          0,
          Math.min(8, Math.floor(env.OPENCODE_OPENAI_API_KEY.length / 2)),
        ) + "..."
      : "(not set)",
    NUWAX_MODEL: env.NUWAX_MODEL || "(not set)",
    NUWAX_BASE_URL: env.NUWAX_BASE_URL || "(not set)",
    NUWAX_PROVIDER_ID: env.NUWAX_PROVIDER_ID || "(not set)",
    NUWAX_WIRE_API: env.NUWAX_WIRE_API || "(not set)",
    NUWAX_MODEL_CONTEXT_WINDOW: env.NUWAX_MODEL_CONTEXT_WINDOW || "(not set)",
    CODEX_LOG_DIR: env.CODEX_LOG_DIR || "(not set)",
    CODEX_HOME: env.CODEX_HOME || "(not set)",
    CODEX_SQLITE_HOME: env.CODEX_SQLITE_HOME || "(not set)",
    RUST_LOG: env.RUST_LOG || "(not set)",
    NUWAX_API_KEY: env.NUWAX_API_KEY
      ? env.NUWAX_API_KEY.slice(
          0,
          Math.min(8, Math.floor(env.NUWAX_API_KEY.length / 2)),
        ) + "..."
      : "(not set)",
  });

  // 1. Spawn ACP binary
  // On Unix, use detached: true so the child gets its own process group,
  // enabling process.kill(-pid) to kill the entire tree on cleanup.
  const spawnTimer = perfEmitter.start();
  const useDetached = !isWindows;
  const proc = spawnAcpProcess({
    binPath,
    args: effectiveBinArgs,
    isNative: config.isNative === true,
    cwd: config.workspaceDir,
    env,
    detached: useDetached,
  });
  // Unref so the parent process can exit without waiting for the child
  // (we manage cleanup explicitly via killProcessTree)
  if (useDetached) {
    proc.unref();
  }

  const spawnMs = spawnTimer.end("acp.conn.spawn", {
    engine: config.engineType ?? "unknown",
    native: !!config.isNative,
  });

  // Register process in the process registry for orphan detection
  if (proc.pid) {
    processRegistry.register(proc.pid, {
      engineId: runId,
      engineType: config.engineType ?? "claude-code",
      purpose: config.purpose ?? "engine",
    });
  }
  ensureTelemetry(proc);

  // Log stderr — 详细输出所有内容
  proc.stderr?.on("data", (data: Buffer) => {
    const text = data.toString().trim();
    if (!text) return;
    const lower = text.toLowerCase();
    if (
      lower.includes("error") ||
      lower.includes("failed") ||
      lower.includes("enoent") ||
      lower.includes("spawn") ||
      lower.includes("mcp server") ||
      lower.includes("certificate") ||
      lower.includes("models.dev") ||
      lower.includes("providers") ||
      lower.includes("rate limit") ||
      lower.includes("使用上限")
    ) {
      log.error("[AcpClient stderr] 🔴", text);
    } else {
      log.warn("[AcpClient stderr]", text);
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      updateMcpTransportTelemetry(proc, trimmed);
    }
    if (firstTokenTrace.isDeepMode()) {
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const preview =
          trimmed.length > 1000 ? trimmed.substring(0, 1000) + "..." : trimmed;
        firstTokenTrace.trace(
          "acp.stderr.line",
          {
            engine: config.engineType,
            sessionId: extractSessionIdFromLine(trimmed),
          },
          { pid: proc.pid, line: preview },
        );
      }
    }
  });

  proc.on("error", (error) => {
    processErrors.set(proc, safeProcessError(error));
    log.error("[AcpClient] Process error diagnostics", getAcpProcessSnapshot(proc));
    log.error("[AcpClient] Process error:", error);
  });

  proc.on("exit", (code, signal) => {
    log.info("[AcpClient] Process exited", { code, signal });
  });

  /**
   * 使用 Transform 流对 stdout 做“仅打日志并透传”，避免与 SDK 争抢同一 Readable。
   * 若直接对 proc.stdout 同时 on('data') 和 Readable.toWeb(proc.stdout)，
   * Node 会形成两个消费者竞争，session/update 通知可能被 data 监听器消费，
   * SDK 收不到，导致没有 agent_message_chunk / agent_thought_chunk，前端无消息返回。
   * 0.8.1 能正常返回正是因为只有 SDK 一个消费者；新版曾加的 stdout 调试监听器导致回退。
   */
  const stdoutLogTransform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const text = chunk.toString();
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const preview =
          trimmed.length > 500 ? trimmed.substring(0, 500) + "..." : trimmed;
        log.info("[AcpClient stdout] 📥", preview);
        if (firstTokenTrace.isDeepMode()) {
          firstTokenTrace.trace(
            "acp.stdout.line",
            {
              engine: config.engineType,
              sessionId: extractSessionIdFromLine(trimmed),
            },
            { pid: proc.pid, line: preview },
          );
        }
      }
      this.push(chunk);
      callback();
    },
  });
  proc.stdout!.pipe(stdoutLogTransform);

  // Debug: log raw stdin NDJSON lines sent to ACP process (stdin 只写不读，无多消费者问题)
  const originalStdinWrite = proc.stdin!.write.bind(proc.stdin!);
  proc.stdin!.write = function (chunk: any, ...args: any[]) {
    const text =
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const preview =
        trimmed.length > 500 ? trimmed.substring(0, 500) + "..." : trimmed;
      log.info("[AcpClient stdin] 📤", preview);
      if (firstTokenTrace.isDeepMode()) {
        firstTokenTrace.trace(
          "acp.stdin.line",
          {
            engine: config.engineType,
            sessionId: extractSessionIdFromLine(trimmed),
          },
          { pid: proc.pid, line: preview },
        );
      }
    }
    return originalStdinWrite(chunk, ...args);
  } as any;

  // 2. Convert Node streams → Web streams（仅从 stdoutLogTransform 读，保证唯一消费者）
  // Wrap post-spawn setup in try/catch: if anything fails after spawn,
  // we must kill the process and unregister it to prevent orphans.
  const bridgeTimer = perfEmitter.start();
  let readable: ReadableStream<Uint8Array>;
  let writable: WritableStream;
  let acp: any;
  let stream: any;
  let connection: AcpClientSideConnection;

  try {
    const ioBridgeTimer = perfEmitter.start();
    readable = Readable.toWeb(stdoutLogTransform) as ReadableStream<Uint8Array>;
    writable = Writable.toWeb(proc.stdin!) as WritableStream;
    ioBridgeTimer.end("acp.conn.ioBridge", {
      engine: config.engineType ?? "unknown",
    });

    // 3. Load ACP SDK and create NDJSON stream
    const sdkTimer = perfEmitter.start();
    acp = await loadAcpSdk();
    sdkTimer.end("acp.conn.sdkLoad", {
      engine: config.engineType ?? "unknown",
    });

    const streamTimer = perfEmitter.start();
    stream = acp.ndJsonStream(writable, readable);
    streamTimer.end("acp.conn.ndjson", {
      engine: config.engineType ?? "unknown",
    });

    // 4. Create ClientSideConnection with client handler
    const connTimer = perfEmitter.start();
    connection = new acp.ClientSideConnection(
      (_agent: unknown) => clientHandler,
      stream,
    ) as AcpClientSideConnection;
    connTimer.end("acp.conn.connection", {
      engine: config.engineType ?? "unknown",
    });
  } catch (e) {
    log.error("[AcpClient] Post-spawn setup failure diagnostics", getAcpProcessSnapshot(proc));
    // Post-spawn setup failed — kill the spawned process to prevent orphan
    log.error("[AcpClient] Post-spawn setup failed, killing process:", e);
    if (proc.pid) {
      processRegistry.unregister(proc.pid);
      await killProcessTreeGraceful(proc.pid, 3000).catch(() => {});
    } else {
      proc.kill();
    }
    throw e;
  }

  const bridgeMs = bridgeTimer.end("acp.conn.bridgeTotal", {
    engine: config.engineType ?? "unknown",
  });

  perfEmitter.duration("acp.conn.create.total", envMs + spawnMs + bridgeMs, {
    engine: config.engineType ?? "unknown",
  });

  // 🔧 FIX: Create cleanup function to properly dispose of event listeners
  // This prevents handle leaks by removing all event listeners before process termination
  const cleanup = () => {
    try {
      // Remove stdout listener (prevents handle leak)
      proc.stdout?.removeAllListeners();
      // Remove stderr listener (prevents handle leak)
      proc.stderr?.removeAllListeners();
      // Remove stdin listener (also restores the wrapped write function)
      proc.stdin?.removeAllListeners();
      // Remove process-level listeners (error, exit)
      proc.removeAllListeners();
      mcpTransportTelemetry.delete(proc);
      log.info(
        "[AcpClient] 🧹 Cleaned up event listeners to prevent handle leaks",
      );
    } catch (e) {
      log.warn("[AcpClient] Cleanup error:", e);
    }
  };

  return {
    connection,
    process: proc,
    isolatedHome,
    cleanup,
  };
}
