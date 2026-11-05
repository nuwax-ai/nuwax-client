import { describe, expect, it, vi } from "vitest";
import { DSH_LAUNCHER_OPEN, DSH_LAUNCHER_STATE, DSH_PLUGINS_IPC } from "@shared/features/dsh-runtime/contract";
import type { FeatureContext } from "../_kit/types";
import { createTrustedIpc } from "../_kit/trustedIpc";
import { registerDshLauncher, registerDshPluginSettings } from "./launcher";

function fixture() {
  const handlers = new Map<string, (event: unknown) => unknown>();
  const session = { isAuthenticated: vi.fn(() => true) };
  let epoch = 1;
  const ipc = createTrustedIpc({
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: channel => { handlers.delete(channel); },
  }, event => event === "trusted");
  const runtime = { enabled: vi.fn(() => true) };
  const ports = { load: vi.fn(async () => runtime), open: vi.fn(async () => {}) };
  registerDshLauncher({ ipc, session, platform: { scope: () => ({ accountId: "fixture", origin: "https://fixture.example", epoch }) } } as unknown as FeatureContext, ports);
  return { handlers, session, runtime, ports, changeAccount: () => { epoch++; }, call: (channel: string, event = "trusted") => handlers.get(channel)!(event) };
}

describe("DS-Bot business launcher", () => {
  it("does not load or open for untrusted documents or logged out sessions", async () => {
    const f = fixture();
    expect(await f.call(DSH_LAUNCHER_STATE, "untrusted")).toBeNull();
    expect(await f.call(DSH_LAUNCHER_OPEN, "untrusted")).toEqual({ ok: false });
    f.session.isAuthenticated.mockReturnValue(false);
    expect(await f.call(DSH_LAUNCHER_STATE)).toBeNull();
    expect(await f.call(DSH_LAUNCHER_OPEN)).toEqual({ ok: false });
    expect(f.ports.load).not.toHaveBeenCalled();
    expect(f.ports.open).not.toHaveBeenCalled();
  });

  it("only opens an already enabled runtime and rejects account changes while loading", async () => {
    const f = fixture();
    f.runtime.enabled.mockReturnValue(false);
    expect(await f.call(DSH_LAUNCHER_STATE)).toEqual({ enabled: false });
    expect(await f.call(DSH_LAUNCHER_OPEN)).toEqual({ ok: false });
    expect(f.ports.open).not.toHaveBeenCalled();
    f.runtime.enabled.mockReturnValue(true);
    expect(await f.call(DSH_LAUNCHER_OPEN)).toEqual({ ok: true });
    expect(f.ports.open).toHaveBeenCalledOnce();
    f.ports.load.mockImplementation(async () => { f.changeAccount(); return f.runtime; });
    expect(await f.call(DSH_LAUNCHER_STATE)).toBeNull();
    expect(await f.call(DSH_LAUNCHER_OPEN)).toEqual({ ok: false });
    expect(f.ports.open).toHaveBeenCalledOnce();
  });

  it("returns safe results when the runtime is unavailable", async () => {
    const f = fixture();
    f.ports.load.mockRejectedValue(new Error("runtime unavailable"));
    expect(await f.call(DSH_LAUNCHER_STATE)).toBeNull();
    expect(await f.call(DSH_LAUNCHER_OPEN)).toEqual({ ok: false });
    expect(f.ports.open).not.toHaveBeenCalled();
  });
});

it("plugin settings remain host-only and require a running authenticated account", async () => {
  let invoke: (event: unknown, ...args: unknown[]) => unknown = () => {};
  const hostIpc = createTrustedIpc({ handle: (channel, handler) => { expect(channel).toBe(DSH_PLUGINS_IPC); invoke = handler; }, removeHandler() {} }, event => event === "host");
  const controller = { current: vi.fn(() => true), plugins: vi.fn(async () => ({ bundles: [] })) };
  const session = { isAuthenticated: vi.fn(() => true) };
  registerDshPluginSettings({ hostIpc, session } as unknown as FeatureContext, () => controller);
  expect(await invoke("business", "install", { target: "fixture" })).toEqual({ ok: false, error: "Untrusted window" });
  session.isAuthenticated.mockReturnValue(false);
  expect(await invoke("host", "install", { target: "fixture" })).toMatchObject({ ok: false });
  session.isAuthenticated.mockReturnValue(true); controller.current.mockReturnValue(false);
  expect(await invoke("host", "install", { target: "fixture" })).toMatchObject({ ok: false });
  controller.current.mockReturnValue(true);
  expect(await invoke("host", "authorize", {})).toMatchObject({ ok: false });
  expect(controller.plugins).not.toHaveBeenCalled();
  expect(await invoke("host", "list")).toEqual({ ok: true, value: { bundles: [] } });
  expect(controller.plugins).toHaveBeenCalledWith("list", {}, expect.any(AbortSignal));
});
