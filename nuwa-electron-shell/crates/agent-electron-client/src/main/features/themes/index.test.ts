import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
vi.mock("electron", () => ({
  dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn() },
  shell: { openPath: vi.fn(async () => "") },
  nativeTheme: Object.assign(new EventEmitter(), {
    themeSource: "light",
    shouldUseDarkColors: false,
  }),
}));
import { dialog, nativeTheme } from "electron";
import { ThemesRuntime } from "./index";
import { createTrustedIpc } from "../_kit/trustedIpc";
import type { FeatureContext } from "../_kit/types";
import type { HostThemeFiles } from "@shared/types/hostBridge";
import { officialThemePackage } from "@shared/features/themes/core";

const runtimes: ThemesRuntime[] = [],
  dirs: string[] = [];
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.dispose();
  for (const dir of dirs.splice(0))
    await fs.rm(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});
async function setup() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "themes-ipc-"));
  dirs.push(dataDir);
  const handlers = new Map<string, (...args: any[]) => any>();
  const main = {
    handle: (ch: string, run: any) => {
      handlers.set(ch, run);
    },
    removeHandler: (ch: string) => {
      handlers.delete(ch);
    },
  };
  const ctx = {
    dataDir,
    ipc: createTrustedIpc(main, (e: any) => e.business === true),
    hostIpc: createTrustedIpc(main, (e: any) => e.host === true),
    settings: { write: vi.fn(() => true) },
    log: { warn: vi.fn() },
  } as unknown as FeatureContext;
  const runtime = new ThemesRuntime(ctx);
  runtimes.push(runtime);
  await runtime.service.ready;
  const sender = Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  });
  return { handlers, sender, runtime, ctx };
}
describe("trusted themes IPC", () => {
  it("denies untrusted/cross-namespace reads and mutations; every read checks current trust", async () => {
    const { handlers, sender, runtime } = await setup();
    const event = { sender, business: false, host: false };
    expect(await handlers.get("themes:getState")!(event)).toBeNull();
    expect(
      await handlers.get("themes:install")!(event, officialThemePackage.files)
    ).toMatchObject({ ok: false });
    event.business = true;
    expect(await handlers.get("themes:getState")!(event)).toMatchObject({
      revision: 1,
    });
    expect(await handlers.get("host:themes:getState")!(event)).toBeNull();
    expect((await handlers.get("themes:getState")!(event, { previews: true })).themes[0].preview).toBeUndefined();
    event.host = true;
    expect((await handlers.get("host:themes:getState")!(event)).themes[0].preview).toMatchObject({ mode: "light", tokens: { primary: expect.any(String) } });
    event.host = false;
    event.business = false;
    expect(await handlers.get("themes:getState")!(event)).toBeNull();
    await runtime.service.select("deepseek-inspired", "dark");
    expect(sender.send.mock.calls).toEqual([["themes:changed", 2]]);
    sender.emit("destroyed");
    await runtime.service.select("nuwax-default", "light");
    expect(sender.send).toHaveBeenCalledTimes(1);
    await runtime.dispose();
    expect(handlers.size).toBe(0);
    expect(nativeTheme.listenerCount("updated")).toBe(0);
  });
  it("native picker does not accept webpage paths and replacement requires native confirmation", async () => {
    const { handlers, sender, runtime } = await setup();
    const event = { business: true, sender };
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: true,
      filePaths: [],
    });
    expect(
      await handlers.get("themes:linkDirectory")!(event, "/untrusted/path")
    ).toMatchObject({ canceled: true });
    expect(dialog.showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({ properties: ["openDirectory"] })
    );
    const files = { ...officialThemePackage.files } as HostThemeFiles;
    const manifest = JSON.parse(
      Buffer.from(files["theme.json"], "base64").toString()
    );
    manifest.id = "custom";
    files["theme.json"] = Buffer.from(JSON.stringify(manifest)).toString(
      "base64"
    );
    await handlers.get("themes:install")!(event, files);
    vi.mocked(dialog.showMessageBox).mockResolvedValue({
      response: 0,
      checkboxChecked: false,
    });
    expect(
      await handlers.get("themes:install")!(event, files, true)
    ).toMatchObject({ ok: true });
    // replace=true 表示主题面板已经确认，主进程不再重复弹窗。
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(
      runtime.service.state().themes.find((t) => t.id === "custom")
    ).toBeTruthy();
  });
});
