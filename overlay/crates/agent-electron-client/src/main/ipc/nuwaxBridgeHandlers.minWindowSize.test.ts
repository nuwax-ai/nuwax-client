/**
 * 单元测试: 商业版窗口最小尺寸 1200×720（plans/20260921-min-window-resolution.md）
 *
 * - 注册期挂 app.on("browser-window-created")：registerNuwaxBridgeHandlers 先于
 *   createWindow 执行（main.ts app ready 序），窗口实例只能经事件补设；
 * - 统一补设：主窗口（含 mac activate 重建）、webview 弹窗、session 独立窗口
 *   均抬到商业下限（Electron 40 无 getLastWebPreferences，事件期无法按
 *   webPreferences 分类；弹窗承载同一前端同受 768 移动端断点约束）；
 * - native:openWindow 独立窗口构造参数自带同款 min（事件之外的双保险）。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const settings = new Map<string, unknown>();
const handlers = new Map<
  string,
  (event: unknown, ...args: unknown[]) => unknown
>();
// BrowserWindow 构造参数记录（openWindow 独立窗口 min 断言用）
const winInstances: Array<{ opts: Record<string, unknown> }> = [];

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
    opts: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      winInstances.push({ opts: this.opts });
    }
    on() {
      return this;
    }
    loadURL() {
      return undefined;
    }
    focus() {
      return undefined;
    }
  },
  webContents: {
    getAllWebContents: () => [],
  },
  session: { defaultSession: { cookies: { get: vi.fn(async () => []) } } },
  screen: {},
  powerSaveBlocker: { start: vi.fn(() => 0), stop: vi.fn() },
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
import {
  registerNuwaxBridgeHandlers,
  applyMainWindowMinSize,
  NUWAX_MAIN_WINDOW_MIN_WIDTH,
  NUWAX_MAIN_WINDOW_MIN_HEIGHT,
} from "./nuwaxBridgeHandlers";

const HOST_ORIGIN = "https://testagent.xspaceagi.com";

function senderEvent(origin: string): { senderFrame: { url: string } } {
  return { senderFrame: { url: `${origin}/home` } };
}

function fakeWin(destroyed = false) {
  return {
    isDestroyed: vi.fn(() => destroyed),
    setMinimumSize: vi.fn(),
  };
}

/** 从注册期 app.on 调用里取 browser-window-created 监听器 */
function getCreatedListener(): (...args: unknown[]) => void {
  const calls = vi.mocked(app.on).mock.calls as unknown as Array<
    [string, (...args: unknown[]) => void]
  >;
  const call = calls.find(([event]) => event === "browser-window-created");
  if (!call) throw new Error("browser-window-created 监听未挂载");
  return call[1];
}

beforeEach(() => {
  settings.clear();
  handlers.clear();
  winInstances.length = 0;
  vi.mocked(app.on).mockClear();
  registerNuwaxBridgeHandlers({
    getMainWindow: () =>
      ({ webContents: { send: vi.fn() } }) as never,
  } as never);
});

describe("主窗口最小尺寸（browser-window-created 补设）", () => {
  it("注册期挂 browser-window-created 监听", () => {
    expect(app.on).toHaveBeenCalledWith(
      "browser-window-created",
      expect.any(Function),
    );
  });

  it("新建窗口统一补设 1200×720（主窗口/重建/弹窗不分型）", async () => {
    const listener = getCreatedListener();

    const mainWin = fakeWin();
    listener("event" as never, mainWin);
    // 事件在构造参数应用之前触发，补设推迟到 setImmediate（构造完成后）
    expect(mainWin.setMinimumSize).not.toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    expect(mainWin.setMinimumSize).toHaveBeenCalledTimes(1);
    expect(mainWin.setMinimumSize).toHaveBeenCalledWith(1200, 720);

    // mac activate 重建、webview 弹窗、session 独立窗口走同一事件，同样中招
    const reopened = fakeWin();
    listener("event" as never, reopened);
    await new Promise((resolve) => setImmediate(resolve));
    expect(reopened.setMinimumSize).toHaveBeenCalledWith(1200, 720);
  });

  it("已销毁窗口不补设（边缘态静默）", () => {
    const destroyed = fakeWin(true);
    expect(() =>
      applyMainWindowMinSize(destroyed as never),
    ).not.toThrow();
    expect(destroyed.setMinimumSize).not.toHaveBeenCalled();
  });

  it("常量与定义口径一致（1200×720，>768 移动端断点）", () => {
    expect(NUWAX_MAIN_WINDOW_MIN_WIDTH).toBe(1200);
    expect(NUWAX_MAIN_WINDOW_MIN_HEIGHT).toBe(720);
    expect(NUWAX_MAIN_WINDOW_MIN_WIDTH / 1.5).toBeGreaterThan(768);
  });
});

describe("native:openWindow 独立窗口最小尺寸", () => {
  it("构造参数自带主窗口同款 min（承载同一前端）", () => {
    settings.set("step1_config", {
      serverHost: HOST_ORIGIN,
      secondaryPages: "new-window",
    });
    const res = handlers.get("native:openWindow")!(
      senderEvent(HOST_ORIGIN),
      { path: "/agent-dev/1" },
    ) as { success: boolean };
    expect(res.success).toBe(true);
    const last = winInstances[winInstances.length - 1];
    expect(last?.opts.minWidth).toBe(NUWAX_MAIN_WINDOW_MIN_WIDTH);
    expect(last?.opts.minHeight).toBe(NUWAX_MAIN_WINDOW_MIN_HEIGHT);
  });
});
