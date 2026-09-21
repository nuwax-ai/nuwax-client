/**
 * 单元测试：顶栏自绘菜单收起信号（禅道 bug 2427 Win/Linux 工具栏菜单不自动关）
 * plans/20260921-bug2427-toolbar-menu-close-plan.md
 *
 * 根因：顶行菜单是宿主 renderer 的 antd Dropdown，「点外部收起」监听宿主 document
 * 的 mousedown；webview guest 是独立文档，页面内点击不冒泡到宿主 → 菜单挂住
 * （QA 实测：弹「编辑(E)」后点页面左侧导航不收起）。
 * 修复：guest webContents focus / 宿主窗口 blur 时，主进程广播
 * nuwax:dismiss-topbar-menus，工具栏受控菜单（TrafficLightToolbar TopMenu）收到即关。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const settings = new Map<string, unknown>();
const handlers = new Map<
  string,
  (event: unknown, ...args: unknown[]) => unknown
>();

// 可控的 webContents / 窗口列表（注册期 hook 全量 + 运行期广播目标）
let allWebContents: Array<Record<string, unknown>> = [];
let windows: Array<Record<string, unknown>> = [];

vi.mock("electron", () => ({
  app: { isPackaged: false, on: vi.fn() },
  ipcMain: {
    handle: (
      channel: string,
      fn: (event: unknown, ...a: unknown[]) => unknown,
    ) => {
      handlers.set(channel, fn);
    },
    on: vi.fn(),
  },
  dialog: { showSaveDialog: vi.fn() },
  BrowserWindow: class {
    static getAllWindows() {
      return windows;
    }
    opts: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
    }
    on() {
      return this;
    }
    loadURL() {
      return undefined;
    }
  },
  webContents: {
    getAllWebContents: () => allWebContents,
  },
  session: { defaultSession: { cookies: { get: vi.fn(async () => []) } } },
  screen: {},
  powerSaveBlocker: { start: vi.fn(() => 0), stop: vi.fn() },
  powerMonitor: { on: vi.fn() },
}));

vi.mock("electron-log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../db", () => ({
  readSetting: (key: string) => settings.get(key) ?? null,
  writeSetting: (key: string, value: unknown) => {
    settings.set(key, value);
  },
  getDb: () => ({
    prepare: () => ({ run: () => ({ changes: 0 }) }),
  }),
}));

vi.mock("./processHandlers", () => ({
  stopAllServicesNow: vi.fn(async () => ({ success: true, results: {} })),
  restartAllServicesNow: vi.fn(async () => ({ success: true, results: {} })),
}));

import { app } from "electron";
import { registerNuwaxBridgeHandlers } from "./nuwaxBridgeHandlers";

/** fake webContents：记录 on 订阅，可按事件名触发 */
function fakeWC(type: string, destroyed = false) {
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  const wc = {
    isDestroyed: vi.fn(() => destroyed),
    getType: vi.fn(() => type),
    on: vi.fn((event: string, fn: (...a: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(fn);
      return wc;
    }),
    fire(event: string) {
      for (const fn of listeners.get(event) ?? []) fn();
    },
  };
  return wc;
}

/** fake BrowserWindow：send 间谍 */
function fakeWin(destroyed = false) {
  return {
    isDestroyed: vi.fn(() => destroyed),
    webContents: { send: vi.fn() },
  };
}

/** 从注册期 app.on 调用里取指定事件的全部监听器（web-contents-created 同名多挂：nav 线 + 收起信号线） */
function getAllAppListeners(event: string): Array<(...args: unknown[]) => void> {
  const calls = vi.mocked(app.on).mock.calls as unknown as Array<
    [string, (...args: unknown[]) => void]
  >;
  return calls.filter(([e]) => e === event).map(([, fn]) => fn);
}

beforeEach(() => {
  settings.clear();
  handlers.clear();
  allWebContents = [];
  windows = [];
  vi.mocked(app.on).mockClear();
  registerNuwaxBridgeHandlers({ getMainWindow: () => ({ webContents: { send: vi.fn() } }) as never } as never);
});

describe("顶栏菜单收起信号（bug 2427）", () => {
  it("注册期对既有 webview guest 挂 focus 收起广播", () => {
    const guest = fakeWC("webview");
    allWebContents = [guest];
    vi.mocked(app.on).mockClear();
    registerNuwaxBridgeHandlers({ getMainWindow: () => ({ webContents: { send: vi.fn() } }) as never } as never);
    expect(guest.on).toHaveBeenCalledWith("focus", expect.any(Function));
  });

  it("guest 获焦（点进页面）→ 全部窗口收到收起信号", () => {
    const guest = fakeWC("webview");
    allWebContents = [guest];
    vi.mocked(app.on).mockClear();
    registerNuwaxBridgeHandlers({ getMainWindow: () => ({ webContents: { send: vi.fn() } }) as never } as never);

    const win = fakeWin();
    windows = [win];
    guest.fire("focus");
    expect(win.webContents.send).toHaveBeenCalledWith(
      "nuwax:dismiss-topbar-menus",
    );
  });

  it("注册后新建的 guest（web-contents-created）同样挂收起监听", () => {
    const guest = fakeWC("webview");
    for (const listener of getAllAppListeners("web-contents-created")) {
      listener("event" as never, guest as never);
    }
    expect(guest.on).toHaveBeenCalledWith("focus", expect.any(Function));
  });

  it("非 webview webContents（宿主页/独立窗主 contents）不挂收起监听", () => {
    const host = fakeWC("window");
    for (const listener of getAllAppListeners("web-contents-created")) {
      listener("event" as never, host as never);
    }
    expect(host.on).not.toHaveBeenCalledWith("focus", expect.any(Function));
  });

  it("窗口失焦（点窗口外）→ 该窗口收到收起信号；已销毁窗口静默", () => {
    const blur = getAllAppListeners("browser-window-blur")[0];
    const win = fakeWin();
    blur("event" as never, win as never);
    expect(win.webContents.send).toHaveBeenCalledWith(
      "nuwax:dismiss-topbar-menus",
    );

    const destroyed = fakeWin(true);
    expect(() =>
      blur("event" as never, destroyed as never),
    ).not.toThrow();
    expect(destroyed.webContents.send).not.toHaveBeenCalled();
  });

  it("webview 历史导航真值通道不回归（bug 2432 通道并存）", () => {
    expect(handlers.get("nuwax:webview-nav-state")).toBeTypeOf("function");
    expect(handlers.get("nuwax:webview-nav-go")).toBeTypeOf("function");
  });
});
