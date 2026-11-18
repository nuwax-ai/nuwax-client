/**
 * ACP isolated HOME 路径解析与生命周期辅助。
 *
 * Computer 路径：~/.nuwaclaw/run/projects/{userId}/{workDirId}/{engine}/home/
 * 其他：run/acp-{timestamp}-{rand}（可删除）
 */

import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import log from "electron-log";
import { getAppDataDir } from "../../system/appPaths";
import type { AgentEngineType } from "../types";

export type IsolatedHomeScopeKind = "project" | "ephemeral";

export interface IsolatedHomeScope {
  kind: IsolatedHomeScopeKind;
  userId?: string;
  workDirId?: string;
  engine?: AgentEngineType;
}

export const DEFAULT_PROJECT_HOME_RETENTION_DAYS = 7;
/** orphan ephemeral run/acp-* 默认保留天数 */
export const DEFAULT_EPHEMERAL_HOME_RETENTION_DAYS = 1;
/** project home 内可重建缓存（.cache/.npm 等）默认保留天数 */
export const DEFAULT_PROJECT_CACHE_RETENTION_DAYS = 2;
/** project home 内 tmp 默认保留天数（更短，多为 compile-cache） */
export const DEFAULT_PROJECT_TMP_RETENTION_DAYS = 1;
/**
 * `.migrated-<ts>` 备份目录的保留期（一个版本周期）。
 * 迁移只改名、不删数据，回滚靠这些备份；过期后由 prune 回收。
 */
export const DEFAULT_MIGRATED_BACKUP_RETENTION_DAYS = 30;

/** 引擎 home 目录名（`CODEX_HOME`/`CODEX_SQLITE_HOME` 的落点）。 */
export const ENGINE_HOME_DIR_NAME = ".nuwax-harness";
/** 旧引擎 home 目录名，仅用于迁移。 */
export const LEGACY_ENGINE_HOME_DIR_NAME = ".codex";
/** 迁移备份目录后缀（`<legacy>.migrated-<ts>`）。 */
export const MIGRATED_BACKUP_SUFFIX = ".migrated-";

/**
 * 引擎 id → 隔离 home 里的目录段。
 *
 * 与 id 解耦：平台下发的 wire id 仍是 `codex-cli`（以及旧的 `codex`），而磁盘上
 * 统一用 `nuwax-harness`；将来平台改发 `nuwax-harness` 也命中同一目录，不触发
 * 第二次迁移。未登记的 id 仍按原样 sanitize（nuwaxcode / claude-code 等不受影响）。
 */
const ENGINE_HOME_SEGMENTS: Record<string, string> = {
  "codex-cli": "nuwax-harness",
  "nuwax-harness": "nuwax-harness",
};

export function engineHomeSegment(engineId: string): string {
  const mapped = ENGINE_HOME_SEGMENTS[engineId.trim().toLowerCase()];
  return mapped ?? sanitizePathSegment(engineId);
}

const RUN_SEGMENT = "run";
const PROJECTS_SEGMENT = "projects";
const HOME_SEGMENT = "home";
/** project home 下可安全删除的可重建缓存目录名（不含 tmp，tmp 单独用更短 TTL） */
const PROJECT_CACHE_DIR_NAMES = [".cache", ".npm"] as const;
/** 额外可清理的路径（相对 home）；不碰 opencode.db* 与 flowagents */
const PROJECT_CACHE_RELATIVE_PATHS = [
  path.join(".local", "share", "pnpm"),
  path.join(".local", "share", "uv"),
  path.join(".local", "share", "opencode", "log"),
  // OpenCode 插件依赖可重建；保留 package.json，共享安装 + symlink 后应较少再膨胀
  path.join(".config", "opencode", "node_modules"),
] as const;

/** 拒绝路径穿越与分隔符，非法字符替换为下划线 */
export function sanitizePathSegment(segment: string): string {
  const trimmed = segment.trim();
  if (!trimmed) return "_";
  return trimmed
    .replace(/[/\\]/g, "_")
    .replace(/\.\./g, "_")
    .replace(/[^\w.\-@+]/g, "_");
}

