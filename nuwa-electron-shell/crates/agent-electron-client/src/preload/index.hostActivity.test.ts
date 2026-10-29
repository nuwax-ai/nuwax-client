import { describe, expect, it, vi } from "vitest";

const { exposed, ipcOn, invoke, removeListener } = vi.hoisted(() => ({
  exposed: new Map<string, any>(),
  ipcOn: vi.fn(),
  invoke: vi.fn(async () => ({ visible: false })),
  removeListener: vi.fn(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: unknown) => exposed.set(name, api) },
  ipcRenderer: { on: ipcOn, invoke, removeListener, send: vi.fn() },
}));
import "./index";

describe("shell preload host activity contract", () => {
  it("只读快照通过专用 IPC 查询", async () => {
    const api = exposed.get("electronAPI");
    expect(await api.window.getHostActivity()).toEqual({ visible: false });
    expect(invoke).toHaveBeenCalledWith("window:getHostActivity");
  });

  it("宿主活动事件进入白名单，off 移除真实注册的 wrapper", () => {
    const api = exposed.get("electronAPI");
    const callback = vi.fn();
    api.on("nuwax:host-activity-changed", callback);
    const wrapper = ipcOn.mock.calls.find(([channel]) => channel === "nuwax:host-activity-changed")![1];
    wrapper({}, { visible: false });
    expect(callback).toHaveBeenCalledWith({ visible: false });
    api.off("nuwax:host-activity-changed", callback);
    expect(removeListener).toHaveBeenCalledWith("nuwax:host-activity-changed", wrapper);
  });
});
