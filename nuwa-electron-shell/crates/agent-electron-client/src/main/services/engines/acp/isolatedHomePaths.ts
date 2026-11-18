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
  const desiredEngine = engineHomeSegment(scope.engine || "unknown");
  const projectRoot = path.join(getProjectIsolatedHomesRoot(), userId, workDirId);
  // 引擎段改名（codex-cli → nuwax-harness）后，旧段里的会话数据要跟着走；
  // 万一迁移/建链接失败会回滚，这里以返回的实际段名为准。
  const engine = migrateEngineSegment(
    projectRoot,
    scope.engine || "unknown",
    desiredEngine,
  );
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
): string {
  const legacies = LEGACY_ENGINE_SEGMENTS[engineId.trim().toLowerCase()] ?? [];
  let effectiveSegment = targetSegment;
  for (const legacySegment of legacies) {
    if (legacySegment === targetSegment) continue;
    const legacyPath = path.join(projectRoot, legacySegment);
    const targetPath = path.join(projectRoot, targetSegment);
    if (
      migrateDirectory(legacyPath, targetPath, `engine-segment:${legacySegment}->${targetSegment}`, {
        marker: false,
      })
    ) {
      // 旧段同样留链接：外部（平台/旧客户端）若仍按 codex-cli 找路径也不会断；
      // 建不了链接就回滚段改名，避免引擎按旧绝对路径（含旧段名）找不到数据。
      if (!linkLegacyPath(legacyPath, targetPath)) {
        if (revertDirectoryRename(targetPath, legacyPath)) {
          log.error(
            `[IsolatedHome] could not create the segment link; reverted ${targetSegment} → ${legacySegment} to keep recorded paths valid`,
          );
          effectiveSegment = legacySegment;
        }
      }
    }
  }
  return effectiveSegment;
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
  options?: { marker?: boolean },
): boolean {
  if (!fs.existsSync(legacy)) return true;
  // 迁移后会留一个「旧路径 → 新路径」的符号链接做兼容（引擎的 state DB 里存的是
  // 绝对路径，改名后按旧路径找不到 rollout）。再跑一次必须识别这种情况，否则会
  // 通过链接把目标目录自己合并一遍。
  if (isSymlinkTo(legacy, target)) return true;
  try {
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(legacy, target);
      if (options?.marker !== false) {
        writeMigrationMarker(target, {
          from: path.basename(legacy),
          mode: "rename",
          label,
        });
      }
      log.info(`[IsolatedHome] migrated ${label}: ${legacy} → ${target}`);
      return true;
    }
    // 目标已存在：逐项合并。单个条目失败不中断整体——其余内容照样迁入，
    // 失败条目留在旧目录里，随后连旧目录一起作为备份保留，绝不丢数据。
    mergeDirectoryInto(legacy, target, label, options?.marker !== false);
    return true;
  } catch (error) {
    log.error(
      `[IsolatedHome] migration failed for ${label} (${legacy} → ${target}); keeping the legacy path:`,
      error,
    );
    return false;
  }
}

function mergeDirectoryInto(
  legacy: string,
  target: string,
  label: string,
  writeMarker: boolean,
): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let moved = 0;
  let failed = 0;
  for (const entry of fs.readdirSync(legacy, { withFileTypes: true })) {
    const from = path.join(legacy, entry.name);
    const to = path.join(target, entry.name);
    try {
      if (!fs.existsSync(to)) {
        fs.renameSync(from, to);
        moved += 1;
      } else if (entry.isDirectory() && fs.statSync(to).isDirectory()) {
        // 两边都是目录（sessions/ skills/ 等）：递归合并，保留双方内容，
        // 而不是把旧的整个改名到旁边——那样旧会话会“看不见”。
        mergeDirectoryInto(from, to, `${label}/${entry.name}`, /*writeMarker*/ false);
        fs.rmdirSync(from);
        moved += 1;
      } else {
        // 同名文件/类型冲突：保留 target 的那份，旧的改名留档。
        fs.renameSync(from, `${to}.from-legacy-${stamp}`);
        moved += 1;
      }
    } catch (error) {
      failed += 1;
      log.warn(
        `[IsolatedHome] could not merge ${from} → ${to}; it stays in the legacy directory:`,
        error,
      );
    }
  }
  const backup = `${legacy}${MIGRATED_BACKUP_SUFFIX}${stamp}`;
  try {
    fs.renameSync(legacy, backup);
  } catch (error) {
    log.warn(
      `[IsolatedHome] could not set aside the merged legacy directory ${legacy}:`,
      error,
    );
  }
  if (writeMarker) {
    writeMigrationMarker(target, {
      from: path.basename(legacy),
      mode: "merge",
      moved,
      failed,
      label,
    });
  }
  log.info(
    `[IsolatedHome] merged ${label}: ${legacy} → ${target} (${moved} entries, ${failed} failed, legacy kept at ${backup})`,
  );
}

