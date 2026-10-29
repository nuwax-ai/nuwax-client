import path from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import {
  lstat,
  opendir,
  readlink,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { ZipArchive } from "archiver";
import { LocalFilesFailure } from "./files";

export interface FileOperation {
  controller: AbortController;
  valid(): boolean;
}

/**
 * 导出过程的可观测回调（宿主注入，纯函数不依赖 electron-log）。
 * detail 只含路径与计数/字节统计，不含文件内容。
 */
export type ExportObserver = (
  event: "start" | "done" | "failed",
  detail: Record<string, unknown>,
) => void;

/** 目录/文件/符号链接计数与原始字节，用于判断压缩是否真的发生。 */
interface ExportStats {
  directories: number;
  files: number;
  symlinks: number;
  bytes: number;
}

function check(operation: FileOperation): void {
  operation.controller.signal.throwIfAborted();
  if (!operation.valid()) throw new LocalFilesFailure("expired");
}

function temporaryPath(destination: string): string {
  return path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.nuwax-${randomUUID()}.tmp`
  );
}

/** Do not overwrite the original, including aliases and hard links. */
export async function assertDifferentFile(
  source: string,
  destination: string
): Promise<void> {
  if (path.resolve(source) === path.resolve(destination))
    throw new LocalFilesFailure("invalid-argument");
  try {
    const [left, right] = await Promise.all([
      lstat(source),
      lstat(destination),
    ]);
    if (
      (left.dev === right.dev && left.ino === right.ino) ||
      (await realpath(source)) === (await realpath(destination))
    ) {
      throw new LocalFilesFailure("invalid-argument");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function copyFileAtomic(
  source: string,
  destination: string,
  operation: FileOperation
): Promise<void> {
  check(operation);
  await assertDifferentFile(source, destination);
  const temporary = temporaryPath(destination);
  try {
    await pipeline(
      createReadStream(source),
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      { signal: operation.controller.signal }
    );
    check(operation);
    await assertDifferentFile(source, destination);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Stream every filesystem entry; symlinks are entries, hardlinks are regular files.
 */
export async function exportWorkspaceAtomic(
  root: string,
  destination: string,
  operation: FileOperation,
  observe?: ExportObserver,
): Promise<void> {
  check(operation);
  observe?.("start", { root, destination });
  const stats: ExportStats = { directories: 0, files: 0, symlinks: 0, bytes: 0 };
  // Resolve directory aliases on both sides before excluding our own output.
  // Preserve the final basename: replacing a destination symlink must not
  // overwrite the file it points to.
  const [canonicalRoot, destinationParent] = await Promise.all([
    realpath(root),
    realpath(path.dirname(destination)),
  ]);
  root = canonicalRoot;
  destination = path.join(destinationParent, path.basename(destination));
  check(operation);
  const temporary = temporaryPath(destination);
  const excluded = new Set([path.resolve(destination), temporary]);
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
  const completion = pipeline(archive, output, {
    signal: operation.controller.signal,
  });
  // A write failure can precede completion of directory traversal.
  void completion.catch(() => undefined);
  archive.on("warning", (error: Error) => archive.destroy(error));
  const abort = () => {
    archive.abort();
    archive.destroy(new DOMException("Aborted", "AbortError"));
  };
  operation.controller.signal.addEventListener("abort", abort, { once: true });
  const top = path.basename(root) || "workspace";
  const visit = async (directory: string, relative: string): Promise<void> => {
    check(operation);
    const dirInfo = await lstat(directory);
    stats.directories += 1;
    archive.append(Buffer.alloc(0), {
      name: `${relative}/`,
      mode: dirInfo.mode,
      date: dirInfo.mtime,
    });
    const entries = await opendir(directory);
    for await (const entry of entries) {
      check(operation);
      const absolute = path.join(directory, entry.name);
      if (excluded.has(absolute)) continue;
      const name = `${relative}/${entry.name}`;
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        stats.symlinks += 1;
        archive.symlink(name, await readlink(absolute), info.mode);
      } else if (info.isDirectory()) await visit(absolute, name);
      else if (info.isFile()) {
        stats.files += 1;
        stats.bytes += info.size;
        archive.file(absolute, { name, mode: info.mode, date: info.mtime });
      }
      // Sockets/FIFOs/device nodes are not readable files and have no ZIP representation.
    }
  };
  try {
    await visit(root, top);
    check(operation);
    await Promise.all([archive.finalize(), completion]);
    check(operation);
    await rename(temporary, destination);
    // 产物字节与原始字节的比值直接反映 archiver 的 zlib 压缩是否生效：
    // store 模式下两者几乎相等，压缩模式下产物应显著更小。
    observe?.("done", {
      destination,
      ...stats,
      archiveBytes: (await lstat(destination)).size,
    });
  } catch (error) {
    observe?.("failed", {
      destination,
      ...stats,
      reason: error instanceof Error ? error.message : String(error),
    });
    archive.destroy(
      error instanceof Error ? error : new Error("Archive failed")
    );
    output.destroy();
    await completion.catch(() => undefined);
    throw error;
  } finally {
    operation.controller.signal.removeEventListener("abort", abort);
    await rm(temporary, { force: true });
  }
}
