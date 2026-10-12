import os from "node:os";
import path from "node:path";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  link,
  open,
  readdir,
} from "node:fs/promises";
import AdmZip from "adm-zip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyFileAtomic, exportWorkspaceAtomic } from "./operations";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nuwax-export-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const operation = () => ({
  controller: new AbortController(),
  valid: () => true,
});

describe("atomic local saves", () => {
  it("copies and replaces the selected destination without leaving temporary files", async () => {
    const source = path.join(root, "source.txt");
    const destination = path.join(root, "target.txt");
    await writeFile(source, "new");
    await writeFile(destination, "old");
    await copyFileAtomic(source, destination, operation());
    expect(await readFile(destination, "utf8")).toBe("new");
    expect((await readdir(root)).sort()).toEqual(["source.txt", "target.txt"]);
  });

  it("protects the source file against same path, symlink aliases and hardlink aliases", async () => {
    const source = path.join(root, "source.txt");
    await writeFile(source, "source");
    await link(source, path.join(root, "hard.txt"));
    await symlink(source, path.join(root, "soft.txt"));
    for (const name of ["source.txt", "hard.txt", "soft.txt"]) {
      await expect(
        copyFileAtomic(source, path.join(root, name), operation())
      ).rejects.toMatchObject({ code: "invalid-argument" });
    }
    expect(await readFile(source, "utf8")).toBe("source");
  });

  it("cleans a canceled large copy and preserves the old destination", async () => {
    const source = path.join(root, "large.bin");
    const destination = path.join(root, "old.txt");
    const file = await open(source, "w");
    await file.truncate(110 * 1024 * 1024);
    await file.close();
    await writeFile(destination, "old");
    const op = operation();
    const pending = copyFileAtomic(source, destination, op);
    setTimeout(() => op.controller.abort(), 1);
    await expect(pending).rejects.toThrow();
    expect(await readFile(destination, "utf8")).toBe("old");
    expect((await readdir(root)).some((name) => name.includes(".nuwax-"))).toBe(
      false
    );
  });
});

describe("complete workspace ZIP", () => {
  it("includes hidden items, hardlinks, symlinks, empty dirs and >100MiB files; excludes output/temp", async () => {
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    await mkdir(path.join(workspace, ".hidden"));
    await mkdir(path.join(workspace, "empty"));
    await writeFile(path.join(workspace, ".hidden", "note.txt"), "hidden");
    await writeFile(path.join(workspace, "original.txt"), "hard data");
    await link(
      path.join(workspace, "original.txt"),
      path.join(workspace, "hard.txt")
    );
    await writeFile(
      path.join(root, "outside.txt"),
      "outside must not be dereferenced"
    );
    await symlink("../outside.txt", path.join(workspace, "soft.txt"));
    const large = await open(path.join(workspace, "large.bin"), "w");
    await large.truncate(101 * 1024 * 1024);
    await large.close();
    const output = path.join(workspace, "all.zip");
    await writeFile(output, "old zip");
    await exportWorkspaceAtomic(workspace, output, operation());
    const zip = new AdmZip(output);
    const names = zip.getEntries().map((entry) => entry.entryName);
    expect(names).toContain("workspace/.hidden/note.txt");
    expect(names).toContain("workspace/empty/");
    expect(zip.readAsText("workspace/hard.txt")).toBe("hard data");
    expect(zip.readAsText("workspace/soft.txt")).toBe("../outside.txt");
    expect(
      (zip.getEntry("workspace/soft.txt")!.header.attr >>> 16) & 0o170000
    ).toBe(0o120000);
    expect(zip.getEntry("workspace/large.bin")!.header.size).toBe(
      101 * 1024 * 1024
    );
    expect(names).not.toContain("workspace/all.zip");
    expect(names.some((name) => name.includes(".nuwax-"))).toBe(false);
    expect(
      (await readdir(workspace)).some((name) => name.includes(".nuwax-"))
    ).toBe(false);
  }, 20000);

  it("canceling traversal/streaming cleans partial ZIP and preserves the previous file", async () => {
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const large = await open(path.join(workspace, "large.bin"), "w");
    await large.truncate(110 * 1024 * 1024);
    await large.close();
    const output = path.join(root, "all.zip");
    await writeFile(output, "old");
    const op = operation();
    const pending = exportWorkspaceAtomic(workspace, output, op);
    setTimeout(() => op.controller.abort(), 5);
    await expect(pending).rejects.toThrow();
    expect(await readFile(output, "utf8")).toBe("old");
    expect((await readdir(root)).some((name) => name.includes(".nuwax-"))).toBe(
      false
    );
  });
});
