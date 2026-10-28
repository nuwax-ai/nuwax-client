import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  exposed: new Map<string, any>(),
  listeners: new Map<string, (event: unknown, payload: unknown) => void>(),
  send: vi.fn(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: unknown) => h.exposed.set(name, api) },
  ipcRenderer: {
    on: (channel: string, callback: (event: unknown, payload: unknown) => void) => h.listeners.set(channel, callback),
    send: h.send, invoke: vi.fn(),
  },
}));

const originalArgv = [...process.argv];
async function loadDocument(origin = "https://business.example") {
  vi.resetModules();
  h.listeners.clear();
  h.exposed.clear();
  vi.stubGlobal("window", { location: { origin }, addEventListener: vi.fn() });
  process.argv = [...originalArgv, "--nuwax-host-product=nuwax",
    `--nuwax-trusted-origins=${encodeURIComponent(JSON.stringify(["https://business.example"]))}`];
  await import("./webviewPerfBridge");
  return h.exposed.get("NuwaClawBridge")?.events;
}
function emit(payload: unknown) { h.listeners.get("nuwax:host-command")!({}, payload); }
beforeEach(() => h.send.mockClear());
afterEach(() => { process.argv = originalArgv; vi.unstubAllGlobals(); });

describe("guest 电脑状态缓存与重播", () => {
  it("晚订阅分别重播最新服务态及活动态，动作命令不重放且状态脱敏", async () => {
    const events = await loadDocument();
    emit({ type: "computer-service-state", phase: "starting", sandboxId: "31" });
    emit({ type: "host-activity", visible: false });
    emit({ type: "new-task" });
    emit({ type: "computer-service-state", phase: "ready", sandboxId: "31", ticket: "secret" });
    const callback = vi.fn();
    events.onHostCommand(callback);
    expect(callback.mock.calls).toEqual([
      [{ type: "host-activity", visible: false }],
      [{ type: "computer-service-state", phase: "ready", sandboxId: "31" }],
    ]);
    expect(h.send).toHaveBeenCalledWith("nuwax:computer-service-state-sync");
    emit({ type: "open-search" });
    expect(callback).toHaveBeenLastCalledWith({ type: "open-search" });
  });

  it("异常状态不覆盖缓存，注销期间更新状态，重订阅不携带旧 ID", async () => {
    const events = await loadDocument();
    const callback = vi.fn();
    events.onHostCommand(callback);
    emit({ type: "computer-service-state", phase: "ready", sandboxId: "31" });
    emit({ type: "computer-service-state", phase: 1 });
    expect(callback).toHaveBeenCalledOnce();
    events.onHostCommand(null);
    emit({ type: "computer-service-state", phase: "stopping" });
    const replacement = vi.fn((state) => { state.phase = "tampered"; });
    events.onHostCommand(replacement);
    expect(replacement).toHaveBeenCalledOnce();
    const final = vi.fn();
    events.onHostCommand(final);
    expect(final.mock.calls).toEqual([[{ type: "computer-service-state", phase: "stopping" }]]);
  });

  it("新文档不继承旧缓存，订阅请求当前态；dom-ready 补态可在订阅前到达", async () => {
    await loadDocument();
    emit({ type: "computer-service-state", phase: "starting", sandboxId: "31" });
    const reloaded = await loadDocument();
    const callback = vi.fn();
    reloaded.onHostCommand(callback);
    expect(callback).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenCalledWith("nuwax:computer-service-state-sync");
    reloaded.onHostCommand(null);
    emit({ type: "computer-service-state", phase: "ready", sandboxId: "31" });
    reloaded.onHostCommand(callback);
    expect(callback.mock.calls).toEqual([[{ type: "computer-service-state", phase: "ready", sandboxId: "31" }]]);
  });

  it("外域商业文档没有桥，也不监听宿主命令", async () => {
    expect(await loadDocument("https://external.example")).toBeUndefined();
    expect(h.listeners.has("nuwax:host-command")).toBe(false);
  });
});
