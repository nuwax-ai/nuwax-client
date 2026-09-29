import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IM_IPC_CHANNELS, type IMReceiverBridge } from "@shared/types/imReceiver";

const mocks = vi.hoisted(() => ({
  expose: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: mocks,
}));

const addedArgs: string[] = [];

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  for (const arg of addedArgs) {
    const index = process.argv.indexOf(arg);
    if (index >= 0) process.argv.splice(index, 1);
  }
  addedArgs.length = 0;
  vi.unstubAllGlobals();
});

async function loadBridge({ product = "nuwax", origin = "https://business.example", top = true } = {}) {
  vi.resetModules();
  const args = [
    `--nuwax-host-product=${product}`,
    `--nuwax-trusted-origins=${encodeURIComponent(JSON.stringify(["https://business.example"]))}`,
  ];
  process.argv.push(...args);
  addedArgs.push(...args);
  const documentWindow = { location: { origin }, addEventListener: vi.fn(), top: null as unknown };
  documentWindow.top = top ? documentWindow : {};
  vi.stubGlobal("window", documentWindow);
  await import("./webviewPerfBridge");
  return mocks.expose.mock.calls.find(([name]) => name === "NuwaClawBridge")?.[1] as { im?: IMReceiverBridge } | undefined;
}

describe("commercial top-level IM bridge", () => {
  it("exposes notification preference and read-only unread on the trusted commercial top document", async () => {
    const bridge = await loadBridge();
    expect(bridge?.im).toEqual({
      setNotificationEnabled: expect.any(Function),
      getUnreadSnapshot: expect.any(Function),
      onUnreadChanged: expect.any(Function),
    });
  });

  it("reads the initial snapshot and pairs unread event registration with disposal", async () => {
    const im = (await loadBridge())!.im!;
    const snapshot = {sessionGeneration: 2, revision: 3, total: 126, dndTotal: 0};
    mocks.invoke.mockResolvedValue(snapshot);
    expect(await im.getUnreadSnapshot()).toEqual(snapshot);
    expect(mocks.invoke).toHaveBeenCalledWith(IM_IPC_CHANNELS.UNREAD_SNAPSHOT);
    const listener = vi.fn();
    const off = im.onUnreadChanged(listener);
    const receive = mocks.on.mock.calls.find(([channel]) => channel === IM_IPC_CHANNELS.UNREAD_CHANGED)![1];
    receive({privileged: true}, snapshot);
    expect(listener).toHaveBeenLastCalledWith(snapshot);
    receive({}, null);
    expect(listener).toHaveBeenLastCalledWith(null);
    off();
    expect(mocks.removeListener).toHaveBeenCalledWith(IM_IPC_CHANNELS.UNREAD_CHANGED, receive);
    receive({}, snapshot);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it.each([
    { product: "nuwaclaw" },
    { top: false },
    { origin: "https://external.example" },
  ])("does not expose IM for %j", async (options) => {
    expect((await loadBridge(options))?.im).toBeUndefined();
  });

  it("invokes only the assigned IPC channels and returns no privileged IPC result", async () => {
    const im = (await loadBridge())!.im!;
    mocks.invoke.mockResolvedValue({ privileged: true });
    expect(await im.setNotificationEnabled(true)).toBeUndefined();
    expect(await im.setNotificationEnabled(false)).toBeUndefined();
    expect(mocks.invoke.mock.calls).toEqual([
      [IM_IPC_CHANNELS.NOTIFICATION_ENABLED, true],
      [IM_IPC_CHANNELS.NOTIFICATION_ENABLED, false],
    ]);
  });

});
