import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ThemeService, type ThemeDeps } from "./service";
import { officialThemePackage, limits } from "@shared/features/themes/core";
import type { HostThemeFiles } from "@shared/types/hostBridge";

const roots: string[] = [],
  services: ThemeService[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const service of services.splice(0)) await service.dispose();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function root() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "themes-test-"));
  roots.push(dir);
  return dir;
}
function files(id = "custom-theme", name = "Custom"): HostThemeFiles {
  const out = { ...officialThemePackage.files } as HostThemeFiles;
  const manifest = JSON.parse(
    Buffer.from(out["theme.json"], "base64").toString()
  );
  manifest.id = id;
  manifest.name = name;
  out["theme.json"] = Buffer.from(JSON.stringify(manifest)).toString("base64");
  return out;
}
async function write(dir: string, values: HostThemeFiles) {
  await fs.mkdir(dir, { recursive: true });
  for (const [name, value] of Object.entries(values))
    await fs.writeFile(path.join(dir, name), Buffer.from(value, "base64"));
}
async function setup(directory?: string, overrides: Partial<ThemeDeps> = {}) {
  const callbacks = new Map<string, () => void>();
  const closed = vi.fn();
  const deps: ThemeDeps = {
    fs,
    watch: (dir, cb) => {
      callbacks.set(dir, cb);
      return closed;
    },
    systemDark: () => false,
    applyPreference: vi.fn(),
    changed: vi.fn(),
    ...overrides,
  };
  const service = new ThemeService(directory ?? (await root()), deps);
  services.push(service);
  await service.ready;
  return { service, deps, callbacks, closed };
}
describe("theme package service", () => {
  it("provides actual card palettes and a cached background thumbnail without selecting a theme", async () => {
    const thumbnail = vi.fn(() => "data:image/png;base64,thumbnail");
    const { service } = await setup(undefined, { thumbnail });
    const selectedBefore = service.state().selection;
    const custom = files("card-preview", "Card preview");
    const manifest = JSON.parse(Buffer.from(custom["theme.json"], "base64").toString());
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRlEAAAAASUVORK5CYII=";
    custom["assets/preview.png"] = png;
    custom["styles/preview.css"] = Buffer.from('[data-theme-part="app"]{background-image:url("../assets/preview.png")}').toString("base64");
    manifest.variants.light.styles = { shell: ["styles/preview.css"] };
    custom[manifest.variants.light.tokens] = Buffer.from(JSON.stringify({ primary: "#23755a" })).toString("base64");
    custom["theme.json"] = Buffer.from(JSON.stringify(manifest)).toString("base64");
    await service.install(custom);
    expect(service.state().themes.find(item => item.id === "card-preview")?.preview).toBeUndefined();
    expect(thumbnail).not.toHaveBeenCalled();
    for (let i = 0; i < 2; i++) {
      const state = service.state({ previews: true });
      expect(state.selection).toEqual(selectedBefore);
      expect(state.themes.find(item => item.id === "card-preview")?.preview).toMatchObject({
        mode: "light", tokens: { primary: "#23755a" }, image: "data:image/png;base64,thumbnail",
      });
    }
    expect(thumbnail).toHaveBeenCalledOnce();
    expect(thumbnail).toHaveBeenCalledWith({ mime: "image/png", base64: png });
  });
  it("copies a builtin, atomically edits both modes, and restores durable files and selection after restart", async () => {
    const { service } = await setup();
    const source = await service.readForEdit("nuwax-default");
    await service.copyForEdit({ sourceId: source.themeId, themeId: "personal", name: "Personal", expectedRevision: source.revision, expectedVersion: source.version });
    await service.select("personal", "dark");
    const before = await service.readForEdit("personal");
    const manifest = JSON.parse(Buffer.from(before.files["theme.json"], "base64").toString());
    const changes = ["light", "dark"].map(mode => ({ path: manifest.variants[mode].tokens, content: JSON.stringify({ primary: "#23755a" }) }));
    await service.applyChanges({ themeId: "personal", expectedRevision: before.revision, expectedVersion: before.version, changes });
    const edited = await service.readForEdit("personal");
    expect(edited.version).not.toBe(before.version);
    expect(service.state().snapshot.tokens.primary).toBe("#23755a");
    for (const change of changes) expect(await fs.readFile(path.join(service.directory, "installed/personal", change.path), "utf8")).toBe(change.content);
    const undo = service.history()[0];
    const { service: restarted } = await setup(service.directory);
    const current = await restarted.readForEdit("personal");
    await restarted.restore({ historyId: undo.id, expectedRevision: current.revision, expectedVersion: current.version });
    expect((await restarted.readForEdit("personal")).files).toEqual(before.files);
    expect(restarted.state().selection).toEqual({ themeId: "personal", mode: "dark" });
  });
  it("rejects stale revisions, unseen file edits, ID changes and malformed multi-file candidates without losing history", async () => {
    const { service } = await setup();
    await service.install(files());
    const before = await service.readForEdit("custom-theme");
    const request = { themeId: before.themeId, expectedRevision: before.revision, expectedVersion: before.version,
      changes: [{ path: "theme.json", content: "{" }] };
    await expect(service.applyChanges(request)).rejects.toThrow();
    expect(service.history()).toEqual([]);
    expect(await service.exportPackage(before.themeId)).toEqual(before.files);
    const manifest = JSON.parse(Buffer.from(before.files["theme.json"], "base64").toString());
    manifest.name = "Manual edit";
    await fs.writeFile(path.join(service.directory, "installed/custom-theme/theme.json"), JSON.stringify(manifest));
    await expect(service.applyChanges(request)).rejects.toThrow("file conflict");
    await service.select("nuwax-default", "dark");
    await expect(service.applyChanges(request)).rejects.toThrow("revision conflict");
    const fresh = await service.readForEdit(before.themeId);
    manifest.id = "another-theme";
    await expect(service.applyChanges({ ...request, expectedRevision: fresh.revision, expectedVersion: fresh.version,
      changes: [{ path: "theme.json", content: JSON.stringify(manifest) }] })).rejects.toThrow("ID cannot change");
    await expect(service.applyChanges({ ...request, expectedRevision: fresh.revision, expectedVersion: fresh.version,
      changes: [{ path: "../private.json", content: "{}" }] })).rejects.toThrow("unsafe");
    expect(service.history()).toEqual([]);
  });
  it("revocation during staging prevents writes to the active theme and does not create a restore point", async () => {
    let revoked = false, revokeOnStage = false;
    const io = { ...fs, writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      const result = await fs.writeFile(...args);
      if (revokeOnStage && String(args[0]).includes(".stage-")) revoked = true;
      return result;
    } } as typeof fs;
    const { service } = await setup(undefined, { fs: io });
    await service.install(files());
    const before = await service.readForEdit("custom-theme"), state = service.state();
    revokeOnStage = true;
    await expect(service.applyChanges({ themeId: before.themeId, expectedRevision: before.revision, expectedVersion: before.version,
      changes: [{ path: "README.md", content: "Changed" }] }, () => { if (revoked) throw new Error("Revoked"); })).rejects.toThrow("Revoked");
    expect(service.state()).toEqual(state);
    expect((await service.readForEdit(before.themeId)).files).toEqual(before.files);
    expect(service.history()).toEqual([]);
  });
  it("restores the previous directory when durable registry commit fails", async () => {
    let fail = false;
    const io = { ...fs, rename: async (...args: Parameters<typeof fs.rename>) => {
      if (fail && path.basename(String(args[1])) === "registry.json") { fail = false; throw new Error("disk full"); }
      return fs.rename(...args);
    } } as typeof fs;
    const { service } = await setup(undefined, { fs: io });
    await service.install(files());
    const before = await service.readForEdit("custom-theme"), state = service.state();
    fail = true;
    await expect(service.applyChanges({ themeId: before.themeId, expectedRevision: before.revision, expectedVersion: before.version,
      changes: [{ path: "README.md", content: "Changed" }] })).rejects.toThrow("disk full");
    expect(service.state()).toEqual(state);
    expect((await service.readForEdit(before.themeId)).files).toEqual(before.files);
    const { service: restarted } = await setup(service.directory);
    expect(await restarted.exportPackage(before.themeId)).toEqual(before.files);
  });
  it("requires a personal copy for linked/builtin edits and can undo creating that copy", async () => {
    const source = await root();
    await write(source, files());
    const { service } = await setup();
    await service.link(source, async () => true);
    const linked = await service.readForEdit("custom-theme");
    await expect(service.applyChanges({ themeId: linked.themeId, expectedRevision: linked.revision, expectedVersion: linked.version,
      changes: [{ path: "README.md", content: "Changed" }] })).rejects.toThrow("personal theme");
    await service.copyForEdit({ sourceId: linked.themeId, themeId: "personal", name: "Personal", expectedRevision: linked.revision, expectedVersion: linked.version });
    const personal = await service.readForEdit("personal"), history = service.history()[0];
    await service.restore({ historyId: history.id, expectedRevision: personal.revision, expectedVersion: personal.version });
    expect(service.has("personal")).toBe(false);
    expect(await service.readDirectory(source)).toEqual(files());
    await expect(fs.stat(path.join(service.directory, "installed/personal"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("never follows registry or managed-directory symlinks", async () => {
    const directory = await root(),
      outside = await root();
    await fs.writeFile(path.join(outside, "private.txt"), "private payload");
    await fs.symlink(
      path.join(outside, "private.txt"),
      path.join(directory, "registry.json")
    );
    const { service } = await setup(directory);
    expect(service.state().error).toBe("Invalid theme registry");
    await fs.symlink(outside, path.join(directory, "installed"), "junction");
    await expect(service.install(files())).rejects.toThrow("symlink");
    expect(await fs.readFile(path.join(outside, "private.txt"), "utf8")).toBe(
      "private payload"
    );
    expect(await fs.readdir(outside)).toEqual(["private.txt"]);
  });
  it("starts with official CSS in recovery mode without losing the saved selection", async () => {
    const { service } = await setup();
    await service.install(files());
    await service.select("custom-theme", "dark");
    const { service: safe } = await setup(service.directory, {
      safeMode: true,
    });
    expect(safe.state()).toMatchObject({
      recovery: true,
      selection: { themeId: "custom-theme", mode: "dark" },
      snapshot: { themeId: "nuwax-default", mode: "dark" },
    });
    const { service: restarted } = await setup(service.directory);
    expect(restarted.state().snapshot.themeId).toBe("custom-theme");
  });
  it("updates system appearance without a storage write or resetting the selection", async () => {
    let dark = false,
      fail = false;
    const io = {
      ...fs,
      writeFile: vi.fn(async (...args: Parameters<typeof fs.writeFile>) => {
        if (fail) throw new Error("disk full");
        return fs.writeFile(...args);
      }),
    } as typeof fs;
    const { service } = await setup(undefined, {
      fs: io,
      systemDark: () => dark,
    });
    await service.select("nuwax-default", "system");
    fail = true;
    dark = true;
    await service.systemChanged();
    expect(service.state().snapshot.mode).toBe("dark");
    expect(service.state().selection.mode).toBe("system");
    expect(service.state().error).toBeUndefined();
  });
  it.each(["light", "dark"] as const)("keeps forced %s appearance across system changes and uses a single variant automatically", async mode => {
    let dark = mode === "dark";
    const { service, deps } = await setup(undefined, { systemDark: () => dark });
    await service.select("nuwax-default", mode);
    const revision = service.state().revision;
    dark = !dark;
    await service.systemChanged();
    expect(service.state()).toMatchObject({ revision, selection: { mode }, snapshot: { mode } });
    expect(deps.applyPreference).toHaveBeenLastCalledWith(mode);

    const single = files();
    const manifest = JSON.parse(Buffer.from(single["theme.json"], "base64").toString());
    delete manifest.variants[mode === "light" ? "dark" : "light"];
    single["theme.json"] = Buffer.from(JSON.stringify(manifest)).toString("base64");
    await service.install(single);
    await service.select("custom-theme", "system");
    expect(service.state()).toMatchObject({ selection: { mode }, snapshot: { mode } });
    dark = !dark;
    await service.systemChanged();
    expect(service.state().snapshot.mode).toBe(mode);
  });
  it("installs, rejects duplicates, confirms replacement, exports cache and persists explicit selection", async () => {
    const { service } = await setup();
    expect(service.state()).toMatchObject({
      revision: 1,
      hasUserSelection: false,
      selection: { mode: "light" },
    });
    expect((await service.install(files())).ok).toBe(true);
    expect(await service.install(files())).toMatchObject({ conflict: true });
    const cancel = vi.fn(async () => false);
    expect(
      await service.install(files("custom-theme", "New"), true, cancel)
    ).toMatchObject({ canceled: true });
    await service.install(files("custom-theme", "New"), true);
    expect(await service.exportPackage("custom-theme")).toEqual(
      files("custom-theme", "New")
    );
    await service.select("custom-theme", "dark");
    const conditional = await service.select("nuwax-default", "light", true);
    expect(conditional).toMatchObject({
      conflict: true,
      state: { selection: { themeId: "custom-theme", mode: "dark" } },
    });
    const restarted = await setup(service.directory);
    expect(restarted.service.state()).toMatchObject({
      hasUserSelection: true,
      selection: { themeId: "custom-theme", mode: "dark" },
    });
    await service.remove("custom-theme");
    expect(service.state().selection.themeId).toBe("nuwax-default");
    await expect(
      fs.stat(path.join(service.directory, "installed/custom-theme"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("serializes migration behind the newest explicit choice and normalizes single mode", async () => {
    const { service } = await setup();
    const value = files();
    const manifest = JSON.parse(
      Buffer.from(value["theme.json"], "base64").toString()
    );
    delete manifest.variants.dark;
    value["theme.json"] = Buffer.from(JSON.stringify(manifest)).toString(
      "base64"
    );
    await service.install(value);
    const chosen = service.select("custom-theme", "dark");
    const migration = service.select("nuwax-default", "system", true);
    await chosen;
    expect(await migration).toMatchObject({ conflict: true });
    expect(service.state().selection.mode).toBe("light");
  });
  it("watches edits without sleeps, retains invalid/offline cache on restart and repairs; unlink retains source", async () => {
    const source = await root();
    await write(source, files());
    const { service, callbacks, closed } = await setup();
    await service.link(source, async () => true);
    vi.useFakeTimers();
    await write(source, files("custom-theme", "Edited"));
    callbacks.get(await fs.realpath(source))!();
    await vi.advanceTimersByTimeAsync(200);
    await service.reload("custom-theme");
    expect(
      service.state().themes.find((t) => t.id === "custom-theme")?.name
    ).toBe("Edited");
    await fs.writeFile(path.join(source, "theme.json"), "{");
    await service.reload("custom-theme");
    expect(service.state().error).toBeTruthy();
    expect(await service.exportPackage("custom-theme")).toEqual(
      files("custom-theme", "Edited")
    );
    const restarted = (await setup(service.directory)).service;
    expect(restarted.state().error).toBeTruthy();
    expect(await restarted.exportPackage("custom-theme")).toEqual(
      files("custom-theme", "Edited")
    );
    await write(source, files("custom-theme", "Repaired"));
    await restarted.reload("custom-theme");
    expect(restarted.state().error).toBeUndefined();
    await fs.rm(source, { recursive: true });
    await restarted.reload("custom-theme");
    expect(restarted.state().error).toBeTruthy();
    await write(source, files());
    await restarted.reload("custom-theme");
    await restarted.remove("custom-theme");
    expect(await fs.stat(source)).toBeTruthy();
    await service.dispose();
    expect(closed).toHaveBeenCalled();
  });
  it("rejects reserved IDs, symlink roots/descendants and oversized files before reading", async () => {
    const { service } = await setup();
    await expect(service.install(officialThemePackage.files)).rejects.toThrow(
      "reserved"
    );
    await expect(service.remove("deepseek-inspired")).rejects.toThrow(
      "reserved"
    );
    const source = await root();
    await write(source, files());
    const parent = await root();
    const alias = path.join(parent, "alias");
    await fs.symlink(source, alias);
    await expect(service.link(alias, async () => true)).rejects.toThrow(
      "real directory"
    );
    await fs.symlink(
      path.join(source, "light.json"),
      path.join(source, "alias.json")
    );
    await expect(service.readDirectory(source)).rejects.toThrow("symlinks");
    await fs.unlink(path.join(source, "alias.json"));
    const big = await fs.open(path.join(source, "large.css"), "w");
    await big.truncate(limits.fileBytes + 1);
    await big.close();
    await expect(service.readDirectory(source)).rejects.toThrow("limit");
  });
  it.each(["write", "rename", "registry"])(
    "rolls back disk and visible state on %s failure",
    async (failure) => {
      let fail = false;
      const io = {
        ...fs,
        writeFile: vi.fn(async (...args: Parameters<typeof fs.writeFile>) => {
          if (
            fail &&
            failure === "write" &&
            String(args[0]).includes(".stage-")
          )
            throw new Error("injected");
          return fs.writeFile(...args);
        }),
        rename: vi.fn(async (...args: Parameters<typeof fs.rename>) => {
          if (
            fail &&
            ((failure === "registry" &&
              String(args[1]).endsWith("registry.json")) ||
              (failure === "rename" && String(args[0]).includes(".stage-")))
          )
            throw new Error("injected");
          return fs.rename(...args);
        }),
      } as typeof fs;
      const { service } = await setup(undefined, { fs: io });
      await service.install(files());
      await service.select("custom-theme", "dark");
      const before = service.state(),
        registry = await fs.readFile(
          path.join(service.directory, "registry.json"),
          "utf8"
        );
      fail = true;
      await expect(
        service.install(files("custom-theme", "Replacement"), true)
      ).rejects.toThrow("injected");
      expect(service.state()).toEqual(before);
      expect(
        await fs.readFile(path.join(service.directory, "registry.json"), "utf8")
      ).toBe(registry);
      expect(
        await fs.readFile(
          path.join(service.directory, "installed/custom-theme/theme.json"),
          "base64"
        )
      ).toBe(files()["theme.json"]);
    }
  );
  it("tracks system mode, persists revisions and retains errors for other invalid themes", async () => {
    let dark = false;
    const { service, deps } = await setup(undefined, {
      systemDark: () => dark,
    });
    await service.select("nuwax-default", "system");
    expect(service.state().snapshot.mode).toBe("light");
    dark = true;
    expect(service.state().snapshot.mode).toBe("light");
    await service.systemChanged();
    expect(service.state().snapshot.mode).toBe("dark");
    expect(deps.applyPreference).toHaveBeenLastCalledWith("system");
    const source = await root();
    await write(source, files());
    await service.link(source, async () => true);
    await fs.writeFile(path.join(source, "theme.json"), "{}");
    await service.reload("custom-theme");
    const revision = service.state().revision;
    await service.select("deepseek-inspired", "light");
    expect(service.state().error).toBeTruthy();
    const restarted = (await setup(service.directory)).service;
    expect(restarted.state().revision).toBeGreaterThan(revision);
  });
  it("rolls back managed-to-linked replacement/removal failures and preserves a selected managed source", async () => {
    let fail = false;
    const io = {
      ...fs,
      rename: async (...args: Parameters<typeof fs.rename>) => {
        if (fail && String(args[1]).endsWith("registry.json"))
          throw new Error("registry failure");
        return fs.rename(...args);
      },
    } as typeof fs;
    const { service } = await setup(undefined, { fs: io });
    await service.install(files());
    const before = service.state();
    const source = await root();
    await write(source, files("custom-theme", "Linked"));
    fail = true;
    await expect(service.link(source, async () => true)).rejects.toThrow(
      "registry failure"
    );
    expect(service.state()).toEqual(before);
    expect(
      await fs.stat(path.join(service.directory, "installed/custom-theme"))
    ).toBeTruthy();
    await expect(service.remove("custom-theme")).rejects.toThrow(
      "registry failure"
    );
    expect(service.state()).toEqual(before);
    fail = false;
    const installed = path.join(service.directory, "installed/custom-theme");
    await service.link(installed, async () => true);
    await service.remove("custom-theme");
    expect(await fs.stat(installed)).toBeTruthy();
    expect(await fs.stat(source)).toBeTruthy();
  });
  it("starts readable with official/error state on permission failure", async () => {
    const { service } = await setup(undefined, {
      fs: {
        ...fs,
        lstat: async () => {
          throw Object.assign(new Error("private absolute path"), {
            code: "EACCES",
          });
        },
      } as unknown as typeof fs,
    });
    expect(service.state()).toMatchObject({
      error: "Theme storage unavailable",
      snapshot: { themeId: "nuwax-default" },
    });
  });
});
