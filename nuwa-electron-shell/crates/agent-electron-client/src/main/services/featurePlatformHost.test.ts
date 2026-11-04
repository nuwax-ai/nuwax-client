import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ ticket: "fixture-ticket" as string | null, epoch: 1, origin: "https://tenant.example", fetch: vi.fn() }));
vi.mock("electron", () => ({ net: { fetch: state.fetch } }));
vi.mock("./commercialLocalPorts", () => ({ initializeCommercialLocalPorts: () => undefined }));
vi.mock("../db", () => ({ readSetting: () => "uid:fixture" }));
vi.mock("./commercialTicketSession", () => ({ currentTicket: () => state.ticket, ticketEpoch: () => state.epoch }));
vi.mock("./commercialSessionScope", () => ({ currentBusinessOrigin: () => state.origin }));
vi.mock("./nativeTicketCapability", () => ({ nativeTicketHeaders: (ticket: string) => ({ Cookie: "ticket=" + ticket, "x-nuwax-native-ticket": "fixture-capability" }) }));
vi.mock("./system/dependencies", () => ({ getAppEnv: () => ({ PATH: "/bin", HTTPS_PROXY: "http://proxy.example", OPENAI_API_KEY: "must-not-enter-child", DSH_HOME: "/personal/dsh", NUWAX_DSH_RUN_TOKEN: "old-token" }) }));
import { createFeaturePlatformHost } from "./featurePlatformHost";
describe("plugin platform authority", () => {
  beforeEach(() => { state.ticket = "fixture-ticket"; state.epoch = 1; state.fetch.mockReset(); });
  it("uses the main ticket only on allowed platform routes and drops ambient credentials", async () => {
    const host = createFeaturePlatformHost();
    state.fetch.mockResolvedValue({ ok: true, json: async () => ({ success: true, data: [{ id: 12 }] }) });
    await expect(host.request(host.scope()!, "/api/model/my?tab=System")).resolves.toEqual([{ id: 12 }]);
    const [url, options] = state.fetch.mock.calls[0];
    expect(url).toBe("https://tenant.example/api/model/my?tab=System");
    expect(options.headers.Cookie).toBe("ticket=fixture-ticket");
    expect(host.environment()).toEqual({ PATH: "/bin", HTTPS_PROXY: "http://proxy.example" });
    await expect(host.request(host.scope()!, "https://external.example/api/tenant/config")).rejects.toThrow("not authorized");
    await expect(host.request(host.scope()!, "/api/user/all")).rejects.toThrow("not authorized");
    expect(state.fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects a delayed platform response after account invalidation", async () => {
    const host = createFeaturePlatformHost();
    let complete!: (value: unknown) => void;
    state.fetch.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    const pending = host.request(host.scope()!, "/api/user/api-key/list");
    state.epoch++;
    complete({ ok: true, json: async () => ({ success: true, data: "must-not-reach-old-scope" }) });
    await expect(pending).rejects.toThrow("Account changed");
    state.ticket = null;
    expect(host.scope()).toBeNull();
  });
});
