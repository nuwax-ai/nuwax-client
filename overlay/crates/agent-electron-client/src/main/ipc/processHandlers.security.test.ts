import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HandlerContext } from "@shared/types/ipc";
const { handlers, start, stop, kill } = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), start: vi.fn(), stop: vi.fn(), kill: vi.fn() }));
vi.mock("electron", () => ({ ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) } }));
vi.mock("./serviceHandler", () => ({ registerServiceHandler: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) }));
vi.mock("../services/auth/lifecycle", () => ({ commercialLifecycle: null }));
vi.mock("electron-log", () => ({ default: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("../window/serviceManager", () => ({ createServiceManager: () => ({}) }));
vi.mock("../window/trayManager", () => ({ getTrayManager: () => null }));
vi.mock("../services/startupPorts", () => ({ getConfiguredPorts: () => ({}) }));
vi.mock("../services/utils/processTree", () => ({ killProcessTreesListeningOnTcpPort: kill }));
import { registerProcessHandlers } from "./processHandlers";
beforeEach(() => { handlers.clear();vi.clearAllMocks();registerProcessHandlers({ agentRunner: { start, stopAsync: stop } } as unknown as HandlerContext); });
describe("legacy runner shutdown boundary", () => {
  it("rejects the old IPC without reading sensitive configuration or changing processes", async () => {
    const config = new Proxy({}, { get() { throw Error("Configuration must never be inspected"); } });
    expect((await handlers.get("agentRunner:start")!({}, config)).success).toBe(false);
    expect(start).not.toHaveBeenCalled();expect(stop).not.toHaveBeenCalled();expect(kill).not.toHaveBeenCalled();
  });
  it("keeps stop/status and the current service endpoints registered", () => {
    for (const name of ["agentRunner:stop", "agentRunner:status", "fileServer:start", "lanproxy:start", "services:stopAll"]) expect(handlers.has(name)).toBe(true);
  });
});
