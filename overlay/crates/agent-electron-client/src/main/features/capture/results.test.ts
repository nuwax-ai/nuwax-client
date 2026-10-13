/**
 * 单元测试: results - 结果仓
 *
 * 覆盖：put 返回不透明 id 且文件以 0600 写入；readChunk 分块读取、末尾截断、
 * EOF 返回空、超过单次上限被截到上限、未知 id 返回 null、非法 offset/length 抛错；
 * release / releaseAll 删除临时目录。
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScratchDir } from "../_kit/scratchDir";
import { createResultStore, MAX_CHUNK_BYTES, type ResultFs } from "./results";
import type { ScratchDir } from "../_kit/scratchDir";

function setup() {
  const files = new Map<string, Buffer>();
  const writes: Array<{ path: string; mode: number }> = [];
  const fs: ResultFs = {
    writeFileSync: (path, data, options) => {
      files.set(path, data);
      writes.push({ path, mode: options.mode });
    },
    openSync: (path) => {
      if (!files.has(path)) throw new Error("ENOENT");
      return [...files.keys()].indexOf(path) + 100;
    },
    readSync: (fd, buffer, offset, length, position) => {
      const data = [...files.values()][fd - 100];
      const slice = data.subarray(position, position + length);
      slice.copy(buffer, offset);
      return slice.length;
    },
    closeSync: vi.fn(),
  };
  const scratch: ScratchDir = {
    root: "/scratch",
    isValidId: () => true,
    create: vi.fn((id: string) => `/scratch/${id}`),
    resolve: vi.fn(),
    remove: vi.fn(),
    sweep: vi.fn(),
  };
  let n = 0;
  const store = createResultStore(scratch, fs, () => `id${String(++n).padStart(8, "0")}`);
  return { store, scratch, fs, writes };
}

describe("createResultStore", () => {
  it("completed recording files are copied privately without exposing paths, and can be saved before release", () => {
    const directory = mkdtempSync(join(tmpdir(), "capture-results-"));
    try {
      const source = join(directory, "completed.webm");
      writeFileSync(source, Buffer.alloc(128 * 1024, 7));
      const scratch = createScratchDir(join(directory, "private"));
      const store = createResultStore(scratch);
      const result = store.putFile(source, "video/webm");
      expect(result.bytes).toBe(128 * 1024);
      expect(Object.keys(result)).toEqual(["resultId", "mime", "bytes"]);
      if (process.platform !== "win32") expect(statSync(join(scratch.resolve(result.resultId)!, "data.bin")).mode & 0o777).toBe(0o600);
      const saved = join(directory, "saved.webm");
      expect(store.copyTo(result.resultId, saved)).toBe(true);
      expect(readFileSync(saved)).toEqual(readFileSync(source));
      store.release(result.resultId);
      expect(store.copyTo(result.resultId, saved)).toBe(false);
      expect(store.readChunk(result.resultId, 0, 1)).toBeNull();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("put：写入 0600 文件，返回 id/mime/bytes，不含路径", () => {
    const { store, writes } = setup();
    const out = store.put(Buffer.from("hello world"), "image/png");
    expect(out).toEqual({ resultId: "id00000001", mime: "image/png", bytes: 11 });
    expect(writes.map((w) => ({ ...w, path: w.path.replace(/\\/g, "/") }))).toEqual([
      { path: "/scratch/id00000001/data.bin", mode: 0o600 },
    ]);
    expect(JSON.stringify(out)).not.toContain("scratch");
  });

  it("readChunk：分块读取，末块被截断，EOF 返回空", () => {
    const { store } = setup();
    const { resultId } = store.put(Buffer.from("0123456789"), "x/y");
    expect(store.readChunk(resultId, 0, 4)!.toString()).toBe("0123");
    expect(store.readChunk(resultId, 4, 4)!.toString()).toBe("4567");
    expect(store.readChunk(resultId, 8, 4)!.toString()).toBe("89");
    expect(store.readChunk(resultId, 10, 4)!.length).toBe(0);
    expect(store.readChunk(resultId, 3, 0)!.length).toBe(0);
  });

  it("readChunk：超过单次上限时被截到上限", () => {
    const { store } = setup();
    const big = Buffer.alloc(MAX_CHUNK_BYTES + 1000, 7);
    const { resultId } = store.put(big, "video/mp4");
    expect(store.readChunk(resultId, 0, MAX_CHUNK_BYTES * 2)!.length).toBe(MAX_CHUNK_BYTES);
  });

  it("readChunk：未知 id 返回 null；非法 offset/length 抛错", () => {
    const { store } = setup();
    expect(store.readChunk("nope0000", 0, 1)).toBeNull();
    const { resultId } = store.put(Buffer.from("abc"), "x/y");
    for (const [o, l] of [[-1, 1], [0, -1], [1.5, 1], [0, 2.5]] as const) {
      expect(() => store.readChunk(resultId, o, l)).toThrow(RangeError);
    }
  });

  it("release：删除目录且之后读取得到 null；重复 release 无副作用", () => {
    const { store, scratch } = setup();
    const { resultId } = store.put(Buffer.from("abc"), "x/y");
    store.release(resultId);
    store.release(resultId);
    expect(scratch.remove).toHaveBeenCalledTimes(1);
    expect(store.readChunk(resultId, 0, 1)).toBeNull();
  });

  it("releaseAll：清理全部结果", () => {
    const { store, scratch } = setup();
    store.put(Buffer.from("a"), "x/y");
    store.put(Buffer.from("b"), "x/y");
    store.releaseAll();
    expect(scratch.remove).toHaveBeenCalledTimes(2);
  });
});
