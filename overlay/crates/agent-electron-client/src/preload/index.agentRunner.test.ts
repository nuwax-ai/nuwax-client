import { describe, expect, it, vi } from "vitest";
const { exposed, invoke } = vi.hoisted(() => ({ exposed: new Map<string, any>(), invoke: vi.fn() }));
vi.mock("electron", () => ({ contextBridge: { exposeInMainWorld: (name: string, value: any) => exposed.set(name, value) }, ipcRenderer: { invoke, on: vi.fn() } }));
import "./index";
describe("commercial legacy runner preload", () => {
  it("returns unavailable locally and never transmits a configuration over IPC", async () => {
    const config = new Proxy({}, { get() { throw Error("Configuration must never be inspected"); } });
    expect((await exposed.get("electronAPI").agentRunner.start(config)).success).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});
