import os from "node:os";
import path from "node:path";
import { readdirSync, writeFileSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyFileChanges } from "./mutations";

let fixture: string;
let root: string;
beforeEach(async () => {
  fixture = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "nuwax-file-mutations-")),
  );
  root = path.join(fixture, "workspace");
  await mkdir(root);
});
afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});
const operation = () => ({
  controller: new AbortController(),
  valid: () => true,
});

describe("native workspace mutations", () => {
  it("keeps a concurrent external edit and removes the staged replacement", async () => {
    const file = path.join(root, "external.txt");
    await writeFile(file, "original");
    let changed = false;
    const current = operation();
    current.valid = () => {
      if (!changed && readdirSync(root).some((name) => name.endsWith(".tmp"))) {
        writeFileSync(file, "external edit");
        changed = true;
      }
      return true;
    };
    await expect(
      applyFileChanges(
        root,
        [
          {
            name: "external.txt",
            operation: "modify",
            contents: "editor save",
          },
        ],
        current,
        vi.fn(),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(changed).toBe(true);
    expect(await readFile(file, "utf8")).toBe("external edit");
    expect(await readdir(root)).toEqual(["external.txt"]);
  });

  it("creates, atomically edits, renames and trashes real files and directories", async () => {
    const trash = vi.fn(async (file: string) => {
      await rename(file, path.join(fixture, "trashed"));
    });
    await applyFileChanges(
      root,
      [{ name: "文档.txt", operation: "create", contents: "hello" }],
      operation(),
      trash,
    );
    await applyFileChanges(
      root,
      [{ name: "文档.txt", operation: "modify", contents: "你好\n" }],
      operation(),
      trash,
    );
    expect(await readFile(path.join(root, "文档.txt"), "utf8")).toBe("你好\n");
    await applyFileChanges(
      root,
      [{ name: "docs", operation: "create", isDir: true }],
      operation(),
      trash,
    );
    await applyFileChanges(
      root,
      [
        {
          name: "docs/renamed.txt",
          renameFrom: "文档.txt",
          operation: "rename",
        },
      ],
      operation(),
      trash,
    );
    await applyFileChanges(
      root,
      [{ name: "docs", operation: "delete", isDir: true }],
      operation(),
      trash,
    );
    expect(trash).toHaveBeenCalledWith(path.join(root, "docs"));
    expect(
      await readFile(path.join(fixture, "trashed/renamed.txt"), "utf8"),
    ).toBe("你好\n");
    expect(await readdir(root)).toEqual([]);
  });

  it("never overwrites an existing create/rename target or changes it on a failed save", async () => {
    await writeFile(path.join(root, "a"), "original", { mode: 0o640 });
    await writeFile(path.join(root, "b"), "other");
    const trash = vi.fn();
    await expect(
      applyFileChanges(
        root,
        [{ name: "a", operation: "create", contents: "lost" }],
        operation(),
        trash,
      ),
    ).rejects.toMatchObject({ code: "already-exists" });
    await expect(
      applyFileChanges(
        root,
        [{ name: "b", renameFrom: "a", operation: "rename" }],
        operation(),
        trash,
      ),
    ).rejects.toMatchObject({ code: "already-exists" });
    const canceled = operation();
    canceled.controller.abort();
    await expect(
      applyFileChanges(
        root,
        [{ name: "a", operation: "modify", contents: "lost" }],
        canceled,
        trash,
      ),
    ).rejects.toThrow();
    expect(await readFile(path.join(root, "a"), "utf8")).toBe("original");
    await applyFileChanges(
      root,
      [{ name: "a", operation: "modify", contents: "saved" }],
      operation(),
      trash,
    );
    if (process.platform !== "win32")
      expect((await lstat(path.join(root, "a"))).mode & 0o777).toBe(0o640);
    expect((await readdir(root)).sort()).toEqual(["a", "b"]);
  });

  it("preflights the whole batch and rejects the workspace root and escaping paths", async () => {
    const trash = vi.fn();
    for (const name of ["../outside", root, path.dirname(root)]) {
      await expect(
        applyFileChanges(
          root,
          [
            {
              name: "first",
              operation: "create",
              contents: "must not be written",
            },
            { name, operation: "delete" },
          ],
          operation(),
          trash,
        ),
      ).rejects.toMatchObject({ code: "permission-denied" });
      expect(await readdir(root)).toEqual([]);
    }
    expect(trash).not.toHaveBeenCalled();
  });

  it("rejects linked parents and editing symlinks while trashing the link keeps its target", async () => {
    await writeFile(path.join(fixture, "outside.txt"), "outside");
    await mkdir(path.join(fixture, "outside-dir"));
    await symlink(
      path.join(fixture, "outside-dir"),
      path.join(root, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const trash = vi.fn(async (file: string) => {
      await rename(file, path.join(fixture, "trashed-link"));
    });
    await expect(
      applyFileChanges(
        root,
        [{ name: "alias/new.txt", operation: "create", contents: "no" }],
        operation(),
        trash,
      ),
    ).rejects.toMatchObject({ code: "permission-denied" });
    await expect(
      applyFileChanges(
        root,
        [{ name: "alias", operation: "modify", contents: "no" }],
        operation(),
        trash,
      ),
    ).rejects.toMatchObject({ code: "permission-denied" });
    await applyFileChanges(
      root,
      [{ name: "alias", operation: "delete", isDir: true }],
      operation(),
      trash,
    );
    expect((await lstat(path.join(fixture, "outside-dir"))).isDirectory()).toBe(
      true,
    );
    expect(await readFile(path.join(fixture, "outside.txt"), "utf8")).toBe(
      "outside",
    );
  });

  it("a trash failure preserves the file and never falls back to permanent deletion", async () => {
    await writeFile(path.join(root, "keep.txt"), "keep");
    const trash = vi.fn().mockRejectedValue(new Error("trash unavailable"));
    await expect(
      applyFileChanges(
        root,
        [{ name: "keep.txt", operation: "delete" }],
        operation(),
        trash,
      ),
    ).rejects.toThrow("trash unavailable");
    expect(await readFile(path.join(root, "keep.txt"), "utf8")).toBe("keep");
  });

  it("supports case-only renames without changing file content", async () => {
    await writeFile(path.join(root, "lower.txt"), "case");
    await applyFileChanges(
      root,
      [{ name: "LOWER.txt", renameFrom: "lower.txt", operation: "rename" }],
      operation(),
      vi.fn(),
    );
    expect(await readdir(root)).toEqual(["LOWER.txt"]);
    expect(await readFile(path.join(root, "LOWER.txt"), "utf8")).toBe("case");
  });
});
