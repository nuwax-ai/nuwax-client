/**
 * 收集各引擎 home 下的引擎日志，供「导出日志」一并打包。
 *
 * nuwaxcode 1.17.11 不读 OPENCODE_LOG_DIR，日志固定写在每个会话自己的 isolated home
 * 里（<home>/.local/share/opencode/log/opencode.log），不在 <appData>/logs 下，
 * 所以原有的日志导出带不上它——而会话建立卡死时最需要看的正是这一份。
 * 隔离出来的 home（home.quarantine-<ts>）里的日志同样收集。
 */

import * as fs from "fs";
import * as path from "path";
import { getOpencodeLogFile, getProjectIsolatedHomesRoot } from "./isolatedHomePaths";

/** 单个引擎日志最多打包的末尾字节数 */
export const ENGINE_LOG_EXPORT_TAIL_BYTES = 256 * 1024;
/** 最多打包的引擎日志份数（按最近修改取） */
export const ENGINE_LOG_EXPORT_MAX_FILES = 50;

const HOME_SEGMENT = "home";

export interface EngineLogFile {
  source: string;
  /** ZIP 内路径：engine-logs/<user>/<workDir>/<engine>[/home.quarantine-…]/opencode.log */
  archiveName: string;
  mtimeMs: number;
}

export function collectEngineLogFiles(options?: {
  projectsRoot?: string;
  limit?: number;
}): EngineLogFile[] {
  const projectsRoot =
    options?.projectsRoot ?? getProjectIsolatedHomesRoot();
  const limit = options?.limit ?? ENGINE_LOG_EXPORT_MAX_FILES;
  const found: EngineLogFile[] = [];

  // run/projects/<user>/<workDir>/<engine>/<home 或 home.quarantine-…> 下的 opencode.log
  const visitEngineDir = (engineDir: string, prefix: string[]): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(engineDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // 只认 home 与它的隔离备份；迁移备份（.migrated-）结构不同，不在这里展开
      if (entry.name !== HOME_SEGMENT && !entry.name.startsWith(`${HOME_SEGMENT}.`)) {
        continue;
      }
      const logPath = getOpencodeLogFile(path.join(engineDir, entry.name));
      let stats: fs.Stats;
      try {
        stats = fs.statSync(logPath);
      } catch {
        continue;
      }
      if (!stats.isFile() || stats.size === 0) continue;
      found.push({
        source: logPath,
        archiveName: ["engine-logs", ...prefix, entry.name, "opencode.log"].join("/"),
        mtimeMs: stats.mtimeMs,
      });
    }
  };

  const visit = (dir: string, depth: number, prefix: string[]): void => {
    if (depth > 2) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      const nextPrefix = [...prefix, entry.name];
      if (depth === 2) visitEngineDir(full, nextPrefix);
      else visit(full, depth + 1, nextPrefix);
    }
  };

  visit(projectsRoot, 0, []);
  // 最近的优先，超出上限的旧日志不打包
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found.slice(0, Math.max(0, limit));
}
