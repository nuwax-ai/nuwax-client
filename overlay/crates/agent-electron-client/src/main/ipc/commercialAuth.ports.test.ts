import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ settings: new Map<string, unknown>(), fetch: vi.fn(), writes: vi.fn() }));
vi.mock("electron", () => ({ app: { isPackaged: true }, net: { fetch: (...args: unknown[]) => state.fetch(...args) } }));
vi.mock("electron-log", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../db", () => ({ readSetting: (key: string) => state.settings.get(key),
  writeSetting: (key: string, value: unknown) => { state.writes(key, value); state.settings.set(key, value); },
  getDb: () => ({ prepare: () => ({ run: vi.fn() }) }) }));
vi.mock("@shared/constants", async (importOriginal) => ({ ...await importOriginal<typeof import("@shared/constants")>(), APP_NAME_IDENTIFIER: "nuwax" }));
vi.mock("../services/commercialSessionScope", () => ({ currentBusinessOrigin: () => "https://business.example" }));
vi.mock("../services/commercialTicketSession", () => ({ currentTicket: () => "test-ticket", ticketEpoch: () => 1,
  mirrorNativeResponseTicket: async () => {} }));
vi.mock("../services/nativeTicketCapability", () => ({ nativeTicketHeaders: () => ({ Cookie: "ticket=test-ticket" }) }));
vi.mock("../services/system/deviceId", () => ({ getDeviceId: () => "device" }));
vi.mock("../features", () => ({ emitFeatureSessionInvalidated: vi.fn(),
  runFeatureServicesStopping: async () => ({ success: true }), settleDesktopFeaturesForQuit: async () => {} }));
import { initializeCommercialAuth } from "./commercialAuth";
import { LocalPortManager, setLocalPortManager } from "../services/localPorts";

let ports: LocalPortManager;
function registration(key = "new-key") {
  return { ok: true, status: 200, json: async () => ({ code: "0000",
    data: { configKey: key, serverHost: "tunnel.example", serverPort: 4900 } }) };
}
beforeEach(() => {
  state.settings.clear(); state.writes.mockClear(); state.fetch.mockReset();
  state.settings.set("nuwax.cookieAuthMigrated", true);
  state.settings.set("nuwax.registrationDeviceId", "device");
  state.settings.set("step1_config", { serverHost: "https://business.example", agentPort: 61006, fileServerPort: 61005, ttydPort: 61009 });
  ports = new LocalPortManager({ ranges: [[24600, 24610]], bind: async () => ({ close: async () => {} }) });
  setLocalPortManager(ports);
  state.fetch.mockImplementation(async (url: string) => url.endsWith("getLoginInfo")
    ? { ok: true, status: 200, json: async () => ({ code: "0000", data: { userName: "test-account", id: 1 } }) }
    : registration());
});
afterEach(async () => { await ports.dispose(); setLocalPortManager(undefined); });
function flow() {
  return initializeCommercialAuth(async () => ({ success: true }), async () => ({ success: true }), () => {});
}
function requests() {
  return state.fetch.mock.calls.filter(([url]) => String(url).endsWith("reg/v2"))
    .map(([, options]) => JSON.parse(options.body).sandboxConfigValue);
}
describe("commercial runtime port registration", () => {
  it("registers allocated loopback endpoints and ignores all legacy configured port numbers", async () => {
    await flow().sync();
    expect(requests()[0]).toMatchObject({ hostWithScheme: "http://127.0.0.1", agentPort: 24600,
      adminServerPort: 24600, fileServerPort: 24601, ttydPort: 24602 });
  });
  it("commits the new file endpoint before the tunnel publish callback completes", async () => {
    const lifecycle = flow(); await lifecycle.sync();
    const old = ports.get("fileServer")!.port;
    await ports.start("fileServer", async (port) => port === old
      ? { success: false, errorCode: "EADDRINUSE" } : { success: true }, async () => {});
    await ports.beforePublish();
    expect(requests()).toHaveLength(2);
    expect(requests()[1].fileServerPort).toBe(ports.get("fileServer")!.port);
    expect(requests()[1].fileServerPort).not.toBe(old);
    expect(state.settings.get("auth.config_key")).toBe("new-key");
  });
  it("never commits a registration response whose port generation became stale", async () => {
    let complete!: (response: ReturnType<typeof registration>) => void;
    let registrations = 0;
    const normal = state.fetch.getMockImplementation()!;
    state.fetch.mockImplementation((url: string) => {
      if (!url.endsWith("reg/v2")) return normal(url);
      registrations++;
      return registrations === 1 ? new Promise((resolve) => { complete = resolve; }) : Promise.resolve(registration("fresh-key"));
    });
    const pending = flow().sync();
    await vi.waitFor(() => expect(registrations).toBe(1));
    await ports.reserve("gateway"); complete(registration("stale-key"));
    await pending;
    expect(registrations).toBe(2);
    expect(state.writes.mock.calls).not.toContainEqual(["auth.config_key", "stale-key"]);
    expect(state.settings.get("auth.config_key")).toBe("fresh-key");
  });
});
