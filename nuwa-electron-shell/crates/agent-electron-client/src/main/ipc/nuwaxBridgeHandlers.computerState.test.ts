import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  handlers: new Map<string, (...args: any[]) => any>(),
  listeners: new Map<string, (...args: any[]) => any>(),
  appListeners: new Map<string, Array<(...args: any[]) => any>>(),
  contents: [] as any[],
  windows: [] as any[],
  defaultSession: { on: vi.fn(), cookies: { get: vi.fn(async () => []), on: vi.fn() } },
  changed: null as ((phase: string, error?: string) => void) | null,
  host: { send: vi.fn() },
}));

function document(url: string, type = "webview", ses: unknown = h.defaultSession) {
  const mainFrame = { url };
  return Object.assign(new EventEmitter(), {
    url, mainFrame, session: ses, destroyed: false,
    getURL() { return this.url; },
    getType: () => type,
    isDestroyed() { return this.destroyed; },
    send: vi.fn(),
  });
}

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    on: (channel: string, callback: (...args: any[]) => any) => {
      const callbacks = h.appListeners.get(channel) ?? [];
      callbacks.push(callback);
      h.appListeners.set(channel, callbacks);
    },
  },
  ipcMain: {
    handle: (channel: string, callback: (...args: any[]) => any) => h.handlers.set(channel, callback),
    on: (channel: string, callback: (...args: any[]) => any) => h.listeners.set(channel, callback),
  },
  dialog: {},
  BrowserWindow: class extends EventEmitter {
    static getAllWindows() { return []; }
    webContents = document("", "window");
    constructor() { super(); h.windows.push(this); }
    isVisible() { return true; }
    isDestroyed() { return false; }
    loadURL(url: string) { this.webContents.url = url; return Promise.resolve(); }
    show() {}
    focus() {}
  },
  webContents: { getAllWebContents: () => h.contents },
  session: { defaultSession: h.defaultSession, fromPartition: () => ({
    on: vi.fn(), setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setSpellCheckerEnabled: vi.fn(),
  }) },
  screen: {}, powerMonitor: { on: vi.fn() },
  powerSaveBlocker: { start: vi.fn(() => 0), stop: vi.fn() },
}));
vi.mock("@shared/constants", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(), APP_NAME_IDENTIFIER: "nuwax",
}));
vi.mock("electron-log", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../db", () => ({
  readSetting: (key: string) => h.settings.get(key) ?? null,
  writeSetting: (key: string, value: unknown) => h.settings.set(key, value),
  getDb: () => ({ prepare: () => ({ run: () => ({ changes: 0 }) }) }),
}));
vi.mock("./commercialAuth", () => ({
  initializeCommercialAuth: (_start: unknown, _stop: unknown, changed: typeof h.changed) => {
    h.changed = changed;
    return { sync: vi.fn(), start: vi.fn(), stop: vi.fn(), invalidate: vi.fn() };
  },
  currentBusinessOrigin: () => "https://business.example",
  clearRegistration: vi.fn(), registrationTraceCode: vi.fn(),
}));
vi.mock("./processHandlers", () => ({ restartAllServicesNow: vi.fn(), stopAllServicesNow: vi.fn() }));
vi.mock("../services/sessionAuthInjection", () => ({ initSessionAuthInjection: vi.fn(), trustInitialBusinessNavigation: vi.fn() }));
vi.mock("../services/hostActivity", () => ({
  getHostActivitySnapshot: () => ({ visible: true }), syncHostActivityGuest: vi.fn(), attachHostActivityBusinessWindow: vi.fn(),
}));

import { registerNuwaxBridgeHandlers } from "./nuwaxBridgeHandlers";

const origin = "https://business.example";
function sync(contents: ReturnType<typeof document>, frame = contents.mainFrame) {
  h.listeners.get("nuwax:computer-service-state-sync")!({ sender: contents, senderFrame: frame });
}

beforeEach(() => {
  h.settings.clear(); h.handlers.clear(); h.listeners.clear(); h.appListeners.clear();
  h.contents = []; h.windows = []; vi.clearAllMocks();
  h.settings.set("step1_config", { serverHost: origin });
  h.settings.set("auth.user_info", { id: 31, currentDomain: origin, configKey: "secret" });
});

