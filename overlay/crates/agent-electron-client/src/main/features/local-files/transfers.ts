import os from "node:os";
import path from "node:path";
import { createReadStream, createWriteStream, openAsBlob } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import AdmZip from "adm-zip";
import type { LocalFileTransferInput } from "@shared/features/local-files/contract";
import { LocalFilesFailure } from "./files";
import type { FileOperation } from "./operations";

export const TRANSFER_CHUNK_BYTES = 1024 * 1024;
const MAX_TRANSFER_FILES = 10000;

/** Only relative entry paths cross this boundary; the working root comes from the native context. */
function safeTransferPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[<>:"|?*\x00-\x1f]/.test(part) ||
          /[. ]$/.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      )
  )
    throw new LocalFilesFailure("invalid-argument");
  return value;
}

async function checkUploadDestinations(
  root: string,
  names: string[]
): Promise<void> {
  if ((await realpath(root)) !== root) throw new LocalFilesFailure("expired");
  for (const name of names) {
    let current = root;
    const parts = name.split("/");
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink())
          throw new LocalFilesFailure("permission-denied");
        if (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())
          throw new LocalFilesFailure("already-exists");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }
  }
}

function checkProjectArchive(file: string): void {
  const entries = new AdmZip(file).getEntries();
  if (!entries.length || entries.length > MAX_TRANSFER_FILES)
    throw new LocalFilesFailure("invalid-argument");
  const files = new Set<string>();
  const all = new Set<string>();
  let expanded = 0;
  for (const entry of entries) {
    const name = safeTransferPath(entry.entryName.replace(/\/$/, ""));
    const key = name.toLowerCase();
    if (all.has(key)) throw new LocalFilesFailure("invalid-argument");
    all.add(key);
    if (!entry.isDirectory) files.add(key);
    expanded += entry.header.size;
    if (
      !Number.isSafeInteger(expanded) ||
      expanded > 1024 * 1024 * 1024 ||
      entry.header.size > 256 * 1024 * 1024
    )
      throw new LocalFilesFailure("invalid-argument");
    // Reject links and device entries on every platform, including Windows-produced ZIPs.
    const kind = (entry.attr >>> 16) & 0o170000;
    if (kind && kind !== 0o100000 && kind !== 0o040000)
      throw new LocalFilesFailure("permission-denied");
  }
  for (const name of all) {
    const parts = name.split("/");
    while (parts.pop() && parts.length)
      if (files.has(parts.join("/")))
        throw new LocalFilesFailure("invalid-argument");
  }
}

export class LocalFileTransfer {
  private readonly offsets: number[];
  private queue: Promise<unknown> = Promise.resolve();
  private committing = false;
  private cleaned?: Promise<void>;
  private readonly onAbort = () => {
    void this.dispose().catch(() => undefined);
  };

  private constructor(
    private readonly directory: string,
    readonly input: LocalFileTransferInput,
    private readonly operation: FileOperation
  ) {
    this.offsets = input.files.map(() => 0);
    operation.controller.signal.addEventListener("abort", this.onAbort, {
      once: true,
    });
  }

  static async create(
    input: LocalFileTransferInput,
    operation: FileOperation
  ): Promise<LocalFileTransfer> {
    if (
      !input ||
      !["files", "project"].includes(input.kind) ||
      !Array.isArray(input.files) ||
      !input.files.length ||
      input.files.length > MAX_TRANSFER_FILES ||
      (input.kind === "project" &&
        (input.files.length !== 1 || !/\.zip$/i.test(input.files[0]?.path)))
    )
      throw new LocalFilesFailure("invalid-argument");
    const files = input.files.map((file) => ({
      path: safeTransferPath(file?.path),
      size: file?.size,
    }));
    const names = new Set(files.map((file) => file.path.toLowerCase()));
    if (
      names.size !== files.length ||
      files.some((file) =>
        file.path
          .split("/")
          .slice(0, -1)
          .some((_part, index, parts) =>
            names.has(
              parts
                .slice(0, index + 1)
                .join("/")
                .toLowerCase()
            )
          )
      )
    )
      throw new LocalFilesFailure("invalid-argument");
    if (
      files.some((file) => !Number.isSafeInteger(file.size) || file.size < 0) ||
      new Set(files.map((file) => file.path)).size !== files.length
    )
      throw new LocalFilesFailure("invalid-argument");
    const transfer = new LocalFileTransfer(
      await mkdtemp(path.join(os.tmpdir(), "nuwax-file-transfer-")),
      { kind: input.kind, files },
      operation
    );
    try {
      transfer.check();
      // Empty files still need a real body part at commit time.
      for (let index = 0; index < files.length; index++) {
        transfer.check();
        const file = await open(transfer.file(index), "wx", 0o600);
        await file.close();
      }
      transfer.check();
      return transfer;
    } catch (error) {
      await transfer.dispose();
      throw error;
    }
  }

  private check(): void {
    this.operation.controller.signal.throwIfAborted();
    if (!this.operation.valid()) throw new LocalFilesFailure("expired");
  }
  private file(index: number): string {
    return path.join(this.directory, String(index));
  }

