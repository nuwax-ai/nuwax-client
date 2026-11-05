import { describe, expect, it, vi } from "vitest";
import { DSH_LAUNCHER_OPEN, DSH_LAUNCHER_STATE } from "@shared/features/dsh-runtime/contract";
import type { FeatureContext } from "../_kit/types";
import { createTrustedIpc } from "../_kit/trustedIpc";
import { registerDshLauncher } from "./launcher";

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
