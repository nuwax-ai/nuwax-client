import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdbRuntime } from "./adbRuntime";

const executable = Buffer.from("validated Android Debug Bridge");
const library = Buffer.from("validated companion library");
const metadata = (data: Buffer) => ({
  bytes: data.byteLength,
  sha256: createHash("sha256").update(data).digest("hex"),
});
const zip = new AdmZip();
zip.addFile("platform-tools/adb", executable);
zip.addFile("platform-tools/lib64/libc++.so", library);
zip.addFile("platform-tools/fastboot", Buffer.from("not needed by ADB"));
const archive = zip.toBuffer();
const release = {
  version: "37.0.1",
  platform: "test",
  url: "https://example.test/platform-tools.zip",
  ...metadata(archive),
  executable: "adb",
  files: {
    adb: metadata(executable),
    "lib64/libc++.so": metadata(library),
  },
};

describe("Android Platform-Tools managed runtime", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "nuwax-adb-runtime-test-"));
  });
  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("installs only validated files and reuses the cache without downloading", async () => {
    const download = vi.fn(async () => new Response(Uint8Array.from(archive)));
    const runtime = createAdbRuntime(directory, download, release);
    expect(await runtime.find()).toBeNull();
    expect(download).not.toHaveBeenCalled();
    await runtime.install(new AbortController().signal);
    const installed = (await runtime.find())!;
    expect(await fs.readFile(installed)).toEqual(executable);
    expect(await fs.readdir(path.dirname(installed))).toEqual(["adb", "lib64"]);
    await runtime.install(new AbortController().signal);
    expect(download).toHaveBeenCalledOnce();
    await fs.writeFile(installed, Buffer.alloc(executable.length));
    expect(await runtime.find()).toBeNull();
    await runtime.install(new AbortController().signal);
    expect(await runtime.find()).toBe(installed);
    expect(download).toHaveBeenCalledTimes(2);
  });

  it("rejects a corrupted archive and stays retryable", async () => {
    const corrupt = Uint8Array.from(archive);
    corrupt[0] ^= 1;
    const download = vi.fn()
      .mockResolvedValueOnce(new Response(corrupt))
      .mockResolvedValueOnce(new Response(Uint8Array.from(archive)));
    const runtime = createAdbRuntime(directory, download, release);
    await expect(runtime.install(new AbortController().signal)).rejects.toThrow("adbInstallIntegrity");
    expect(await fs.readdir(directory)).toEqual([]);
    await runtime.install(new AbortController().signal);
    expect(await runtime.find()).toEqual(expect.any(String));
  });

  it("resumes an interrupted download and still verifies the full archive", async () => {
    const offset = 48;
    const download = vi.fn()
      .mockResolvedValueOnce(new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(Uint8Array.from(archive.subarray(0, offset)));
        },
        pull(controller) {
          controller.error(new Error("connection closed"));
        },
      })))
      .mockResolvedValueOnce(new Response(Uint8Array.from(archive.subarray(offset)), {
        status: 206,
        headers: { "Content-Range": `bytes ${offset}-${archive.length - 1}/${archive.length}` },
      }));
    const runtime = createAdbRuntime(directory, download, release);
    await runtime.install(new AbortController().signal);
    expect(download).toHaveBeenCalledTimes(2);
    expect(download.mock.calls[1][1].headers).toEqual({ Range: "bytes=48-" });
    expect(await runtime.find()).toEqual(expect.any(String));
  });
});
