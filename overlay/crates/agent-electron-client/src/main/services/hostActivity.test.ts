/**
 * 单元测试: hostActivity - 宿主可见性状态机（休眠控制）
 *
 * 覆盖：
 * - 纯函数：computeHostVisible / isDormancyEnabled / shouldPushHostActivity
 * - 窗口沿（minimize/restore/hide/show）→ guest 收到 host-activity 变化沿
 * - powerMonitor 沿（lock-screen/unlock-screen/suspend/resume）
 * - 去抖（同态重复事件不重复推）、休眠开关门控、resume 强制重推
 * - guest 隐藏期 attach 初始同步、销毁 guest 跳过
 *
 * 通过 mock electron / electron-log / ../db 驱动事件回调验证
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BrowserWindow, WebContents } from "electron";

const mockPowerMonitorOn = vi.fn();

vi.mock("electron", () => ({
  BrowserWindow: class {},
  powerMonitor: {
    on: (...args: unknown[]) => mockPowerMonitorOn(...args),
  },
}));

vi.mock("electron-log", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

let mockSettingValue: unknown = null;

vi.mock("../db", () => ({
  readSetting: (_key: string) => mockSettingValue,
}));

import {
  initHostActivity,
  attachHostActivityWindow,
  attachHostActivityBusinessWindow,
  sendHostCommandToMainWindowGuests,
  computeHostVisible,
  isDormancyEnabled,
  shouldPushHostActivity,
  getHostActivitySnapshot,
  syncHostActivityGuest,
  refreshHostActivity,
  _resetHostActivityForTest,
} from "./hostActivity";

// ── 测试替身 ──

type Handler = (...args: unknown[]) => void;

interface MockGuest {
  guest: WebContents;
  sent: Array<{ channel: string; payload: { type: string; visible: boolean } }>;
  destroy(): void;
  fire(name: string): void;
  listeners(name: string): number;
}

function createMockGuest(): MockGuest {
  const sent: MockGuest["sent"] = [];
  let destroyed = false;
  const handlers = new Map<string, Handler[]>();
  const addHandler = (name: string, handler: Handler) => {
    handlers.set(name, [...(handlers.get(name) ?? []), handler]);
  };
  const guest = {
    isDestroyed: () => destroyed,
    send: (channel: string, payload: { type: string; visible: boolean }) => {
      sent.push({ channel, payload });
    },
    on: vi.fn(addHandler),
    once: vi.fn(addHandler),
    removeListener: vi.fn((name: string, handler: Handler) => {
      handlers.set(name, (handlers.get(name) ?? []).filter((item) => item !== handler));
    }),
  };
  return {
    guest: guest as unknown as WebContents,
    sent,
    destroy: () => {
      destroyed = true;
      (handlers.get("destroyed") ?? []).slice().forEach((handler) => handler());
    },
    fire: (name) => (handlers.get(name) ?? []).slice().forEach((handler) => handler()),
    listeners: (name) => (handlers.get(name) ?? []).length,
  };
}

function createMockWindow(visible = true) {
  const winHandlers = new Map<string, Handler[]>();
  const wcHandlers = new Map<string, Handler[]>();
  const win = {
    isVisible: () => visible,
    on: vi.fn((ev: string, h: Handler) => {
      winHandlers.set(ev, [...(winHandlers.get(ev) ?? []), h]);
    }),
    webContents: {
      isDestroyed: () => false,
      send: vi.fn(),
      on: vi.fn((ev: string, h: Handler) => {
        wcHandlers.set(ev, [...(wcHandlers.get(ev) ?? []), h]);
      }),
      removeListener: vi.fn((ev: string, h: Handler) => {
        wcHandlers.set(ev, (wcHandlers.get(ev) ?? []).filter((item) => item !== h));
      }),
    },
  };
  return {
    win: win as unknown as BrowserWindow,
    fireWin: (ev: string) => (winHandlers.get(ev) ?? []).forEach((h) => h()),
    fireAttach: (guest: WebContents) =>
      (wcHandlers.get("did-attach-webview") ?? []).forEach((h) => h({}, guest)),
  };
}

function createMockBusinessWindow(visible = true) {
  const contents = createMockGuest();
  const handlers = new Map<string, Handler[]>();
  const win = {
    isVisible: () => visible,
    webContents: contents.guest,
    on: vi.fn((name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    }),
    removeListener: vi.fn((name: string, handler: Handler) => {
      handlers.set(name, (handlers.get(name) ?? []).filter((item) => item !== handler));
    }),
  };
  return {
    ...contents,
    win: win as unknown as BrowserWindow,
    fireWin: (name: string) => (handlers.get(name) ?? []).slice().forEach((handler) => handler()),
    winListeners: (name: string) => (handlers.get(name) ?? []).length,
  };
}

/** 从 mockPowerMonitorOn 捕获的注册里按事件名取回调 */
function firePowerEvent(name: string): void {
  const calls = mockPowerMonitorOn.mock.calls.filter(
    (c) => c[0] === name,
  ) as unknown as Array<[string, Handler]>;
  calls.forEach(([, h]) => h());
}

