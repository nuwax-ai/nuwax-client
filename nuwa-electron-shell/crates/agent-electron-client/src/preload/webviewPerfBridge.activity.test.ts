import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { exposed, listeners, send } = vi.hoisted(() => ({
  exposed: new Map<string, any>(),
  listeners: new Map<string, (event: unknown, payload: unknown) => void>(),
  send: vi.fn(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: unknown) => exposed.set(name, api) },
  ipcRenderer: {
    on: (channel: string, handler: (event: unknown, payload: unknown) => void) => listeners.set(channel, handler),
    send,
    invoke: vi.fn(),
  },
}));

async function loadDocument() {
  vi.resetModules();
  listeners.clear();
  exposed.clear();
  await import("./webviewPerfBridge");
  return exposed.get("NuwaClawBridge").events;
}

function emit(payload: unknown): void {
  listeners.get("nuwax:host-command")!({}, payload);
}

beforeEach(() => send.mockClear());
afterEach(() => vi.unstubAllGlobals());

describe("host activity state synchronization", () => {
  it("订阅前只保存最新可见状态，新建任务动作不会重放", async () => {
    const events = await loadDocument();
    emit({ type: "new-task" });
    emit({ type: "host-activity", visible: true });
    emit({ type: "host-activity", visible: false });
    const callback = vi.fn();
    events.onHostCommand(callback);
    expect(callback.mock.calls).toEqual([[{ type: "host-activity", visible: false }]]);
    expect(send).toHaveBeenCalledWith("nuwax:host-activity-sync");
    emit({ type: "new-task" });
    expect(callback).toHaveBeenLastCalledWith({ type: "new-task" });
    events.onHostCommand(null);
    const replacement = vi.fn();
    events.onHostCommand(replacement);
    expect(replacement.mock.calls).toEqual([[{ type: "host-activity", visible: false }]]);
  });

  it("注销期间收到状态可在重新订阅时同步，异常 payload 不覆盖有效状态", async () => {
    const events = await loadDocument();
    const callback = vi.fn();
    events.onHostCommand(callback);
    events.onHostCommand(null);
    emit({ type: "host-activity", visible: false });
    emit({ type: "host-activity", visible: "yes" });
    events.onHostCommand(callback);
    expect(callback.mock.calls).toEqual([[{ type: "host-activity", visible: false }]]);
  });

  it("重载的新文档发起当前态同步，不保留旧文档的动作或状态", async () => {
    const oldDocument = await loadDocument();
    oldDocument.onHostCommand(vi.fn());
    emit({ type: "host-activity", visible: true });
    emit({ type: "new-task" });
    const reloaded = await loadDocument();
    send.mockClear();
    const callback = vi.fn();
    reloaded.onHostCommand(callback);
    expect(callback).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("nuwax:host-activity-sync");
    emit({ type: "host-activity", visible: false });
    expect(callback.mock.calls).toEqual([[{ type: "host-activity", visible: false }]]);
  });
});