function writeMigrationMarker(
  target: string,
  meta: { from: string; mode: string; moved?: number; failed?: number; label: string },
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

/** `legacy` 是否是指向 `target` 的符号链接（迁移完成的兼容态）。 */
function isSymlinkTo(legacy: string, target: string): boolean {
  try {
    if (!fs.lstatSync(legacy).isSymbolicLink()) return false;
    return path.resolve(fs.realpathSync(legacy)) === path.resolve(fs.realpathSync(target));
  } catch {
    return false;
  }
}

/**
 * 在旧路径留下指向新路径的符号链接。
 *
 * 为什么需要：引擎的 `state_*.sqlite` 里存的是 **rollout 的绝对路径**，目录改名后
 * 这些行变成 stale，`thread/resume` 会报 `thread not found`（日志里是
 * `state db returned stale rollout path`）——旧会话就打不开了。链接让旧绝对路径
 * 继续可解析，引擎无需改库；新会话写入新路径。
 *
 * 失败（无权限/文件系统不支持）不影响主流程，仅记录。
 */
export function symlinkTypeForPlatform(platform: string): "dir" | "junction" {
  // Windows 建目录符号链接需要 SeCreateSymbolicLinkPrivilege（管理员或开发者模式），
  // 普通用户会 EPERM；**junction 不需要任何特权**，且对 Node 的 lstat/realpath
  // 表现为链接。POSIX 用普通目录符号链接。
  return platform === "win32" ? "junction" : "dir";
}

function linkLegacyPath(legacy: string, target: string): boolean {
  if (fs.existsSync(legacy)) return true;
  try {
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.symlinkSync(target, legacy, symlinkTypeForPlatform(process.platform));
    log.info(`[IsolatedHome] linked legacy path ${legacy} → ${target}`);
    return true;
  } catch (error) {
    log.warn(`[IsolatedHome] could not link legacy path ${legacy} → ${target}:`, error);
    return false;
  }
}

/**
 * 把已改名的目录改回去（回滚）。
 *
 * 建不了兼容链接时，宁可保留旧目录名继续跑：引擎 state DB 里的绝对路径仍然有效，
 * 旧会话照常可读；反之若强留新名字，旧会话会全部打不开。
 */
export function revertDirectoryRename(target: string, legacy: string): boolean {
  try {
    if (!fs.existsSync(target) || fs.existsSync(legacy)) return false;
    fs.renameSync(target, legacy);
    return true;
  } catch (error) {
    log.error(`[IsolatedHome] could not revert ${target} → ${legacy}:`, error);
    return false;
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
    // 兼容引擎 state DB 里的旧绝对路径（见 linkLegacyPath 说明）：
    // 建不了链接就回滚目录名，保证旧会话仍可读。
    if (!linkLegacyPath(legacy, target) && revertDirectoryRename(target, legacy)) {
      log.error(
        `[IsolatedHome] could not create the compatibility link; engine home reverted to ${legacy} so recorded session paths stay valid`,
      );
      fs.mkdirSync(legacy, { recursive: true });
      return legacy;
    }
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
  options?: { skipPaths?: Set<string>; root?: string },
): number {
  const projectsRoot = options?.root ?? getProjectIsolatedHomesRoot();
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

      // 迁移备份（`<name>.migrated-<ts>`）交给 pruneProjectIsolatedHomeCaches
      // 按迁移保留期（默认 30 天）回收；这里若继续往下走，备份里的 `home/`
      // 会被 7 天的 home 清理提前删掉，回滚窗口就没了。
      if (entry.name.includes(MIGRATED_BACKUP_SUFFIX)) continue;

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
