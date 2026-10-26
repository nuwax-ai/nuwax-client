import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import type { LocalFileChange } from "@shared/features/local-files/contract";
import {
  containsPath,
  LocalFilesFailure,
  requireString,
  targetPath,
} from "./files";
import type { FileOperation } from "./operations";

const MAX_BATCH_CHANGES = 1000;
const MAX_BATCH_TEXT_BYTES = 16 * 1024 * 1024;

function check(operation: FileOperation): void {
  operation.controller.signal.throwIfAborted();
  if (!operation.valid()) throw new LocalFilesFailure("expired");
}

/** Resolve the parent, keeping a final symlink as an entry for rename/trash. */
async function mutationPath(root: string, name: string): Promise<string> {
  const candidate = targetPath(root, name);
  if (!containsPath(root, candidate) || candidate === root)
    throw new LocalFilesFailure("permission-denied");
  const parent = await realpath(path.dirname(candidate));
  if (!containsPath(root, parent))
    throw new LocalFilesFailure("permission-denied");
  return path.join(parent, path.basename(candidate));
}

async function absent(file: string): Promise<void> {
  try {
    await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new LocalFilesFailure("already-exists");
}

async function renameTargetAvailable(
  source: string,
  destination: string,
): Promise<void> {
  try {
    await absent(destination);
  } catch (error) {
    // A case-only rename can address the same entry on a case-insensitive volume.
    if (
      !(error instanceof LocalFilesFailure) ||
      error.code !== "already-exists" ||
      source.toLowerCase() !== destination.toLowerCase()
    )
      throw error;
    const [left, right] = await Promise.all([
      lstat(source),
      lstat(destination),
    ]);
    if (left.dev !== right.dev || left.ino !== right.ino) throw error;
  }
}

function validate(changes: LocalFileChange[]): void {
  if (
    !Array.isArray(changes) ||
    !changes.length ||
    changes.length > MAX_BATCH_CHANGES
  )
    throw new LocalFilesFailure("invalid-argument");
  let textBytes = 0;
  for (const change of changes) {
    if (!change || typeof change !== "object")
      throw new LocalFilesFailure("invalid-argument");
    requireString(change.name);
    if (change.isDir !== undefined && typeof change.isDir !== "boolean")
      throw new LocalFilesFailure("invalid-argument");
    if (!["create", "modify", "rename", "delete"].includes(change.operation))
      throw new LocalFilesFailure("invalid-argument");
    if (change.operation === "rename") requireString(change.renameFrom);
    if (
      (change.operation === "create" || change.operation === "modify") &&
      !change.isDir
    ) {
      if (change.binary || typeof change.contents !== "string")
        throw new LocalFilesFailure("invalid-argument");
      textBytes += Buffer.byteLength(change.contents, "utf8");
    }
    if (textBytes > MAX_BATCH_TEXT_BYTES)
      throw new LocalFilesFailure("invalid-argument");
  }
}

async function preflight(root: string, change: LocalFileChange): Promise<void> {
  const destination = await mutationPath(root, change.name);
  if (change.operation === "create") return absent(destination);
  const source =
    change.operation === "rename"
      ? await mutationPath(root, change.renameFrom!)
      : destination;
  const info = await lstat(source);
  if (
    !info.isSymbolicLink() &&
    change.isDir !== undefined &&
    change.isDir !== info.isDirectory()
  )
    throw new LocalFilesFailure("invalid-argument");
  if (change.operation === "modify" && !info.isFile())
    throw new LocalFilesFailure("permission-denied");
  if (change.operation === "rename" && source !== destination) {
    if (info.isDirectory() && containsPath(source, destination))
      throw new LocalFilesFailure("invalid-argument");
    await renameTargetAvailable(source, destination);
  }
}

/** Each text replacement commits atomically; a failed create cannot overwrite another file. */
async function writeText(
  root: string,
  change: LocalFileChange,
  operation: FileOperation,
): Promise<void> {
  const destination = await mutationPath(root, change.name);
  const original =
    change.operation === "modify" ? await lstat(destination) : null;
  if (original && !original.isFile())
    throw new LocalFilesFailure("permission-denied");
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.nuwax-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, change.contents!, {
      flag: "wx",
      mode: original ? original.mode & 0o777 : 0o600,
      signal: operation.controller.signal,
    });
    if (original) await chmod(temporary, original.mode & 0o777);
    check(operation);
    if ((await mutationPath(root, change.name)) !== destination)
      throw new LocalFilesFailure("conflict");
    if (original) {
      const current = await lstat(destination);
      if (
        !current.isFile() ||
        current.dev !== original.dev ||
        current.ino !== original.ino ||
        current.size !== original.size ||
        current.mtimeMs !== original.mtimeMs ||
        current.ctimeMs !== original.ctimeMs
      )
        throw new LocalFilesFailure("conflict");
      check(operation);
      await rename(temporary, destination);
    } else {
      check(operation);
      await link(temporary, destination);
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function applyFileChanges(
  root: string,
  changes: LocalFileChange[],
  operation: FileOperation,
  trashItem: (file: string) => Promise<void>,
): Promise<void> {
  validate(changes);
  check(operation);
  // Reject invalid paths anywhere in a batch before its first side effect.
  for (const change of changes) await preflight(root, change);
  for (const change of changes) {
    check(operation);
    await preflight(root, change);
    const destination = await mutationPath(root, change.name);
    check(operation);
    if (change.operation === "delete") await trashItem(destination);
    else if (change.operation === "rename") {
      const source = await mutationPath(root, change.renameFrom!);
      check(operation);
      if (source !== destination) await rename(source, destination);
    } else if (change.operation === "create" && change.isDir)
      await mkdir(destination);
    else await writeText(root, change, operation);
  }
}
