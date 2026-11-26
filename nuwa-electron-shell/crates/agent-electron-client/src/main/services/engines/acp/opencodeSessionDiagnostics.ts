/**
 * Diagnostics for nuwaxcode/OpenCode session/load failures.
 * OpenCode persists sessions under isolated HOME (XDG_DATA_HOME/opencode), not project cwd.
 */

import * as fs from "fs";
import * as path from "path";
import { redactStringForLog } from "../../utils/logRedact";
import { getOpencodeLogFile } from "./isolatedHomePaths";

export interface OpencodePersistenceSnapshot {
  isolatedHome: string | null;
  projectDir: string;
  opencodeDataDir: string | null;
  opencodeDataExists: boolean;
  dbFiles: Array<{ name: string; bytes: number }>;
  sessionInfoJsonCount: number;
  flowagentsSessionsInProject: boolean;
  flowagentsSessionsInIsolated: boolean;
}

export function getOpencodeDataDir(isolatedHome: string): string {
  return path.join(isolatedHome, ".local", "share", "opencode");
}

function countSessionInfoJson(dataDir: string): number {
  const infoDir = path.join(dataDir, "storage", "session", "info");
  if (!fs.existsSync(infoDir)) return 0;
  try {
    return fs.readdirSync(infoDir).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

function listDbFiles(dataDir: string): Array<{ name: string; bytes: number }> {
  if (!fs.existsSync(dataDir)) return [];
  try {
    return fs
      .readdirSync(dataDir)
      .filter((f) => f.endsWith(".db"))
      .map((name) => {
        const full = path.join(dataDir, name);
        const st = fs.statSync(full);
        return { name, bytes: st.size };
      });
  } catch {
    return [];
  }
}

function hasFlowagentsSessions(root: string | null): boolean {
  if (!root) return false;
  const dir = path.join(root, ".flowagents", "sessions");
  if (!fs.existsSync(dir)) return false;
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

export function snapshotOpencodePersistence(
  isolatedHome: string | null | undefined,
  projectDir: string,
): OpencodePersistenceSnapshot {
  const home = isolatedHome ?? null;
  const opencodeDataDir = home ? getOpencodeDataDir(home) : null;
  const opencodeDataExists = opencodeDataDir
    ? fs.existsSync(opencodeDataDir)
    : false;

  return {
    isolatedHome: home,
    projectDir,
    opencodeDataDir,
    opencodeDataExists,
    dbFiles: opencodeDataDir ? listDbFiles(opencodeDataDir) : [],
    sessionInfoJsonCount: opencodeDataDir
      ? countSessionInfoJson(opencodeDataDir)
      : 0,
    flowagentsSessionsInProject: hasFlowagentsSessions(projectDir),
    flowagentsSessionsInIsolated: hasFlowagentsSessions(home),
  };
}

/** Extract ACP / SDK error fields for logging without dumping huge stacks. */
export function formatAcpLoadError(err: unknown): Record<string, unknown> {
  if (!err || typeof err !== "object") {
    return { message: String(err) };
  }
  const e = err as Record<string, unknown>;
  const out: Record<string, unknown> = {
    name: e.name,
    message: e.message,
    code: e.code,
  };
  if ("data" in e && e.data !== undefined) out.data = e.data;
  if ("details" in e && e.details !== undefined) out.details = e.details;
  return out;
}

const ENGINE_LOG_TAIL_DEFAULT_MAX_LINES = 80;
const ENGINE_LOG_TAIL_DEFAULT_MAX_BYTES = 64 * 1024;

export interface EngineLogTail {
  path: string;
  exists: boolean;
  /** 文件大于读取上限时只取末尾 */
  truncated: boolean;
  /** 已逐行脱敏 */
  lines: string[];
}

/**
 * 读取引擎日志的末尾若干行。
 *
 * 会话建立卡死时用它把「引擎停在启动的哪一步」带进主日志：主进程日志里只能看到
 * RPC 无响应，看不到引擎内部（creating instance → fromDirectory → bootstrapping …）。
 */
export function readEngineLogTail(
  isolatedHome: string | null | undefined,
  options?: { maxLines?: number; maxBytes?: number },
): EngineLogTail | null {
  if (!isolatedHome) return null;
  const filePath = getOpencodeLogFile(isolatedHome);
  const maxLines = options?.maxLines ?? ENGINE_LOG_TAIL_DEFAULT_MAX_LINES;
  const maxBytes = options?.maxBytes ?? ENGINE_LOG_TAIL_DEFAULT_MAX_BYTES;
  const missing: EngineLogTail = {
    path: filePath,
    exists: false,
    truncated: false,
    lines: [],
  };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return missing;
  }
  if (!stat.isFile()) return null;
  const truncated = stat.size > maxBytes;
  const length = Math.min(stat.size, maxBytes);
  const buffer = Buffer.alloc(length);
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    // 引擎可能正写到一半：读到多少算多少
    const bytesRead = fs.readSync(fd, buffer, 0, length, stat.size - length);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const lines = text
      .split("\n")
      .map((line) => line.replace(/\r$/, ""))
      .filter((line) => line.trim().length > 0);
    // 从中间截断时首行不完整
    if (truncated) lines.shift();
    return {
      path: filePath,
      exists: true,
      truncated,
      lines: lines.slice(-maxLines).map(redactStringForLog),
    };
  } catch {
    return { ...missing, exists: true, truncated };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // 关闭失败不影响已读结果
      }
    }
  }
}
