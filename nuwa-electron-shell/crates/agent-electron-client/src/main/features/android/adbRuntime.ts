import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import AdmZip from "adm-zip";
import type { AndroidAdbInstallOffer } from "@shared/features/android/contract";
import { platformToolsRelease } from "./adbRuntimeRelease";

export interface AdbRuntimeRelease {
  version: string;
  platform: string;
  url: string;
  sourceUrl?: string;
  bytes: number;
  sha256: string;
  executable: string;
  files: Record<string, { bytes: number; sha256: string }>;
}

type Download = (url: string, init: RequestInit) => Promise<Response>;
const DOWNLOAD_TIMEOUT_MS = 300_000;
const DOWNLOAD_ATTEMPTS = 4;

const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");

async function downloadArchive(release: AdbRuntimeRelease, download: Download, signal: AbortSignal) {
  const parts: Buffer[] = [];
  let bytes = 0;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS && bytes < release.bytes; attempt++) {
    signal.throwIfAborted();
    try {
      const response = await download(release.url, {
        signal,
        redirect: "error",
        credentials: "omit",
        headers: bytes ? { Range: "bytes=" + bytes + "-" } : undefined,
      });
      if (!response.ok || !response.body) throw new Error("adbInstallFailed");
      const stream = response.body.getReader();
      let complete = false;
      try {
        if (response.status === 200) {
          parts.length = 0;
          bytes = 0;
        } else if (
          !bytes || response.status !== 206 ||
          response.headers.get("content-range") !==
            `bytes ${bytes}-${release.bytes - 1}/${release.bytes}`
        ) {
          throw new Error("adbInstallIntegrity");
        }
        for (;;) {
          signal.throwIfAborted();
          const part = await stream.read();
          if (part.done) {
            complete = true;
            break;
          }
          bytes += part.value.byteLength;
          if (bytes > release.bytes) throw new Error("adbInstallIntegrity");
          parts.push(Buffer.from(part.value));
        }
      } finally {
        if (!complete) await stream.cancel().catch(() => undefined);
        stream.releaseLock();
      }
    } catch (error) {
      if (
        signal.aborted || attempt === DOWNLOAD_ATTEMPTS ||
        (error instanceof Error && error.message === "adbInstallIntegrity")
      ) throw error;
    }
  }
  if (bytes !== release.bytes) throw new Error("adbInstallFailed");
  const archive = Buffer.concat(parts, bytes);
  if (digest(archive) !== release.sha256) throw new Error("adbInstallIntegrity");
  return archive;
}

export function createAdbRuntime(
  dataDir: string,
  download: Download,
  release: AdbRuntimeRelease | null = platformToolsRelease(),
) {
  const cache = path.join(dataDir, "platform-tools");
  const destination = release && path.join(cache, release.version + "-" + release.platform);
  const offer: AndroidAdbInstallOffer | undefined = release
    ? {
        version: release.version,
        bytes: release.bytes,
        ...(release.sourceUrl ? { sourceUrl: release.sourceUrl } : {}),
      }
    : undefined;

  const find = async (): Promise<string | null> => {
    if (!release || !destination) return null;
    try {
      if (!(await fs.lstat(destination)).isDirectory()) return null;
      for (const [name, expected] of Object.entries(release.files)) {
        const file = path.join(destination, name);
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.size !== expected.bytes) return null;
        if (digest(await fs.readFile(file)) !== expected.sha256) return null;
      }
      return path.join(destination, release.executable);
    } catch {
      return null;
    }
  };

  const install = async (signal: AbortSignal): Promise<void> => {
    if (!release || !destination) throw new Error("adbInstallUnsupported");
    signal.throwIfAborted();
    if (await find()) return;

    const deadline = AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]);
    const archive = await downloadArchive(release, download, deadline);
    signal.throwIfAborted();

    await fs.mkdir(cache, { recursive: true, mode: 0o700 });
    const staging = await fs.mkdtemp(path.join(cache, ".install-"));
    const ready = path.join(staging, "ready");
    const previous = path.join(staging, "previous");
    let keepBackup = false;
    try {
      await fs.mkdir(ready, { mode: 0o700 });
      const zip = new AdmZip(archive);
      for (const [name, expected] of Object.entries(release.files)) {
        signal.throwIfAborted();
        // Only read the exact expected archive entries. Never extract caller-supplied paths.
        const entry = zip.getEntry("platform-tools/" + name);
        if (!entry || entry.isDirectory || entry.header.size !== expected.bytes)
          throw new Error("adbInstallIntegrity");
        const bytes = entry.getData();
        if (digest(bytes) !== expected.sha256) throw new Error("adbInstallIntegrity");
        const file = path.join(ready, name);
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await fs.writeFile(file, bytes, {
          flag: "wx",
          mode: name === release.executable ? 0o700 : 0o600,
        });
      }
      signal.throwIfAborted();

      // Preserve the previous cache until the validated replacement is in place.
      let backedUp = false;
      try {
        await fs.rename(destination, previous);
        backedUp = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        signal.throwIfAborted();
        await fs.rename(ready, destination);
      } catch (error) {
        if (backedUp) {
          try {
            await fs.rename(previous, destination);
          } catch {
            keepBackup = true;
          }
        }
        throw error;
      }
    } finally {
      if (!keepBackup) await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  return { offer, find, install };
}