function hostActivityPayloads(g: MockGuest) {
  return g.sent
    .filter((s) => s.channel === "nuwax:host-command")
    .map((s) => s.payload);
}

beforeEach(() => {
  _resetHostActivityForTest();
  mockPowerMonitorOn.mockClear();
  mockSettingValue = null;
});

// ── 纯函数 ──

describe("computeHostVisible", () => {
  it("窗口可见且未锁屏 → true", () => {
    expect(computeHostVisible({ windowVisible: true, locked: false })).toBe(
      true,
    );
  });

  it("窗口隐藏/最小化 或 锁屏 → false", () => {
    expect(computeHostVisible({ windowVisible: false, locked: false })).toBe(
      false,
    );
    expect(computeHostVisible({ windowVisible: true, locked: true })).toBe(
      false,
    );
    expect(computeHostVisible({ windowVisible: false, locked: true })).toBe(
      false,
    );
  });
});

describe("isDormancyEnabled", () => {
  it("缺省/形态异常 → 默认开", () => {
    expect(isDormancyEnabled(null)).toBe(true);
    expect(isDormancyEnabled(undefined)).toBe(true);
    expect(isDormancyEnabled("garbage")).toBe(true);
    expect(isDormancyEnabled({ enabled: "yes" })).toBe(true);
    expect(isDormancyEnabled({})).toBe(true);
  });

  it("{ enabled: boolean } 按值解析", () => {
    expect(isDormancyEnabled({ enabled: false })).toBe(false);
    expect(isDormancyEnabled({ enabled: true })).toBe(true);
  });
});

describe("shouldPushHostActivity", () => {
  it("visible 沿总是下发；invisible 沿受开关门控", () => {
    expect(shouldPushHostActivity(true, false)).toBe(true);
    expect(shouldPushHostActivity(true, true)).toBe(true);
    expect(shouldPushHostActivity(false, true)).toBe(true);
    expect(shouldPushHostActivity(false, false)).toBe(false);
  });
});

// ── 窗口沿 ──

