import os from "node:os";
import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import AdmZip from "adm-zip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalFileTransfer, TRANSFER_CHUNK_BYTES } from "./transfers";

let root: string;
const transfers: LocalFileTransfer[] = [];
beforeEach(async () => {
  root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "nuwax-transfer-test-"))
  );
});
afterEach(async () => {
  await Promise.all(transfers.splice(0).map((transfer) => transfer.dispose()));
  await rm(root, { recursive: true, force: true });
});
const operation = () => ({
  controller: new AbortController(),
  valid: () => true,
});
const create = async (
  input: Parameters<typeof LocalFileTransfer.create>[0],
  op = operation()
) => {
  const transfer = await LocalFileTransfer.create(input, op);
  transfers.push(transfer);
  return transfer;
};
const response = (count = 1) =>
  new Response(
    JSON.stringify({
      success: true,
      successCount: count,
      failCount: 0,
      results: Array.from({ length: count }, () => ({ success: true })),
    })
  );

describe("native file-panel transfers", () => {
  it("respects distinct Linux file names and rejects case collisions on Windows/macOS", async () => {
    const pending = create({
      kind: "files",
      files: [
        { path: "Foo", size: 1 },
        { path: "foo", size: 1 },
      ],
    });
    if (process.platform !== "linux") {
      await expect(pending).rejects.toMatchObject({ code: "invalid-argument" });
      return;
    }
    const transfer = await pending;
    await transfer.write(0, 0, Buffer.from("A"));
    await transfer.write(1, 0, Buffer.from("B"));
    await transfer.commit(root, "7", "local", 0, vi.fn());
    expect(await readFile(path.join(root, "Foo"), "utf8")).toBe("A");
    expect(await readFile(path.join(root, "foo"), "utf8")).toBe("B");
  });
  it("atomically installs exact binary bytes and empty files without a file-server dependency", async () => {
    const bytes = Buffer.alloc(TRANSFER_CHUNK_BYTES + 7, 0xac);
    const transfer = await create({
      kind: "files",
      files: [
        { path: "中文/a.bin", size: bytes.length },
        { path: "empty", size: 0 },
      ],
    });
    await transfer.write(0, 0, bytes.subarray(0, TRANSFER_CHUNK_BYTES));
    await transfer.write(
      0,
      TRANSFER_CHUNK_BYTES,
      bytes.subarray(TRANSFER_CHUNK_BYTES)
    );
    const fetcher = vi.fn();
    await expect(
      transfer.commit(root, "7", "local", 12450, fetcher)
    ).resolves.toEqual({ count: 2 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await readFile(path.join(root, "中文/a.bin"))).toEqual(bytes);
    expect(await readFile(path.join(root, "empty"))).toEqual(Buffer.alloc(0));
  });

  it.each([
    "../escape",
    "/absolute",
    "C:/escape",
    "C:\\escape",
    "\\\\server\\share",
    "a/../b",
    "a//b",
    "a:b",
    "a\0b",
    "NUL",
    "nested/COM1.txt",
    "trailing.",
    "trailing ",
  ])(
    "rejects cross-platform path injection %s before creating a transfer",
    async (name) => {
      await expect(
        create({ kind: "files", files: [{ path: name, size: 1 }] })
      ).rejects.toMatchObject({ code: "invalid-argument" });
    }
  );

  it("rejects incomplete, replayed and oversized chunks and never commits partial data", async () => {
    const fetcher = vi.fn();
    const transfer = await create({
      kind: "files",
      files: [{ path: "a", size: 3 }],
    });
    await transfer.write(0, 0, Buffer.from("a"));
    await expect(transfer.write(0, 0, Buffer.from("b"))).rejects.toMatchObject({
      code: "invalid-argument",
    });
    await expect(
      transfer.commit(root, "7", "local", 12450, fetcher)
    ).rejects.toMatchObject({ code: "invalid-argument" });
    expect(fetcher).not.toHaveBeenCalled();
    const large = await create({
      kind: "files",
      files: [{ path: "b", size: TRANSFER_CHUNK_BYTES + 1 }],
    });
    await expect(
      large.write(0, 0, Buffer.alloc(TRANSFER_CHUNK_BYTES + 1))
    ).rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("rejects existing symlink parents and cancellation before posting a write", async () => {
    const outside = await mkdtemp(
      path.join(os.tmpdir(), "nuwax-transfer-outside-")
    );
    try {
      await symlink(
        outside,
        path.join(root, "alias"),
        process.platform === "win32" ? "junction" : "dir"
      );
      const transfer = await create({
        kind: "files",
        files: [{ path: "alias/a", size: 0 }],
      });
      const fetcher = vi.fn();
      await expect(
        transfer.commit(root, "7", "local", 12450, fetcher)
      ).rejects.toMatchObject({ code: "permission-denied" });
      const op = operation();
      const canceled = await create(
        { kind: "files", files: [{ path: "b", size: 0 }] },
        op
      );
      op.controller.abort();
      await expect(
        canceled.commit(root, "7", "local", 12450, fetcher)
      ).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects ZIP links and posts a checked archive to the existing import command", async () => {
    for (const link of [true, false]) {
      const zip = new AdmZip();
      zip.addFile("project/a.txt", Buffer.from("hello"));
      if (link) zip.getEntries()[0].attr = (0o120777 << 16) >>> 0;
      const bytes = zip.toBuffer();
      const transfer = await create({
        kind: "project",
        files: [{ path: "project.zip", size: bytes.length }],
      });
      await transfer.write(0, 0, bytes);
      const fetcher = vi.fn(async (url, options) => {
        expect(url).toBe("http://127.0.0.1:12450/api/computer/import-project");
        expect(
          Buffer.from(
            await ((options.body as FormData).get("file") as File).arrayBuffer()
          )
        ).toEqual(bytes);
        return new Response(JSON.stringify({ success: true }));
      });
      const result = transfer.commit(root, "7", "local", 12450, fetcher);
      if (link) {
        await expect(result).rejects.toMatchObject({
          code: "permission-denied",
        });
        expect(fetcher).not.toHaveBeenCalled();
      } else await expect(result).resolves.toEqual({ count: 1 });
    }
  });

  it("preserves concurrent edits and removes temporary files on a failed replacement", async () => {
    await writeFile(path.join(root, "a"), "original");
    const op = operation();
    let changed = false;
    op.valid = () => {
      if (
        !changed &&
        readdirSync(root).some((name) => name.startsWith(".nuwax-upload-"))
      ) {
        writeFileSync(path.join(root, "a"), "external edit");
        changed = true;
      }
      return true;
    };
    const transfer = await create(
      { kind: "files", files: [{ path: "a", size: 3 }] },
      op
    );
    await transfer.write(0, 0, Buffer.from("new"));
    await expect(
      transfer.commit(root, "7", "local", 0, vi.fn())
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await readFile(path.join(root, "a"), "utf8")).toBe("external edit");
    expect(readdirSync(root)).toEqual(["a"]);
  });

  it("does not report an unsuccessful local import as successful", async () => {
    const zip = new AdmZip();
    zip.addFile("a.txt", Buffer.from("a"));
    const bytes = zip.toBuffer();
    const transfer = await create({
      kind: "project",
      files: [{ path: "a.zip", size: bytes.length }],
    });
    await transfer.write(0, 0, bytes);
    await expect(
      transfer.commit(
        root,
        "7",
        "local",
        12450,
        vi.fn(async () => new Response(JSON.stringify({ success: false })))
      )
    ).rejects.toMatchObject({ code: "failed" });
  });
});
