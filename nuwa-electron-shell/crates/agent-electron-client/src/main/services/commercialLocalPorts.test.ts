import { afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ settings: new Map<string, unknown>() }));
vi.mock("../db", () => ({ readSetting: (key: string) => state.settings.get(key),
  writeSetting: (key: string, value: unknown) => state.settings.set(key, value) }));
vi.mock("@shared/constants", () => ({ APP_NAME_IDENTIFIER: "nuwax" }));
vi.mock("electron-log", () => ({ default: { info: vi.fn() } }));
import { initializeCommercialLocalPorts, sanitizeCommercialPortSetting, projectCommercialPortSetting, AUTOMATIC_PORTS_KEY } from "./commercialLocalPorts";
import { getLocalPortManager, setLocalPortManager, LocalPortManager } from "./localPorts";
afterEach(async () => { await getLocalPortManager()?.dispose(); setLocalPortManager(undefined); state.settings.clear(); });
describe("commercial port migration", () => {
  it("removes all old local port controls and preserves workspace, host and remote tunnel settings", () => {
    state.settings.set("step1_config", { agentPort: 61006, fileServerPort: 24605, ttydPort: 1,
      gatewayPort: 46800, workspaceDir: "/workspace", serverHost: "https://enterprise.example" });
    state.settings.set("agent_config", { backendPort: 60006, proxyPort: 60002, model: "model" });
    state.settings.set("lanproxy_config", { serverPort: 4900, serverIp: "remote.example" });
    state.settings.set("mcp_proxy_port", 19099);
    initializeCommercialLocalPorts();
    expect(state.settings.get("step1_config")).toEqual({ workspaceDir: "/workspace", serverHost: "https://enterprise.example" });
    expect(state.settings.get("agent_config")).toEqual({ model: "model" });
    expect(state.settings.get("lanproxy_config")).toEqual({ serverPort: 4900, serverIp: "remote.example" });
    expect(state.settings.get("mcp_proxy_port")).toBeNull();
  });
  it("projects actual runtime ports for old renderers without saving them as preferences", async () => {
    const ports = new LocalPortManager({ ranges: [[24600, 24603]], bind: async () => ({ close: async () => {} }) });
    setLocalPortManager(ports);
    await ports.reserve("fileServer");
    const projected = projectCommercialPortSetting("step1_config", { fileServerPort: 61005, workspaceDir: "/a" });
    expect(projected).toMatchObject({ fileServerPort: 24600, workspaceDir: "/a", agentPort: 0 });
    expect(sanitizeCommercialPortSetting("step1_config", projected)).toEqual({ workspaceDir: "/a" });
  });

  it("keeps the automatic manager and its storage separate from legacy settings", () => {
    state.settings.set(AUTOMATIC_PORTS_KEY, { fileServer: 24605 });
    const first = initializeCommercialLocalPorts();
    expect(initializeCommercialLocalPorts()).toBe(first);
    expect(sanitizeCommercialPortSetting("step1_config", { fileServerPort: 60005, workspaceDir: "/a" })).toEqual({ workspaceDir: "/a" });
    expect(state.settings.get(AUTOMATIC_PORTS_KEY)).toEqual({ fileServer: 24605 });
  });
});