/**
 * workDirId 作为目录段的安全形态：绝对路径轨道（web 端工作空间选择）以
 * sha256 前 16 位作段名——sanitize 替换分隔符会让超长路径爆目录段上限，且
 * /a/b 与 /a_b 会 sanitize 成同形（HOME 串目录）；入口已归一化，同一路径
 * hash 稳定。标识符轨道维持 sanitize。
 */
export function scopeWorkDirSegment(workDirId: string): string {
  if (path.isAbsolute(workDirId)) {
    return `wd-${createHash("sha256").update(workDirId).digest("hex").slice(0, 16)}`;
  }
  return sanitizePathSegment(workDirId);
}

export function getRunRoot(): string {
  return path.join(getAppDataDir(), RUN_SEGMENT);
}

export function getProjectIsolatedHomesRoot(): string {
  return path.join(getAppDataDir(), RUN_SEGMENT, PROJECTS_SEGMENT);
}

export function resolveProjectIsolatedHomeDir(
  scope: IsolatedHomeScope,
): string {
  if (scope.kind !== "project") {
    throw new Error(
      `resolveProjectIsolatedHomeDir requires project scope, got ${scope.kind}`,
    );
  }
  const userId = sanitizePathSegment(scope.userId || "_");
  const workDirId = scopeWorkDirSegment(scope.workDirId || "_");
  const engine = engineHomeSegment(scope.engine || "unknown");
  const projectRoot = path.join(getProjectIsolatedHomesRoot(), userId, workDirId);
  // 引擎段改名（codex-cli → nuwax-harness）后，旧段里的会话数据要跟着走。
  migrateEngineSegment(projectRoot, scope.engine || "unknown", engine);
  return path.join(projectRoot, engine, HOME_SEGMENT);
}

/**
 * 迁移引擎段目录：`<projectRoot>/<旧段>` → `<projectRoot>/<新段>`。
 * 未发生改名（旧段与新段同名）或旧段不存在时是空操作。
 */
export function migrateEngineSegment(
  projectRoot: string,
  engineId: string,
  targetSegment: string,
): void {
  const legacies = LEGACY_ENGINE_SEGMENTS[engineId.trim().toLowerCase()] ?? [];
  for (const legacySegment of legacies) {
    if (legacySegment === targetSegment) continue;
    migrateDirectory(
      path.join(projectRoot, legacySegment),
      path.join(projectRoot, targetSegment),
      `engine-segment:${legacySegment}->${targetSegment}`,
    );
  }
}

/** 旧引擎段名（仅 codex-cli 系列有过改名）。 */
const LEGACY_ENGINE_SEGMENTS: Record<string, string[]> = {
  "codex-cli": ["codex-cli"],
  "nuwax-harness": ["codex-cli"],
};

/**
 * 目录迁移：绝不丢数据。
 *
 * - legacy 不存在 → 空操作
 * - target 不存在 → `rename`（同盘原子）
 * - 两者都存在 → 逐项合并（冲突保留 target，legacy 那份改名为 `<name>.from-legacy-<ts>`），
 *   随后把 legacy 整体改名为 `<legacy>.migrated-<ts>`
 * - `rename` 失败（EXDEV/EBUSY/EPERM 等） → 保留 legacy 原样并返回 false，
 *   调用方回退使用旧路径；绝不创建空目录顶替
 *
 * 必须在引擎进程启动前调用（避免 Windows 上的文件占用与 sqlite WAL 句柄）。
 */
