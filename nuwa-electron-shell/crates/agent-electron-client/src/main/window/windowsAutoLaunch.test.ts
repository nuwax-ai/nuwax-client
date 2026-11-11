import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ app: {}, shell: { readShortcutLink: vi.fn() } }));
vi.mock("@shared/constants", () => ({ APP_NAME_IDENTIFIER: "nuwax" }));
import { shell } from "electron";
import fs from "node:fs/promises";
import {
  createWindowsStartupStore,
  isOwnedStartupEntry,
  removeOwnedWindowsStartup,
  startupCommandTarget,
  type StartupEntry,
} from "./windowsAutoLaunch";

const current = "C:\\Users\\test\\Programs\\Nuwax\\Nuwax.exe";
const legacy = "D:\\Old Installation\\Nuwax.exe";
const item = (overrides: Partial<StartupEntry> = {}): StartupEntry => ({
  kind: "run",
  name: "com.nuwax-ai.nuwax",
  target: legacy,
  ...overrides,
});
afterEach(() => vi.restoreAllMocks());

function startupFixture(badName: string) {
  const folder = "C:\\fixture\\Startup";
  let names = [badName, "owned-alias.lnk"];
  let registry = [
    {
      kind: "run",
      name: "com.nuwax-ai.nuwax",
      command: `"${legacy}" --hidden`,
      hive: "CurrentUser",
      view: "Registry64",
    },
  ];
  vi.spyOn(fs, "lstat").mockImplementation(
    async () => ({ isSymbolicLink: () => false, isFile: () => true }) as any,
  );
  vi.spyOn(fs, "readdir").mockImplementation(async () => [...names] as any);
  const unlink = vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
    names = names.filter((name) => !String(file).endsWith(name));
  });
  vi.mocked(shell.readShortcutLink).mockImplementation((file) => {
    if (file.endsWith(badName)) throw Object.assign(new Error("unreadable shortcut"), { code: badName.startsWith("denied-") ? "EACCES" : "EINVAL" });
    return { target: legacy, appUserModelId: "com.nuwax-ai.nuwax" } as any;
  });
  const run = vi.fn(async (script) => {
    if (script.includes("$entries=@()")) return JSON.stringify(registry);
    registry = [];
    return "";
  });
  return {
    store: createWindowsStartupStore([folder], run),
    unlink,
    remainingRegistry: () => registry,
    remainingLinks: () => names,
  };
}

