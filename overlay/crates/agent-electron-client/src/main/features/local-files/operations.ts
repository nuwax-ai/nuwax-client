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
import archiver from "archiver";
import { LocalFilesFailure } from "./files";

export interface FileOperation {
  controller: AbortController;
  valid(): boolean;
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

/** Stream every filesystem entry; symlinks are entries, hardlinks are regular files. */
export async function exportWorkspaceAtomic(
  root: string,
  destination: string,
  operation: FileOperation
): Promise<void> {
  check(operation);
  const temporary = temporaryPath(destination);
  const excluded = new Set([path.resolve(destination), temporary]);
  const archive = archiver("zip", { zlib: { level: 6 } });
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
      if (info.isSymbolicLink())
        archive.symlink(name, await readlink(absolute), info.mode);
      else if (info.isDirectory()) await visit(absolute, name);
      else if (info.isFile())
        archive.file(absolute, { name, mode: info.mode, date: info.mtime });
      // Sockets/FIFOs/device nodes are not readable files and have no ZIP representation.
    }
  };
  try {
    await visit(root, top);
    check(operation);
    await Promise.all([archive.finalize(), completion]);
    check(operation);
    await rename(temporary, destination);
  } catch (error) {
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