export function migrateDirectory(
  legacy: string,
  target: string,
  label: string,
): boolean {
  if (!fs.existsSync(legacy)) return true;
  try {
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(legacy, target);
      writeMigrationMarker(target, { from: path.basename(legacy), mode: "rename", label });
      log.info(`[IsolatedHome] migrated ${label}: ${legacy} → ${target}`);
      return true;
    }
    mergeDirectoryInto(legacy, target, label);
    return true;
  } catch (error) {
    log.error(
      `[IsolatedHome] migration failed for ${label} (${legacy} → ${target}); keeping the legacy path:`,
      error,
    );
    return false;
  }
}

function mergeDirectoryInto(legacy: string, target: string, label: string): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let moved = 0;
  for (const entry of fs.readdirSync(legacy, { withFileTypes: true })) {
    const from = path.join(legacy, entry.name);
    const to = path.join(target, entry.name);
    if (!fs.existsSync(to)) {
      fs.renameSync(from, to);
      moved += 1;
    } else {
      fs.renameSync(from, `${to}.from-legacy-${stamp}`);
      moved += 1;
    }
  }
  const backup = `${legacy}${MIGRATED_BACKUP_SUFFIX}${stamp}`;
  fs.renameSync(legacy, backup);
  writeMigrationMarker(target, { from: path.basename(legacy), mode: "merge", moved, label });
  log.info(
    `[IsolatedHome] merged ${label}: ${legacy} → ${target} (${moved} entries, legacy kept at ${backup})`,
  );
}