describe("attachHostActivityWindow", () => {
  it("隐藏文档重载与迟订阅均能取回初态，恢复后重载取回 visible", () => {
    const mock = createMockWindow(false);
    attachHostActivityWindow(mock.win);
    const g = createMockGuest();
    mock.fireAttach(g.guest);
    g.fire("did-finish-load");
    syncHostActivityGuest(g.guest);
    expect(hostActivityPayloads(g)).toEqual(Array(3).fill({ type: "host-activity", visible: false }));
    expect(getHostActivitySnapshot()).toEqual({ visible: false });
    mock.fireWin("show");
    g.fire("did-finish-load");
    expect(hostActivityPayloads(g).slice(-2)).toEqual(Array(2).fill({ type: "host-activity", visible: true }));
  });

  it("关闭休眠时快照与重载保持活跃，未登记的二级 guest 不参与同步", () => {
    mockSettingValue = { enabled: false };
    const mock = createMockWindow(false);
    attachHostActivityWindow(mock.win);
    const g = createMockGuest();
    mock.fireAttach(g.guest);
    g.fire("did-finish-load");
    expect(getHostActivitySnapshot()).toEqual({ visible: true });
    expect(hostActivityPayloads(g)).toEqual([{ type: "host-activity", visible: true }]);
    const secondary = createMockGuest();
    syncHostActivityGuest(secondary.guest);
    expect(secondary.sent).toEqual([]);
  });

  it("窗口关闭与 guest 销毁移除文档加载监听，迟到加载不会复活状态推送", () => {
    const mock = createMockWindow(false);
    attachHostActivityWindow(mock.win);
    const destroyed = createMockGuest();
    const survivor = createMockGuest();
    mock.fireAttach(destroyed.guest);
    mock.fireAttach(survivor.guest);
    destroyed.destroy();
    expect(destroyed.listeners("did-finish-load")).toBe(0);
    // Electron 的 closed 回调中读取 BrowserWindow.webContents 会抛销毁异常。
    const contents = mock.win.webContents;
    Object.defineProperty(mock.win, "webContents", {
      get: () => { throw new Error("Object has been destroyed"); },
    });
    expect(() => mock.fireWin("closed")).not.toThrow();
    expect(contents.removeListener).toHaveBeenCalledWith("did-finish-load", expect.any(Function));
    expect(survivor.listeners("did-finish-load")).toBe(0);
    survivor.fire("did-finish-load");
    expect(hostActivityPayloads(survivor)).toHaveLength(1);
  });

  it("minimize → 推 invisible；restore → 推 visible", () => {
    const mock = createMockWindow(true);
    attachHostActivityWindow(mock.win);
    const g = createMockGuest();
    mock.fireAttach(g.guest);

    mock.fireWin("minimize");
    expect(hostActivityPayloads(g)).toEqual([
      { type: "host-activity", visible: false },
    ]);

    mock.fireWin("restore");
    expect(hostActivityPayloads(g)).toEqual([
      { type: "host-activity", visible: false },
      { type: "host-activity", visible: true },
    ]);
  });

  it("hide（托盘隐藏）→ invisible；show → visible", () => {
    const mock = createMockWindow(true);
    attachHostActivityWindow(mock.win);
    const g = createMockGuest();
    mock.fireAttach(g.guest);

    mock.fireWin("hide");
    expect(hostActivityPayloads(g)).toEqual([
      { type: "host-activity", visible: false },
    ]);

    mock.fireWin("show");
    expect(hostActivityPayloads(g)).toEqual([
      { type: "host-activity", visible: false },
      { type: "host-activity", visible: true },
    ]);
  });

  it("同态重复事件去抖：minimize 后再 hide 只推一次 invisible", () => {
    const mock = createMockWindow(true);
    attachHostActivityWindow(mock.win);
    const g = createMockGuest();
    mock.fireAttach(g.guest);

    mock.fireWin("minimize");
    mock.fireWin("hide");
    expect(hostActivityPayloads(g)).toEqual([
      { type: "host-activity", visible: false },
    ]);
  });

  it("休眠控制关闭（{enabled:false}）→ minimize 不下发 invisible", () => {
    mockSettingValue = { enabled: false };
    const mock = createMockWindow(true);
    attachHostActivityWindow(mock.win);
    const g = createMockGuest();
    mock.fireAttach(g.guest);

    mock.fireWin("minimize");
    expect(hostActivityPayloads(g)).toEqual([]);

    // visible 沿不受开关影响：恢复仍要推，保证前端不会卡在暂停态
    mock.fireWin("restore");
    expect(hostActivityPayloads(g)).toEqual([
      { type: "host-activity", visible: true },
    ]);
  });

  it("隐藏期 attach 的 guest 立即收到初始 invisible（--hidden 冷启动）", () => {
    const mock = createMockWindow(true);
    attachHostActivityWindow(mock.win);
    mock.fireWin("minimize");

    const g = createMockGuest();
    mock.fireAttach(g.guest);
    expect(hostActivityPayloads(g)).toEqual([
      { type: "host-activity", visible: false },
    ]);
  });

  it("可见期 attach 的 guest 不收初始推送（前端默认 visible，免噪）", () => {
    const mock = createMockWindow(true);
    attachHostActivityWindow(mock.win);
    const g = createMockGuest();
    mock.fireAttach(g.guest);
    expect(hostActivityPayloads(g)).toEqual([]);
  });

  it("已销毁的 guest 被跳过且不抛错，其余 guest 正常收推", () => {
    const mock = createMockWindow(true);
    attachHostActivityWindow(mock.win);
    const dead = createMockGuest();
    const alive = createMockGuest();
    mock.fireAttach(dead.guest);
    mock.fireAttach(alive.guest);

    dead.destroy();
    mock.fireWin("minimize");

    expect(hostActivityPayloads(dead)).toEqual([]);
    expect(hostActivityPayloads(alive)).toEqual([
      { type: "host-activity", visible: false },
    ]);
  });

  it("窗口创建即隐藏（isVisible=false）→ attach 后首个 guest 初始同步 invisible", () => {
    const mock = createMockWindow(false);
    attachHostActivityWindow(mock.win);
    const g = createMockGuest();
    mock.fireAttach(g.guest);
    expect(hostActivityPayloads(g)).toEqual([
      { type: "host-activity", visible: false },
    ]);
  });

  it("closed 清理 guest 登记态", () => {
    const mock = createMockWindow(true);
    attachHostActivityWindow(mock.win);
    const g = createMockGuest();
    mock.fireAttach(g.guest);

    mock.fireWin("closed");
    // closed 后 guests 已清空，即使状态沿再变化也无推送目标（不抛错）
    mock.fireWin("minimize");
    expect(hostActivityPayloads(g)).toEqual([]);
  });
});