describe("Windows product startup ownership", () => {
  it.each(["broken-calendar.lnk", "denied-editor.lnk", "NuwaClaw.lnk", "女娲 NuwaClaw.lnk"])(
    "an unrelated unreadable %s does not prevent removing the product Run entry and shortcut",
    async (badName) => {
      const fixture = startupFixture(badName);
      await removeOwnedWindowsStartup(fixture.store, [current]);
      expect(fixture.remainingRegistry()).toEqual([]);
      expect(fixture.remainingLinks()).toEqual([badName]);
      expect(fixture.unlink).toHaveBeenCalledTimes(1);
    },
  );

  it("cleans readable owned entries but reports failure for an unreadable product-named shortcut", async () => {
    const fixture = startupFixture("Nuwax.lnk");
    await expect(
      removeOwnedWindowsStartup(fixture.store, [current]),
    ).rejects.toThrow();
    expect(fixture.remainingRegistry()).toEqual([]);
    expect(fixture.remainingLinks()).toEqual(["Nuwax.lnk"]);
    expect(fixture.unlink).toHaveBeenCalledTimes(1);
  });

  it("reports a previously identified custom product alias becoming unreadable without deleting it or blocking Run cleanup", async () => {
    const fixture = startupFixture("unrelated.lnk");
    let reads = 0;
    vi.mocked(shell.readShortcutLink).mockImplementation((file) => {
      if (file.endsWith("unrelated.lnk"))
        throw new Error("unrelated broken alias");
      if (++reads > 1) throw new Error("owned alias became unreadable");
      return { target: legacy, appUserModelId: "com.nuwax-ai.nuwax" } as any;
    });
    await expect(
      removeOwnedWindowsStartup(fixture.store, [current]),
    ).rejects.toThrow("became unreadable");
    expect(fixture.remainingRegistry()).toEqual([]);
    expect(fixture.unlink).not.toHaveBeenCalled();
    expect(
      (await fixture.store.list()).some(
        (entry) => entry.name === "owned-alias.lnk" && entry.unreadable,
      ),
    ).toBe(true);
  });
  it("passes registry value data without interpreting quotes, Unicode, or shell syntax", async () => {
    const command = '"D:\\旧路径\\Nuwax.exe" --hidden $(not-a-command)';
    const run = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            kind: "run",
            name: "com.nuwax-ai.nuwax",
            command,
            hive: "CurrentUser",
            view: "Registry64",
          },
        ]),
      )
      .mockResolvedValue("");
    const store = createWindowsStartupStore([], run);
    const entries = await store.list();
    expect(entries[0].target).toBe("D:\\旧路径\\Nuwax.exe");
    await store.remove(entries[0]);
    const script = run.mock.calls[1][0];
    const encoded = script.match(/FromBase64String\('([^']+)'\)/)?.[1];
    expect(
      JSON.parse(Buffer.from(encoded!, "base64").toString("utf8")).command,
    ).toBe(command);
    expect(script).not.toContain("$(not-a-command)");
  });

  it("does not unlink a startup shortcut retargeted after enumeration", async () => {
    const unlink = vi.spyOn(fs, "unlink").mockResolvedValue(undefined);
    try {
      vi.mocked(shell.readShortcutLink).mockReturnValue({
        target: "C:\\Other\\Other.exe",
      } as any);
      await expect(
        createWindowsStartupStore([]).remove(
          item({ kind: "shortcut", command: "C:\\fixture\\Nuwax.lnk" }),
        ),
      ).rejects.toThrow("changed");
      expect(unlink).not.toHaveBeenCalled();
    } finally {
      unlink.mockRestore();
    }
  });
  it("removes historical product entries across scopes and shortcuts while preserving other apps and dev profiles", async () => {
    const owned = [
      item(),
      item({ hive: "LocalMachine", view: "Registry32" }),
      item({ name: "electron.app.Nuwax" }),
      item({ name: "electron.app.女娲 Nuwax" }),
      item({
        kind: "shortcut",
        name: "custom.lnk",
        appId: "com.nuwax-ai.nuwax",
      }),
      item({ name: "Nuwax", target: current }),
      item({ name: "女娲 Nuwax", target: current }),
      item({ name: "女娲 NuwaClaw", target: current }),
    ];
    const others = [
      item({ name: "Other", target: current }),
      item({ name: "com.nuwax-ai.nuwax.dev" }),
      item({ name: "electron.app.Nuwax.dev" }),
      item({ name: "electron.app.NuwaClaw", target: "C:\\Program Files\\NuwaClaw\\NuwaClaw.exe" }),
      item({ name: "electron.app.Nuwax", target: "D:\\Other\\Other.exe" }),
      item({ target: "D:\\Old\\NuwaClaw.exe" }),
      item({ target: "\\\\server\\Nuwax.exe" }),
      item({ name: "Nuwax" }),
      item({
        kind: "shortcut",
        name: "Nuwax.lnk",
        target: current,
        appId: "com.nuwax-ai.nuwax.dev",
      }),
    ];
    let entries = [...owned, ...others];
    const remove = vi.fn(async (entry: StartupEntry) => {
      entries = entries.filter((value) => value !== entry);
    });
    await removeOwnedWindowsStartup({ list: async () => entries, remove }, [
      current,
    ]);
    expect(remove).toHaveBeenCalledTimes(owned.length);
    expect(entries).toEqual(others);
    for (const entry of others)
      expect(isOwnedStartupEntry(entry, [current])).toBe(false);
  });

  it("does not report success when a protected machine entry remains or removal fails", async () => {
    await expect(
      removeOwnedWindowsStartup(
        { list: async () => [item()], remove: async () => undefined },
        [current],
      ),
    ).rejects.toThrow("remain");
    await expect(
      removeOwnedWindowsStartup(
        {
          list: async () => [item()],
          remove: async () => {
            throw new Error("access denied");
          },
        },
        [current],
      ),
    ).rejects.toThrow("access denied");
  });

  it("parses only unambiguous executable targets without executing command text", () => {
    expect(
      startupCommandTarget('"D:\\Old Installation\\Nuwax.exe" --hidden'),
    ).toBe(legacy);
    expect(startupCommandTarget("D:\\Nuwax\\Nuwax.exe --hidden")).toBe(
      "D:\\Nuwax\\Nuwax.exe",
    );
    expect(
      startupCommandTarget("D:\\Old Installation\\Nuwax.exe --hidden"),
    ).toBe("");
    expect(startupCommandTarget("cmd.exe /c Nuwax.exe")).toBe("");
  });
});
