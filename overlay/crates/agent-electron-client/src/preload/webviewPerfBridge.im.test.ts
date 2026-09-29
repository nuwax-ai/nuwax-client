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
  it("exposes only the native notification preference on the trusted commercial top document", async () => {
    const bridge = await loadBridge();
    expect(bridge?.im).toEqual({
      setNotificationEnabled: expect.any(Function),
    });
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