// ── powerMonitor 沿 ──

describe("initHostActivity", () => {
  it("注册 lock-screen/unlock-screen/suspend/resume 四个事件，且幂等", () => {
    initHostActivity();
    initHostActivity();
    const registered = mockPowerMonitorOn.mock.calls.map((c) => c[0]);
    expect(registered).toEqual([
      "lock-screen",
      "unlock-screen",
      "suspend",
      "resume",
    ]);
  });

  it("lock-screen → invisible；unlock-screen → visible", () => {
    const mock = createMockWindow(true);
    attachHostActivityWindow(mock.win);
    const g = createMockGuest();
    mock.fireAttach(g.guest);
    initHostActivity();

    firePowerEvent("lock-screen");
    expect(hostActivityPayloads(g)).toEqual([
      { type: "host-activity", visible: false },
    ]);

    firePowerEvent("unlock-screen");
    expect(hostActivityPayloads(g)).toEqual([
      { type: "host-activity", visible: false },
      { type: "host-activity", visible: true },
    ]);
  });

  it("resume 强制重推当前态（同态也重发，治愈漂移）", () => {
    const mock = createMockWindow(true);
    attachHostActivityWindow(mock.win);
    const g = createMockGuest();
    mock.fireAttach(g.guest);
    initHostActivity();

    firePowerEvent("lock-screen");
    firePowerEvent("resume");
    // 锁屏未解锁即唤醒：状态仍 invisible，resume 强制重发一次
    expect(hostActivityPayloads(g)).toEqual([
      { type: "host-activity", visible: false },
      { type: "host-activity", visible: false },
    ]);
  });

  it("锁屏 + 窗口隐藏叠加后，需 unlock 与 show 双沿才回 visible", () => {
    const mock = createMockWindow(true);
    attachHostActivityWindow(mock.win);
    const g = createMockGuest();
    mock.fireAttach(g.guest);
    initHostActivity();

    mock.fireWin("hide");
    firePowerEvent("lock-screen");
    expect(hostActivityPayloads(g)).toEqual([
      { type: "host-activity", visible: false },
    ]);

    firePowerEvent("unlock-screen"); // 仍隐藏 → 保持 invisible（去抖不重发）
    mock.fireWin("show"); // 可见 → visible
    expect(hostActivityPayloads(g)).toEqual([
      { type: "host-activity", visible: false },
      { type: "host-activity", visible: true },
    ]);
  });
});