describe("生命周期电脑状态 IPC 集成", () => {
  it("ready 的脱敏配置 ID 下发业务 guest，重载与主动快照读到最新状态", () => {
    const guest = document(`${origin}/home`);
    h.contents = [guest];
    registerNuwaxBridgeHandlers({ getMainWindow: () => ({ webContents: h.host }) } as never);
    h.changed!("registering", "secret registration error");
    expect(guest.send).toHaveBeenLastCalledWith("nuwax:host-command", { type: "computer-service-state", phase: "registering" });
    h.changed!("starting");
    expect(guest.send).toHaveBeenLastCalledWith("nuwax:host-command", { type: "computer-service-state", phase: "starting", sandboxId: "31" });
    h.changed!("ready");
    guest.send.mockClear();
    guest.emit("dom-ready");
    sync(guest);
    expect(guest.send.mock.calls).toEqual(Array(2).fill([
      "nuwax:host-command", { type: "computer-service-state", phase: "ready", sandboxId: "31" },
    ]));
    h.changed!("stopping");
    expect(guest.send).toHaveBeenLastCalledWith("nuwax:host-command", { type: "computer-service-state", phase: "stopping" });
    expect(h.host.send).toHaveBeenCalledWith("nuwax:serviceState", { phase: "registering", error: "secret registration error" });
  });

  it("业务窗口同步状态，外域、内存隔离会话与子 frame 不接收电脑状态", () => {
    const guest = document(`${origin}/home`);
    const external = document("https://external.example/home");
    const isolated = document(`${origin}/home`, "webview", {});
    const businessWindow = document(`${origin}/home`, "window");
    h.contents = [guest, external, isolated, businessWindow];
    registerNuwaxBridgeHandlers({ getMainWindow: () => ({ webContents: h.host }) } as never);
    h.changed!("ready");
    for (const source of [external, isolated]) expect(source.send).not.toHaveBeenCalled();
    expect(businessWindow.send).toHaveBeenCalledWith("nuwax:host-command", {
      type: "computer-service-state", phase: "ready", sandboxId: "31",
    });
    guest.send.mockClear();
    sync(guest, { url: `${origin}/child` });
    expect(guest.send).not.toHaveBeenCalled();
    guest.url = "https://external.example/home";
    h.changed!("starting");
    guest.emit("dom-ready");
    sync(guest);
    expect(guest.send).not.toHaveBeenCalled();
  });

  it("新 guest 与独立业务窗口加载时补态；外链窗口的生命周期监听按当前源阻止状态发送", async () => {
    registerNuwaxBridgeHandlers({ getMainWindow: () => ({ webContents: h.host }) } as never);
    h.changed!("ready");
    const guest = document(`${origin}/home`);
    for (const listener of h.appListeners.get("web-contents-created") ?? []) listener({}, guest);
    guest.emit("dom-ready");
    expect(guest.send).toHaveBeenCalledWith("nuwax:host-command", { type: "computer-service-state", phase: "ready", sandboxId: "31" });
    const event = { sender: guest, senderFrame: guest.mainFrame };
    expect(await h.handlers.get("native:openWindow")!(event, { path: `${origin}/home` })).toEqual({ success: true });
    const businessWindow = h.windows.at(-1);
    businessWindow.webContents.emit("dom-ready");
    expect(businessWindow.webContents.send).toHaveBeenCalledWith("nuwax:host-command", { type: "computer-service-state", phase: "ready", sandboxId: "31" });
    expect(businessWindow.webContents.listenerCount("dom-ready")).toBe(2);
    expect(await h.handlers.get("native:openWindow")!(event, { path: "https://external.example/home" })).toEqual({ success: true });
    const externalWindow = h.windows.at(-1);
    externalWindow.webContents.emit("dom-ready");
    expect(externalWindow.webContents.listenerCount("dom-ready")).toBe(2);
    expect(externalWindow.webContents.send).not.toHaveBeenCalled();
  });

  it("ready 不暴露另一业务域历史 ID或非法 ID", () => {
    const guest = document(`${origin}/home`);
    h.contents = [guest];
    registerNuwaxBridgeHandlers({ getMainWindow: () => ({ webContents: h.host }) } as never);
    h.settings.set("auth.user_info", { id: 31, currentDomain: "https://old.example" });
    h.changed!("ready");
    expect(guest.send).toHaveBeenLastCalledWith("nuwax:host-command", { type: "computer-service-state", phase: "ready" });
    h.settings.set("auth.user_info", { id: -1, currentDomain: origin });
    sync(guest);
    expect(guest.send).toHaveBeenLastCalledWith("nuwax:host-command", { type: "computer-service-state", phase: "ready" });
  });
});
