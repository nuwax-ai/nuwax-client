/**
 * 特性专属临时目录。
 *
 * - 目录名即不透明 id，严格白名单校验，杜绝路径穿越；
 * - 目录权限 0700；`sweep(ttlMs)` 清掉超时的子目录（启动时调用，兜底崩溃遗留）。
 * 文件系统与时钟可注入，便于单测。
 */

import * as nodeFs from "node:fs";
import * as nodePath from "node:path";

/** 不透明 id：只允许字母数字、下划线、连字符，长度 8-64。 */
const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/;

export interface ScratchFs {
  mkdirSync(path: string, options: { recursive: true; mode: number }): unknown;
  readdirSync(path: string): string[];
  statSync(path: string): { mtimeMs: number; isDirectory(): boolean };
  rmSync(path: string, options: { recursive: true; force: true }): void;
  existsSync(path: string): boolean;
}

export interface ScratchDir {
  readonly root: string;
  isValidId(id: string): boolean;
  /** 创建并返回子目录路径；id 非法抛错。 */
  create(id: string): string;
  /** 返回已有子目录路径，不存在或 id 非法返回 null。 */
  resolve(id: string): string | null;
  remove(id: string): void;
  /** 清理 mtime 早于 `now - ttlMs` 的子目录，返回清理数量。 */
  sweep(ttlMs: number): number;
}

export function createScratchDir(
  root: string,
  fs: ScratchFs = nodeFs,
  now: () => number = Date.now,
): ScratchDir {
  const childPath = (id: string) => nodePath.join(root, id);

  return {
    root,
    isValidId: (id) => SAFE_ID.test(id),
    create(id) {
      if (!SAFE_ID.test(id)) throw new Error("invalid scratch id");
      const dir = childPath(id);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      return dir;
    },
    resolve(id) {
      if (!SAFE_ID.test(id)) return null;
      const dir = childPath(id);
      return fs.existsSync(dir) ? dir : null;
    },
    remove(id) {
      if (!SAFE_ID.test(id)) return;
      fs.rmSync(childPath(id), { recursive: true, force: true });
    },
    sweep(ttlMs) {
      if (!fs.existsSync(root)) return 0;
      let removed = 0;
      const cutoff = now() - ttlMs;
      for (const name of fs.readdirSync(root)) {
        if (!SAFE_ID.test(name)) continue;
        const dir = childPath(name);
        try {
          const stat = fs.statSync(dir);
          if (stat.isDirectory() && stat.mtimeMs < cutoff) {
            fs.rmSync(dir, { recursive: true, force: true });
            removed++;
          }
        } catch {
          // 目录在扫描期间被删除/不可访问：跳过，不影响其他目录
        }
      }
      return removed;
    },
  };
}
