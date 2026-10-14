import path from "node:path";
import { open, realpath, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import type { ReadStream } from "node:fs";
import { lookup } from "mime-types";
import type {
  LocalFileMetadata,
  LocalFilesErrorCode,
} from "@shared/features/local-files/contract";

export class LocalFilesFailure extends Error {
  constructor(readonly code: LocalFilesErrorCode, message = code) {
    super(message);
  }
}

export function fileFailure(error: unknown): LocalFilesFailure {
  if (error instanceof LocalFilesFailure) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || code === "ENOTDIR")
    return new LocalFilesFailure("not-found");
  if (code === "EACCES" || code === "EPERM")
    return new LocalFilesFailure("permission-denied");
  if ((error as Error)?.name === "AbortError")
    return new LocalFilesFailure("canceled");
  return new LocalFilesFailure("failed");
}

export function requireString(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\0") ||
    value.length > 32768
  ) {
    throw new LocalFilesFailure("invalid-argument");
  }
  return value;
}

export function containsPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

/** Explicit absolute files are allowed; relative targets cannot lexically leave the workspace. */
export function targetPath(root: string, value: unknown): string {
  const input = requireString(value);
  if (path.isAbsolute(input)) return path.normalize(input);
  const candidate = path.resolve(root, input.replace(/\\/g, path.sep));
  if (!containsPath(root, candidate))
    throw new LocalFilesFailure("permission-denied");
  return candidate;
}

/** Listing/searching are always anchored to the resolved context, including symlink directories. */
export async function relativeDirectory(
  root: string,
  value: unknown
): Promise<string> {
  if (value === undefined || value === "") return "";
  const input = requireString(value).replace(/\\/g, path.sep);
  if (path.isAbsolute(input)) throw new LocalFilesFailure("invalid-argument");
  const candidate = path.resolve(root, input);
  if (
    !containsPath(root, candidate) ||
    !containsPath(root, await realpath(candidate))
  ) {
    throw new LocalFilesFailure("permission-denied");
  }
  if (!(await stat(candidate)).isDirectory())
    throw new LocalFilesFailure("invalid-argument");
  return path.relative(root, candidate).split(path.sep).join("/");
}

export async function metadata(
  root: string,
  value: unknown
): Promise<LocalFileMetadata> {
  const resolved = await realpath(targetPath(root, value));
  const info = await stat(resolved);
  return {
    path: resolved,
    size: info.size,
    mime: lookup(resolved) || "application/octet-stream",
    isDir: info.isDirectory(),
    mtimeMs: info.mtimeMs,
  };
}

export function encodeResourcePath(relative: string): string {
  return relative.split(path.sep).map(encodeURIComponent).join("/");
}

export function decodeResourcePath(url: URL): string {
  if (/%(?:2f|5c)/i.test(url.pathname))
    throw new LocalFilesFailure("permission-denied");
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    throw new LocalFilesFailure("invalid-argument");
  }
  if (decoded.includes("\0") || decoded.includes("\\"))
    throw new LocalFilesFailure("permission-denied");
  return decoded.replace(/^\/+/, "");
}

export type ByteRange = { start: number; end: number };
export function parseByteRange(
  header: string | null,
  size: number
): ByteRange | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || !size)
    throw new LocalFilesFailure("invalid-argument");
  const left = match[1] ? Number(match[1]) : null;
  const right = match[2] ? Number(match[2]) : null;
  if (
    (left !== null && !Number.isSafeInteger(left)) ||
    (right !== null && !Number.isSafeInteger(right))
  ) {
    throw new LocalFilesFailure("invalid-argument");
  }
  if (left === null) {
    if (!right || right < 1) throw new LocalFilesFailure("invalid-argument");
    return { start: Math.max(0, size - right), end: size - 1 };
  }
  if (left >= size || (right !== null && right < left))
    throw new LocalFilesFailure("invalid-argument");
  return { start: left, end: Math.min(right ?? size - 1, size - 1) };
}

export interface PreviewResource {
  root: string;
  origin: string;
  streams: Set<ReadStream>;
  valid(): boolean;
}

/** The request policy verifies the initiating frame; this additionally checks grant freshness. */
export async function resourceResponse(
  request: Request,
  resource: PreviewResource
): Promise<Response> {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": resource.origin,
    "Access-Control-Expose-Headers":
      "Content-Length, Content-Range, Accept-Ranges, X-File-Size",
    Vary: "Origin",
    "Accept-Ranges": "bytes",
  });
  if (!resource.valid()) return new Response(null, { status: 403, headers });
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers });
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const relative = decodeResourcePath(new URL(request.url));
    const candidate = path.resolve(resource.root, relative);
    if (!containsPath(resource.root, candidate))
      throw new LocalFilesFailure("permission-denied");
    const resolved = await realpath(candidate);
    if (!containsPath(resource.root, resolved))
      throw new LocalFilesFailure("permission-denied");
    file = await open(resolved, "r");
    const info = await file.stat();
    if (!info.isFile()) throw new LocalFilesFailure("not-found");
    if (!resource.valid()) throw new LocalFilesFailure("expired");
    headers.set("Content-Type", lookup(resolved) || "application/octet-stream");
    headers.set("X-File-Size", String(info.size));
    let range: ByteRange | null;
    try {
      range = parseByteRange(request.headers.get("Range"), info.size);
    } catch {
      headers.set("Content-Range", `bytes */${info.size}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set(
      "Content-Length",
      String(range ? range.end - range.start + 1 : info.size)
    );
    if (range)
      headers.set(
        "Content-Range",
        `bytes ${range.start}-${range.end}/${info.size}`
      );
    if (request.method === "HEAD" || info.size === 0)
      return new Response(null, { status: range ? 206 : 200, headers });
    const stream = file.createReadStream({ ...(range ?? {}), autoClose: true });
    file = undefined; // stream owns the descriptor
    resource.streams.add(stream);
    const close = () => {
      resource.streams.delete(stream);
      request.signal.removeEventListener("abort", abort);
    };
    const abort = () =>
      stream.destroy(new DOMException("Aborted", "AbortError"));
    stream.once("close", close);
    // Keep an error listener even when release runs before Chromium attaches a body reader.
    stream.on("error", () => undefined);
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted || !resource.valid()) abort();
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: range ? 206 : 200,
      headers,
    });
  } catch (error) {
    const failure = fileFailure(error);
    const status =
      failure.code === "not-found"
        ? 404
        : failure.code === "permission-denied" || failure.code === "expired"
        ? 403
        : failure.code === "invalid-argument"
        ? 400
        : 500;
    return new Response(null, { status, headers });
  } finally {
    await file?.close();
  }
}