  write(index: number, offset: number, bytes: Uint8Array): Promise<void> {
    if (
      this.committing ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= this.input.files.length ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !(bytes instanceof Uint8Array) ||
      !bytes.byteLength ||
      bytes.byteLength > TRANSFER_CHUNK_BYTES
    )
      return Promise.reject(new LocalFilesFailure("invalid-argument"));
    const work = this.queue.then(async () => {
      this.check();
      if (
        offset !== this.offsets[index] ||
        offset + bytes.byteLength > this.input.files[index].size
      )
        throw new LocalFilesFailure("invalid-argument");
      const file = await open(this.file(index), "r+");
      try {
        let written = 0;
        while (written < bytes.byteLength) {
          this.check();
          const result = await file.write(
            bytes,
            written,
            bytes.byteLength - written,
            offset + written
          );
          if (!result.bytesWritten) throw new LocalFilesFailure("failed");
          written += result.bytesWritten;
        }
        this.offsets[index] += written;
      } finally {
        await file.close();
      }
      this.check();
    });
    // A failed chunk poisons this transfer; it must never produce a truncated successful upload.
    this.queue = work;
    void work.catch(() => undefined);
    return work;
  }

  commit(
    root: string,
    cId: string,
    userId: string,
    port: number,
    fetcher: typeof fetch
  ): Promise<{ count: number }> {
    if (this.committing)
      return Promise.reject(new LocalFilesFailure("invalid-argument"));
    this.committing = true;
    const work = this.queue.then(async () => {
      this.check();
      if (
        this.offsets.some(
          (offset, index) => offset !== this.input.files[index].size
        )
      )
        throw new LocalFilesFailure("invalid-argument");
      if (this.input.kind === "files") {
        await checkUploadDestinations(
          root,
          this.input.files.map((file) => file.path)
        );
        for (let index = 0; index < this.input.files.length; index++)
          await this.installFile(
            root,
            this.input.files[index].path,
            this.file(index)
          );
        return { count: this.input.files.length };
      }
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
        throw new LocalFilesFailure("file-service-unavailable");
      if ((await realpath(root)) !== root)
        throw new LocalFilesFailure("expired");
      checkProjectArchive(this.file(0));
      try {
        const temporary = await lstat(path.join(root, ".tmp"));
        if (!temporary.isDirectory() || temporary.isSymbolicLink())
          throw new LocalFilesFailure("permission-denied");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const form = new FormData();
      this.check();
      form.append("cId", cId);
      form.append("userId", userId);
      form.append("customTargetDir", root);
      form.append("workspacePath", root);
      form.append(
        "file",
        await openAsBlob(this.file(0)),
        path.posix.basename(this.input.files[0].path)
      );
      this.check();
      let response: Response;
      try {
        response = await fetcher(
          `http://127.0.0.1:${port}/api/computer/import-project`,
          {
            method: "POST",
            body: form,
            redirect: "error",
            signal: this.operation.controller.signal,
          }
        );
      } catch {
        this.check();
        throw new LocalFilesFailure("file-service-unavailable");
      }
      this.check();
      const payload = await response.json();
      this.check();
      if (!response.ok || payload.success !== true || payload.failCount > 0)
        throw new LocalFilesFailure(
          response.status === 403 ? "permission-denied" : "failed"
        );
      return { count: this.input.files.length };
    });
    this.queue = work;
    void work.catch(() => undefined);
    return work;
  }

  /** Atomic replacement protects an existing upload target from cancellation and disk errors. */
  private async installFile(
    root: string,
    name: string,
    source: string
  ): Promise<void> {
    this.check();
    const parts = name.split("/");
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      parent = path.join(parent, part);
      this.check();
      try {
        await mkdir(parent);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new LocalFilesFailure("permission-denied");
    }
    await checkUploadDestinations(root, [name]);
    const destination = path.join(root, name);
    const original = await lstat(destination).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    const temporary = path.join(parent, `.nuwax-upload-${randomUUID()}.tmp`);
    try {
      await pipeline(
        createReadStream(source),
        createWriteStream(temporary, {
          flags: "wx",
          mode: original ? original.mode & 0o777 : 0o600,
        }),
        { signal: this.operation.controller.signal }
      );
      if (original) await chmod(temporary, original.mode & 0o777);
      this.check();
      await checkUploadDestinations(root, [name]);
      if (original) {
        const current = await lstat(destination);
        if (
          current.dev !== original.dev ||
          current.ino !== original.ino ||
          current.size !== original.size ||
          current.mtimeMs !== original.mtimeMs ||
          current.ctimeMs !== original.ctimeMs
        )
          throw new LocalFilesFailure("conflict");
        this.check();
        await rename(temporary, destination);
      } else {
        this.check();
        await link(temporary, destination);
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }

  dispose(): Promise<void> {
    this.operation.controller.signal.removeEventListener("abort", this.onAbort);
    this.cleaned ??= this.queue
      .catch(() => undefined)
      .then(() =>
        rm(this.directory, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 100,
        })
      );
    return this.cleaned;
  }
}
