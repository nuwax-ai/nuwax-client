import os from "node:os";
import path from "node:path";
import {
  mkdtemp,
  writeFile,
  mkdir,
  rm,
  symlink,
  open,
  chmod,
  realpath,
} from "node:fs/promises";
import type { ReadStream } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  containsPath,
  decodeResourcePath,
  fileFailure,
  metadata,
  parseByteRange,
  relativeDirectory,
  resourceResponse,
  targetPath,
} from "./files";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "nuwax-files-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("filesystem paths and preview resources", () => {
  it("explicit existing absolute files are readable outside a context; relative traversal is refused", async () => {
    await mkdir(path.join(root, "workspace"));
    await writeFile(path.join(root, "outside.txt"), "outside");
    expect(
      (
        await metadata(
          path.join(root, "workspace"),
          path.join(root, "outside.txt")
        )
      ).size
    ).toBe(7);
    expect(() =>
      targetPath(path.join(root, "workspace"), "../outside.txt")
    ).toThrow();
    expect(containsPath(root, `${root}-other/file`)).toBe(false);
    expect(() => targetPath(root, "bad\0name")).toThrow();
  });

  it("listing refuses absolute paths, traversal and directory links escaping the root", async () => {
    await mkdir(path.join(root, "workspace"));
    await mkdir(path.join(root, "outside"));
    await symlink(
      path.join(root, "outside"),
      path.join(root, "workspace", "link"),
      "dir"
    );
    await expect(
      relativeDirectory(path.join(root, "workspace"), "link")
    ).rejects.toMatchObject({ code: "permission-denied" });
    await expect(relativeDirectory(root, "../other")).rejects.toMatchObject({
      code: "permission-denied",
    });
    await expect(relativeDirectory(root, root)).rejects.toMatchObject({
      code: "invalid-argument",
    });
  });

  it("decodes once and rejects encoded separators, NUL, invalid escapes and backslashes", () => {
    expect(
      decodeResourcePath(
        new URL("nuwax-local://grant/%E6%8A%A5%E5%91%8A%20%252e.md")
      )
    ).toBe("报告 %2e.md");
    for (const name of [
      "dir%2ffile",
      "dir%5cfile",
      "%00",
      "%QQ",
      "bad\\name",
    ]) {
      expect(() =>
        decodeResourcePath(new URL(`nuwax-local://grant/${name}`))
      ).toThrow();
    }
  });

  it("handles single byte ranges including suffix/open ranges and rejects unsatisfiable/multipart requests", () => {
    expect(parseByteRange(null, 20)).toBeNull();
    expect(parseByteRange("bytes=2-5", 20)).toEqual({ start: 2, end: 5 });
    expect(parseByteRange("bytes=18-100", 20)).toEqual({ start: 18, end: 19 });
    expect(parseByteRange("bytes=10-", 20)).toEqual({ start: 10, end: 19 });
    expect(parseByteRange("bytes=-5", 20)).toEqual({ start: 15, end: 19 });
    for (const range of [
      "bytes=20-",
      "bytes=5-2",
      "bytes=-0",
      "bytes=0-2,4-6",
      "items=0-3",
      "bytes=99999999999999999999-",
    ]) {
      expect(() => parseByteRange(range, 20)).toThrow();
    }
    expect(() => parseByteRange("bytes=0-0", 0)).toThrow();
  });

  it("streams GET and HEAD with MIME, size, Range, no-store and owner CORS", async () => {
    await writeFile(path.join(root, "报告 %name.txt"), "0123456789");
    const streams = new Set<ReadStream>();
    const resource = {
      root,
      origin: "https://business.example",
      streams,
      valid: () => true,
    };
    const url = "nuwax-local://grant/%E6%8A%A5%E5%91%8A%20%25name.txt";
    const full = await resourceResponse(new Request(url), resource);
    expect(full.status).toBe(200);
    expect(streams.size).toBe(1);
    expect(full.headers.get("content-type")).toBe("text/plain");
    expect(full.headers.get("content-length")).toBe("10");
    expect(full.headers.get("access-control-allow-origin")).toBe(
      resource.origin
    );
    expect(full.headers.get("referrer-policy")).toBe("no-referrer");
    expect(full.headers.get("cache-control")).toBe("no-store");
    expect(await full.text()).toBe("0123456789");
    const partial = await resourceResponse(
      new Request(url, { headers: { Range: "bytes=3-6" } }),
      resource
    );
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe("bytes 3-6/10");
    expect(partial.headers.get("x-file-size")).toBe("10");
    expect(await partial.text()).toBe("3456");
    const head = await resourceResponse(
      new Request(url, { method: "HEAD" }),
      resource
    );
    expect(head.body).toBeNull();
    expect(head.headers.get("content-length")).toBe("10");
    const invalid = await resourceResponse(
      new Request(url, { headers: { Range: "bytes=100-" } }),
      resource
    );
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("content-range")).toBe("bytes */10");
    expect(
      (await resourceResponse(new Request(url, { method: "POST" }), resource))
        .status
    ).toBe(405);
  });

  it("does not impose a 50MiB preview budget on a media stream", async () => {
    const handle = await open(path.join(root, "large.mp4"), "w");
    await handle.truncate(110 * 1024 * 1024);
    await handle.close();
    const resource = {
      root,
      origin: "https://business.example",
      streams: new Set<ReadStream>(),
      valid: () => true,
    };
    const head = await resourceResponse(
      new Request("nuwax-local://grant/large.mp4", { method: "HEAD" }),
      resource
    );
    expect(head.headers.get("content-length")).toBe(String(110 * 1024 * 1024));
    const range = await resourceResponse(
      new Request("nuwax-local://grant/large.mp4", {
        headers: { Range: "bytes=104857600-104857609" },
      }),
      resource
    );
    expect(range.status).toBe(206);
    expect((await range.arrayBuffer()).byteLength).toBe(10);
  });

  it("reports missing/permission files, refuses stale grants and symlink escapes", async () => {
    await mkdir(path.join(root, "workspace"));
    await writeFile(path.join(root, "secret.txt"), "secret");
    await symlink(
      path.join(root, "secret.txt"),
      path.join(root, "workspace", "link.txt")
    );
    const resource = {
      root: path.join(root, "workspace"),
      origin: "https://business.example",
      streams: new Set<ReadStream>(),
      valid: () => true,
    };
    expect(
      (
        await resourceResponse(
          new Request("nuwax-local://grant/missing.txt"),
          resource
        )
      ).status
    ).toBe(404);
    expect(
      (
        await resourceResponse(
          new Request("nuwax-local://grant/link.txt"),
          resource
        )
      ).status
    ).toBe(403);
    expect(
      (
        await resourceResponse(new Request("nuwax-local://grant/missing.txt"), {
          ...resource,
          valid: () => false,
        })
      ).status
    ).toBe(403);
    await writeFile(path.join(root, "workspace", "locked.txt"), "secret");
    await chmod(path.join(root, "workspace", "locked.txt"), 0);
    // Windows chmod changes the read-only attribute, not read access via ACLs.
    if (process.platform !== "win32" && process.getuid?.() !== 0)
      expect(
        (
          await resourceResponse(
            new Request("nuwax-local://grant/locked.txt"),
            resource
          )
        ).status
      ).toBe(403);
    await chmod(path.join(root, "workspace", "locked.txt"), 0o600);
    expect(fileFailure({ code: "EPERM" }).code).toBe("permission-denied");
  });
});