// ── 菜单宿主命令下发（应用菜单「文件 → 新建任务/搜索」复用 guest 登记集合） ──

describe("sendHostCommandToMainWindowGuests", () => {
  it("向已登记 guest 下发任意宿主命令 payload", async () => {
    const { sendHostCommandToMainWindowGuests } =
      await import("./hostActivity");
    const mock = createMockWindow();
    attachHostActivityWindow(mock.win);

    const g = createMockGuest();
    mock.fireAttach(g.guest);

    sendHostCommandToMainWindowGuests({ type: "new-task" });
    expect(g.sent.filter((s) => s.channel === "nuwax:host-command")).toEqual([
      { channel: "nuwax:host-command", payload: { type: "new-task" } },
    ]);
  });

  it("跳过已销毁 guest 并顺带清理登记", async () => {
    const { sendHostCommandToMainWindowGuests } =
      await import("./hostActivity");
    const mock = createMockWindow();
    attachHostActivityWindow(mock.win);

    const g = createMockGuest();
    mock.fireAttach(g.guest);
    g.destroy();

    expect(() =>
      sendHostCommandToMainWindowGuests({ type: "open-search" }),
    ).not.toThrow();
    expect(g.sent).toEqual([]);
  });
});

describe("attachHostActivityBusinessWindow", () => {
  it("关休眠立即激活所有隐藏窗口，重开按各窗口状态恢复且不复活已关闭窗口", () => {
    const main = createMockWindow(false);
    attachHostActivityWindow(main.win);
    const guest = createMockGuest();
    main.fireAttach(guest.guest);
    const hidden = createMockBusinessWindow(false);
    const visible = createMockBusinessWindow();
    const closed = createMockBusinessWindow(false);
    for (const secondary of [hidden, visible, closed]) attachHostActivityBusinessWindow(secondary.win);
    closed.fireWin("closed");
    const closedCount = closed.sent.length;
    mockSettingValue = { enabled: false };
    refreshHostActivity();
    expect(guest.sent.at(-1)?.payload).toEqual({ type: "host-activity", visible: true });
    expect(hidden.sent.at(-1)?.payload.visible).toBe(true);
    expect(visible.sent.at(-1)?.payload.visible).toBe(true);
    expect(getHostActivitySnapshot()).toEqual({ visible: true });
    mockSettingValue = { enabled: true };
    refreshHostActivity();
    expect(guest.sent.at(-1)?.payload.visible).toBe(false);
    expect(hidden.sent.at(-1)?.payload.visible).toBe(false);
    expect(visible.sent.at(-1)?.payload.visible).toBe(true);
    expect(closed.sent).toHaveLength(closedCount);
    expect(closed.listeners("did-finish-load")).toBe(0);
  });

  it("重开休眠仍遵循共享锁屏事实", () => {
    const main = createMockWindow();
    attachHostActivityWindow(main.win);
    const guest = createMockGuest();
    main.fireAttach(guest.guest);
    const secondary = createMockBusinessWindow();
    attachHostActivityBusinessWindow(secondary.win);
    initHostActivity();
    firePowerEvent("lock-screen");
    mockSettingValue = { enabled: false };
    refreshHostActivity();
    expect(guest.sent.at(-1)?.payload.visible).toBe(true);
    expect(secondary.sent.at(-1)?.payload.visible).toBe(true);
    mockSettingValue = { enabled: true };
    refreshHostActivity();
    expect(guest.sent.at(-1)?.payload.visible).toBe(false);
    expect(secondary.sent.at(-1)?.payload.visible).toBe(false);
  });

  it("主窗隐藏仍保留可见二级窗口；主窗菜单动作不广播到二级窗口", () => {
    const main = createMockWindow();
    attachHostActivityWindow(main.win);
    const guest = createMockGuest();
    main.fireAttach(guest.guest);
    const secondary = createMockBusinessWindow();
    attachHostActivityBusinessWindow(secondary.win);
    secondary.fire("did-finish-load");
    main.fireWin("hide");
    expect(getHostActivitySnapshot()).toEqual({ visible: false });
    expect(hostActivityPayloads(secondary)).toEqual([{ type: "host-activity", visible: true }]);
    sendHostCommandToMainWindowGuests({ type: "new-task" });
    expect(guest.sent.at(-1)?.payload).toEqual({ type: "new-task" });
    expect(secondary.sent).toHaveLength(1);
  });

  it("每个二级窗口独立跟随 hide/show/minimize/restore，并去掉重复沿", () => {
    const first = createMockBusinessWindow();
    const second = createMockBusinessWindow();
    attachHostActivityBusinessWindow(first.win);
    attachHostActivityBusinessWindow(second.win);
    first.fireWin("hide");
    first.fireWin("hide");
    first.fireWin("show");
    first.fireWin("minimize");
    first.fireWin("restore");
    expect(hostActivityPayloads(first).map((item) => item.visible)).toEqual([false, true, false, true]);
    expect(second.sent).toEqual([]);
    expect(getHostActivitySnapshot()).toEqual({ visible: true });
  });

  it("锁屏与唤醒作用于各自状态，主窗隐藏不会吞掉二级窗口解锁恢复", () => {
    const main = createMockWindow(false);
    attachHostActivityWindow(main.win);
    const visible = createMockBusinessWindow();
    const hidden = createMockBusinessWindow(false);
    attachHostActivityBusinessWindow(visible.win);
    attachHostActivityBusinessWindow(hidden.win);
    initHostActivity();
    firePowerEvent("lock-screen");
    firePowerEvent("resume");
    firePowerEvent("unlock-screen");
    expect(hostActivityPayloads(visible).map((item) => item.visible)).toEqual([false, false, true]);
    expect(hostActivityPayloads(hidden).every((item) => !item.visible)).toBe(true);
    expect(getHostActivitySnapshot()).toEqual({ visible: false });
  });

  it("隐藏初态在文档重载与 guest-sync 时补发，恢复文档得到 visible", () => {
    const secondary = createMockBusinessWindow(false);
    attachHostActivityBusinessWindow(secondary.win);
    secondary.fire("did-finish-load");
    syncHostActivityGuest(secondary.guest);
    expect(hostActivityPayloads(secondary).map((item) => item.visible)).toEqual([false, false, false]);
    secondary.fireWin("show");
    secondary.fire("did-finish-load");
    expect(hostActivityPayloads(secondary).slice(-2).map((item) => item.visible)).toEqual([true, true]);
  });

  it("关闭休眠时隐藏、锁屏和文档同步均保持 visible", () => {
    mockSettingValue = { enabled: false };
    const secondary = createMockBusinessWindow(false);
    attachHostActivityBusinessWindow(secondary.win);
    initHostActivity();
    secondary.fireWin("hide");
    firePowerEvent("lock-screen");
    secondary.fire("did-finish-load");
    syncHostActivityGuest(secondary.guest);
    firePowerEvent("resume");
    expect(hostActivityPayloads(secondary).length).toBeGreaterThan(1);
    expect(hostActivityPayloads(secondary).every((item) => item.visible)).toBe(true);
  });

  it.each(["closed", "destroyed"])("%s 释放监听与登记，迟到事件不会再发活动或动作", (event) => {
    const secondary = createMockBusinessWindow(false);
    attachHostActivityBusinessWindow(secondary.win);
    attachHostActivityBusinessWindow(secondary.win);
    expect(secondary.listeners("did-finish-load")).toBe(1);
    expect(secondary.winListeners("hide")).toBe(1);
    const before = secondary.sent.length;
    if (event === "closed") secondary.fireWin("closed");
    else secondary.destroy();
    expect(secondary.listeners("did-finish-load")).toBe(0);
    expect(secondary.winListeners("hide")).toBe(0);
    expect(secondary.winListeners("closed")).toBe(0);
    secondary.fireWin("show");
    secondary.fire("did-finish-load");
    syncHostActivityGuest(secondary.guest);
    initHostActivity();
    firePowerEvent("resume");
    sendHostCommandToMainWindowGuests({ type: "new-task" });
    expect(secondary.sent).toHaveLength(before);
  });
});
