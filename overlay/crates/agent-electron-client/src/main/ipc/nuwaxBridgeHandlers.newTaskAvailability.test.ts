import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  listeners: new Map<string, (...args: any[]) => unknown>(),
  settings: new Map<string, unknown>(),
  mainHost: { send: vi.fn() },
  setAvailable: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { isPackaged: false, on: vi.fn() },
  ipcMain: {
    handle: vi.fn(),
    on: (channel: string, fn: (...args: any[]) => unknown) => h.listeners.set(channel, fn),
  },
  dialog: { showSaveDialog: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  webContents: { getAllWebContents: () => [] },
  session: { defaultSession: { cookies: { get: vi.fn(async () => []) } } },
  screen: {},
  powerSaveBlocker: { start: vi.fn(() => 0), stop: vi.fn() },
  powerMonitor: { on: vi.fn() },
}));
vi.mock("electron-log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../db", () => ({
  readSetting: (key: string) => h.settings.get(key) ?? null,
  writeSetting: vi.fn(),
  getDb: () => ({ prepare: () => ({ run: () => ({ changes: 0 }) }) }),
}));
vi.mock("../services/sessionAuthInjection", () => ({
  initSessionAuthInjection: vi.fn(),
  trustInitialBusinessNavigation: vi.fn(),
}));
vi.mock("./processHandlers", () => ({
  stopAllServicesNow: vi.fn(async () => ({ success: true, results: {} })),
  restartAllServicesNow: vi.fn(async () => ({ success: true, results: {} })),
}));
vi.mock("../services/newTaskAvailability", () => ({
  setGuestNewTaskAvailable: h.setAvailable,
  isGuestNewTaskAvailable: () => false,
}));

import { registerNuwaxBridgeHandlers } from "./nuwaxBridgeHandlers";

const businessOrigin = "https://business.example";
function source(topOrigin = businessOrigin, frameOrigin = topOrigin) {
  const mainFrame = { url: `${topOrigin}/home` };
  return {
    senderFrame: frameOrigin === topOrigin ? mainFrame : { url: `${frameOrigin}/home` },
    sender: { getURL: () => `${topOrigin}/home`, mainFrame, hostWebContents: h.mainHost },
  };
}
function send(event: ReturnType<typeof source>, payload: unknown) {
  h.listeners.get("nuwax:layout-sync")!(event, payload);
}

beforeEach(() => {
  h.listeners.clear();
  h.settings.clear();
  vi.clearAllMocks();
  h.settings.set("step1_config", { serverHost: businessOrigin });
  registerNuwaxBridgeHandlers({ getMainWindow: () => ({ webContents: h.mainHost }) } as never);
});

describe("新建任务状态 IPC", () => {
  it("受信主文档的启用和禁用状态转交 guest 状态服务", () => {
    const event = source();
    send(event, { newTaskAvailable: true });
    send(event, { newTaskAvailable: false });
    expect(h.setAvailable).toHaveBeenNthCalledWith(1, event.sender, true, h.mainHost);
    expect(h.setAvailable).toHaveBeenNthCalledWith(2, event.sender, false, h.mainHost);
  });

  it.each([1, "true", null, undefined, {}, []])("非布尔载荷 %j 不改变状态", (value) => {
    send(source(), { newTaskAvailable: value });
    expect(h.setAvailable).not.toHaveBeenCalled();
  });

  it("外域顶层文档和嵌入 frame 不得改写状态", () => {
    send(source("https://external.example"), { newTaskAvailable: true });
    send(source(businessOrigin, "https://external.example"), { newTaskAvailable: true });
    const childFrame = source();
    childFrame.senderFrame = { url: `${businessOrigin}/home` };
    send(childFrame, { newTaskAvailable: true });
    expect(h.setAvailable).not.toHaveBeenCalled();
  });

  it("同步新建任务不影响原有二级菜单状态转发", () => {
    send(source(), { newTaskAvailable: false, secondMenuAvailable: true, secondMenuCollapsed: false });
    expect(h.mainHost.send).toHaveBeenCalledWith("nuwax:layout-changed", {
      secondMenuAvailable: true,
      secondMenuCollapsed: false,
    });
  });
});