function writeMigrationMarker(
  target: string,
  meta: { from: string; mode: string; moved?: number; label: string },
): void {
  try {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(
      path.join(target, ".migration.json"),
      `${JSON.stringify({ ...meta, at: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
  } catch (error) {
    log.warn(`[IsolatedHome] could not write migration marker in ${target}:`, error);
  }
}

/**
 * 解析引擎 home（`CODEX_HOME` 的落点），并把旧的 `.codex` 迁移到 `.nuwax-harness`。
 *
 * 迁移失败时回退旧目录（宁可继续用 `.codex`，也不新建空目录让用户“会话全丢”）。
 */
export function resolveEngineHome(isolatedHome: string): string {
  const target = path.join(isolatedHome, ENGINE_HOME_DIR_NAME);
  const legacy = path.join(isolatedHome, LEGACY_ENGINE_HOME_DIR_NAME);
  if (migrateDirectory(legacy, target, "engine-home")) {
    fs.mkdirSync(target, { recursive: true });
    return target;
  }
  fs.mkdirSync(legacy, { recursive: true });
  return legacy;
}

export function resolveEphemeralIsolatedHomeDir(): string {
  const runId = `acp-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  return path.join(getAppDataDir(), RUN_SEGMENT, runId);
}

export function resolveIsolatedHomePath(scope: IsolatedHomeScope): {
  homeDir: string;
  runId: string;
} {
  switch (scope.kind) {
    case "project": {
      const homeDir = resolveProjectIsolatedHomeDir(scope);
      const workDirId = scopeWorkDirSegment(scope.workDirId || "unknown");
      const engine = sanitizePathSegment(scope.engine || "unknown");
      return {
        homeDir,
        runId: `project-${workDirId}-${engine}`,
      };
    }
    case "ephemeral": {
      const homeDir = resolveEphemeralIsolatedHomeDir();
      return {
        homeDir,
        runId: path.basename(homeDir),
      };
    }
    default: {
      const _exhaustive: never = scope.kind;
      throw new Error(`Unknown isolated home scope: ${_exhaustive}`);
    }
  }
}

/** 是否为应跨进程保留的 project 稳定 HOME */
export function isPersistentIsolatedHome(
  homeDir: string | null | undefined,
): boolean {
  if (!homeDir) return false;
  const normalized = path.normalize(homeDir);
  const projectsRoot = path.normalize(getProjectIsolatedHomesRoot());
  return (
    normalized === projectsRoot ||
    normalized.startsWith(projectsRoot + path.sep)
  );
}

function removeEmptyParentsUpTo(dir: string, stopAt: string): void {
  let current = dir;
  const stop = path.normalize(stopAt);
  while (current.startsWith(stop) && current !== stop) {
    try {
      if (fs.readdirSync(current).length === 0) {
        fs.rmdirSync(current);
        current = path.dirname(current);
      } else {
        break;
      }
    } catch {
      break;
    }
  }
}

function shouldSkipHomeForPrune(
  homeDir: string,
  skipPaths?: Set<string>,
): boolean {
  if (!skipPaths || skipPaths.size === 0) return false;
  const normalized = path.normalize(homeDir);
  for (const skip of skipPaths) {
    const normalizedSkip = path.normalize(skip);
    if (
      normalized === normalizedSkip ||
      normalized.startsWith(normalizedSkip + path.sep) ||
      normalizedSkip.startsWith(normalized + path.sep)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 清理 mtime 超过 maxAgeDays 的 project isolated home。
 * 扫描 run/projects 下各层 home 目录，跳过活跃引擎路径。
 */
export function pruneStaleProjectIsolatedHomes(
  maxAgeDays = DEFAULT_PROJECT_HOME_RETENTION_DAYS,
  options?: { skipPaths?: Set<string> },
): number {
  const projectsRoot = getProjectIsolatedHomesRoot();
  if (!fs.existsSync(projectsRoot)) return 0;

  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let deleted = 0;

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(dir, entry.name);

      if (entry.name === HOME_SEGMENT) {
        const parentEngineDir = path.dirname(fullPath);
        if (shouldSkipHomeForPrune(fullPath, options?.skipPaths)) {
          continue;
        }
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(fullPath).mtimeMs;
        } catch {
          continue;
        }
        if (now - mtimeMs <= maxAgeMs) continue;

        try {
          fs.rmSync(parentEngineDir, { recursive: true, force: true });
          deleted++;
          log.info(
            `[IsolatedHome] Pruned stale project home (>${maxAgeDays}d): ${fullPath}`,
          );
          removeEmptyParentsUpTo(path.dirname(parentEngineDir), projectsRoot);
        } catch (err) {
          log.warn(`[IsolatedHome] Prune failed for ${fullPath}:`, err);
        }
        continue;
      }

      walk(fullPath);
    }
  };

  walk(projectsRoot);

  if (deleted > 0) {
    log.info(
      `[IsolatedHome] Prune complete: deleted ${deleted} stale engine home(s)`,
    );
  }
  return deleted;
}

/**
 * 清理 mtime 超过 maxAgeDays 的 orphan ephemeral 目录（run/acp-*）。
 * 不碰 run/projects/；跳过活跃引擎路径。
 */
export function pruneOrphanEphemeralIsolatedHomes(
  maxAgeDays = DEFAULT_EPHEMERAL_HOME_RETENTION_DAYS,
  options?: { skipPaths?: Set<string> },
): number {
  const runRoot = getRunRoot();
  if (!fs.existsSync(runRoot)) return 0;

  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let deleted = 0;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(runRoot, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // 仅 GC 临时 run：acp-{timestamp}-{rand}
    if (!entry.name.startsWith("acp-")) continue;

    const fullPath = path.join(runRoot, entry.name);
    if (shouldSkipHomeForPrune(fullPath, options?.skipPaths)) {
      continue;
    }

    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(fullPath).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtimeMs <= maxAgeMs) continue;

    try {
      fs.rmSync(fullPath, { recursive: true, force: true });
      deleted++;
      log.info(
        `[IsolatedHome] Pruned orphan ephemeral home (>${maxAgeDays}d): ${fullPath}`,
      );
    } catch (err) {
      log.warn(`[IsolatedHome] Ephemeral prune failed for ${fullPath}:`, err);
    }
  }

  if (deleted > 0) {
    log.info(
      `[IsolatedHome] Ephemeral prune complete: deleted ${deleted} orphan dir(s)`,
    );
  }
  return deleted;
}

function tryPruneCachePath(
  cachePath: string,
  maxAgeMs: number,
  now: number,
  maxAgeDays: number,
): boolean {
  let mtimeMs = 0;
  try {
    if (!fs.existsSync(cachePath)) return false;
    mtimeMs = fs.statSync(cachePath).mtimeMs;
  } catch {
    return false;
  }
  if (now - mtimeMs <= maxAgeMs) return false;

  try {
    fs.rmSync(cachePath, { recursive: true, force: true });
    log.info(
      `[IsolatedHome] Pruned project cache (>${maxAgeDays}d): ${cachePath}`,
    );
    return true;
  } catch (err) {
    log.warn(
      `[IsolatedHome] Project cache prune failed for ${cachePath}:`,
      err,
    );
    return false;
  }
}

/**
 * 清理 project home 内可重建缓存。
 * - .cache / .npm / .local/share/{pnpm,uv} / opencode/log：默认 maxAgeDays
 * - tmp：默认更短 TTL（tmpMaxAgeDays）
 * 保留 .claude、.nuwaxcode、.flowagents、.config、opencode.db* 等会话数据。
 */
export function pruneProjectIsolatedHomeCaches(
  maxAgeDays = DEFAULT_PROJECT_CACHE_RETENTION_DAYS,
  options?: {
    skipPaths?: Set<string>;
    tmpMaxAgeDays?: number;
    /** 迁移备份（`.migrated-*`）的保留天数，默认一个版本周期。 */
    migratedMaxAgeDays?: number;
    /** 覆盖扫描根（测试用）；默认 `run/projects`。 */
    root?: string;
  },
): number {
  const projectsRoot = options?.root ?? getProjectIsolatedHomesRoot();
  if (!fs.existsSync(projectsRoot)) return 0;

  const tmpMaxAgeDays =
    options?.tmpMaxAgeDays ?? DEFAULT_PROJECT_TMP_RETENTION_DAYS;
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const tmpMaxAgeMs = tmpMaxAgeDays * 24 * 60 * 60 * 1000;
  // 迁移备份只用于回滚，超过保留期即回收，避免每次目录改名永久占一份空间。
  const migratedMaxAgeDays =
    options?.migratedMaxAgeDays ?? DEFAULT_MIGRATED_BACKUP_RETENTION_DAYS;
  const migratedMaxAgeMs = migratedMaxAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let deleted = 0;

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(dir, entry.name);

      // 迁移备份（<name>.migrated-<ts>）只用于回滚，超过保留期即回收。
      if (entry.name.includes(MIGRATED_BACKUP_SUFFIX)) {
        if (
          tryPruneCachePath(
            fullPath,
            migratedMaxAgeMs,
            now,
            migratedMaxAgeDays,
          )
        ) {
          deleted++;
        }
        continue;
      }

      if (entry.name === HOME_SEGMENT) {
        if (shouldSkipHomeForPrune(fullPath, options?.skipPaths)) {
          continue;
        }

        for (const name of PROJECT_CACHE_DIR_NAMES) {
          if (
            tryPruneCachePath(
              path.join(fullPath, name),
              maxAgeMs,
              now,
              maxAgeDays,
            )
          ) {
            deleted++;
          }
        }
        // tmp 使用更短 TTL：多为 node-compile-cache / tsx 等可重建内容
        if (
          tryPruneCachePath(
            path.join(fullPath, "tmp"),
            tmpMaxAgeMs,
            now,
            tmpMaxAgeDays,
          )
        ) {
          deleted++;
        }
        for (const rel of PROJECT_CACHE_RELATIVE_PATHS) {
          if (
            tryPruneCachePath(
              path.join(fullPath, rel),
              maxAgeMs,
              now,
              maxAgeDays,
            )
          ) {
            deleted++;
          }
        }
        continue;
      }

      walk(fullPath);
    }
  };

  walk(projectsRoot);

  if (deleted > 0) {
    log.info(
      `[IsolatedHome] Project cache prune complete: deleted ${deleted} cache dir(s)`,
    );
  }
  return deleted;
}
