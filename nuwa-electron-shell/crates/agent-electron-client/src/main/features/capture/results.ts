/**
 * 结果仓：把编码好的截图/视频落在特性临时目录里，对渲染进程只暴露不透明的 resultId。
 *
 * - 文件 0600，目录 0700（由 ScratchDir 创建）；渲染进程拿不到路径；
 * - `readChunk` 有单次上限，offset/length 做整数与范围校验，未知 id 返回 null；
 * - `release` 立即删除；`releaseAll` 用于取消/登出/退出。
 */

import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { randomBytes } from "node:crypto";
import type { ScratchDir } from "../_kit/scratchDir";

/** 单次 `readChunk` 最大字节数。 */
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024;

export interface ResultFs {
  writeFileSync(path: string, data: Buffer, options: { mode: number }): void;
  openSync(path: string, flags: "r"): number;
  readSync(
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): number;
  closeSync(fd: number): void;
  copyFileSync?(source: string, destination: string): void;
  chmodSync?(path: string, mode: number): void;
  statSync?(path: string): { size: number };
}

export interface StoredResult {
  resultId: string;
  mime: string;
  bytes: number;
}

export interface ResultStore {
  put(data: Buffer, mime: string): StoredResult;
  /** 主进程完成文件移入结果仓，避免大视频读入整个 Buffer。 */
  putFile(sourcePath: string, mime: string): StoredResult;
  copyTo(resultId: string, destination: string): boolean;
  /** 未知 id 返回 null；到达文件末尾返回空 Buffer。 */
  readChunk(resultId: string, offset: number, length: number): Buffer | null;
  release(resultId: string): void;
  releaseAll(): void;
}

export function createResultStore(
  scratch: ScratchDir,
  fs: ResultFs = nodeFs,
  newId: () => string = () => randomBytes(16).toString("hex"),
): ResultStore {
  const results = new Map<string, { path: string; bytes: number; mime: string }>();

  return {
    put(data, mime) {
      const resultId = newId();
      const dir = scratch.create(resultId);
      const path = nodePath.join(dir, "data.bin");
      fs.writeFileSync(path, data, { mode: 0o600 });
      results.set(resultId, { path, bytes: data.length, mime });
      return { resultId, mime, bytes: data.length };
    },

    putFile(sourcePath, mime) {
      if (!fs.copyFileSync || !fs.statSync || !fs.chmodSync) {
        throw new Error("result store file transfer is not available");
      }
      const resultId = newId();
      const dir = scratch.create(resultId);
      const path = nodePath.join(dir, "data.bin");
      try {
        fs.copyFileSync(sourcePath, path);
        fs.chmodSync(path, 0o600);
        const bytes = fs.statSync(path).size;
        if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("empty capture output");
        results.set(resultId, { path, bytes, mime });
        return { resultId, mime, bytes };
      } catch (error) {
        scratch.remove(resultId);
        throw error;
      }
    },

    copyTo(resultId, destination) {
      const entry = results.get(resultId);
      if (!entry) return false;
      if (!fs.copyFileSync) throw new Error("result store file transfer is not available");
      fs.copyFileSync(entry.path, destination);
      return true;
    },

    readChunk(resultId, offset, length) {
      const entry = results.get(resultId);
      if (!entry) return null;
      if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0) {
        throw new RangeError("offset and length must be non-negative integers");
      }
      if (offset >= entry.bytes || length === 0) return Buffer.alloc(0);
      const size = Math.min(length, MAX_CHUNK_BYTES, entry.bytes - offset);
      const buffer = Buffer.alloc(size);
      const fd = fs.openSync(entry.path, "r");
      try {
        const read = fs.readSync(fd, buffer, 0, size, offset);
        return read === size ? buffer : buffer.subarray(0, read);
      } finally {
        fs.closeSync(fd);
      }
    },

    release(resultId) {
      if (!results.delete(resultId)) return;
      scratch.remove(resultId);
    },

    releaseAll() {
      for (const resultId of [...results.keys()]) {
        results.delete(resultId);
        scratch.remove(resultId);
      }
    },
  };
}
