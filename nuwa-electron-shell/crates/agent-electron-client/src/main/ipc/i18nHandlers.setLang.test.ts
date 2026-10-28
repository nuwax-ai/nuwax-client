/**
 * 单元测试：壳语言切换同步 webview guest（禅道 bug 2428「客户端 切换语言无效果」）
 *
 * 根因（打回复核结论）：修复代码（i18n:setLang 转发 nuwax:host-command set-lang 给
 * webview guest + 短延迟重载）曾只存在于开发工作树、从未提交进任何 prerelease tag
 * 钉的基座 pin（v1.0.22~25 二进制 grep "set-lang" = 0），QA 的 v1.0.24 客户端里
 * 壳侧根本没有这段转发，切语言只重载壳页、主界面 webview 不跟随。
 *
 * 本用例锁住三件事：
 * 1. 语种变化且有 webview guest → set-lang 下发 + 800ms 后重载 guest；
 * 2. 语种未变化（壳 renderer 启动 initI18n 的同值同步）→ 不下发不重载；
 * 3. 无 guest（社区形态 / guest 尚未挂载）→ no-op 不抛错。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const handlers = new Map<
  string,
  (event: unknown, ...args: unknown[]) => unknown
>();

let guestSend: ReturnType<typeof vi.fn>;
let guestReload: ReturnType<typeof vi.fn>;
let allWebContents: Array<Record<string, unknown>> = [];

vi.mock("electron", () => ({
  ipcMain: {
    handle: (
      channel: string,
      fn: (event: unknown, ...a: unknown[]) => unknown,
    ) => {
      handlers.set(channel, fn);
    },
    on: vi.fn(),
  },
  webContents: {
    getAllWebContents: () => allWebContents,
    fromId: (id: number) =>
      allWebContents.find((wc) => wc.id === id) ?? null,
  },
}));

vi.mock("electron-log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../window/trayManager", () => ({
  getTrayManager: () => ({ refresh: vi.fn() }),
}));

// services/i18n 真实模块含 app.getAppPath()/resourcesPath 访问，mock 掉状态面
const i18nState = vi.hoisted(() => ({ current: "zh-cn" }));
vi.mock("../services/i18n", () => ({
  DEFAULT_MAIN_LANG: "zh-cn",
  getMainLang: () => i18nState.current,
  getCurrentLang: () => i18nState.current,
  setMainLang: (lang: string) => {
    i18nState.current =
      (typeof lang === "string" && lang.trim() ? lang : "").toLowerCase() ||
      "zh-cn";
  },
}));

import { registerI18nHandlers } from "./i18nHandlers";

function makeGuest() {
  return {
    id: Math.floor(Math.random() * 100000) + 1,
    getType: () => "webview",
    isDestroyed: () => false,
    send: guestSend,
    reload: guestReload,
  };
}

describe("i18n:setLang → webview guest set-lang 转发（bug 2428）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    handlers.clear();
    i18nState.current = "zh-cn";
    guestSend = vi.fn();
    guestReload = vi.fn();
    allWebContents = [];
    registerI18nHandlers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("语种变化且有 guest：下发 set-lang 并在 800ms 后重载 guest", async () => {
    const guest = makeGuest();
    allWebContents = [guest, { id: 999, getType: () => "browser", isDestroyed: () => false }];

    const result = await handlers.get("i18n:setLang")!(undefined, "en-US");

    expect(result).toEqual({ success: true });
    expect(guestSend).toHaveBeenCalledTimes(1);
    expect(guestSend).toHaveBeenCalledWith("nuwax:host-command", {
      type: "set-lang",
      lang: "en-US",
    });
    // 800ms 内不重载（给 web 侧接收应用的窗口期）
    expect(guestReload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(799);
    expect(guestReload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(guestReload).toHaveBeenCalledTimes(1);
  });

  it("语种未变化（启动期同值同步）：不下发 set-lang、不重载", async () => {
    const guest = makeGuest();
    allWebContents = [guest];

    // 初始 zh-cn，再同步 zh-CN（大小写差异归一后同值）
    await handlers.get("i18n:setLang")!(undefined, "zh-CN");

    expect(guestSend).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(guestReload).not.toHaveBeenCalled();
  });

  it("无 webview guest（社区形态/未挂载）：no-op 成功返回", async () => {
    allWebContents = [{ id: 7, getType: () => "browser", isDestroyed: () => false }];

    const result = await handlers.get("i18n:setLang")!(undefined, "zh-TW");

    expect(result).toEqual({ success: true });
    vi.advanceTimersByTime(2000);
    expect(guestReload).not.toHaveBeenCalled();
  });

  it("转发后 guest 被销毁：延迟重载安全跳过不抛错", async () => {
    const guest = makeGuest();
    allWebContents = [guest];
    await handlers.get("i18n:setLang")!(undefined, "en-US");

    // 模拟设置页随即整页 reload：guest 在 800ms 前被销毁
    (guest as { isDestroyed: () => boolean }).isDestroyed = () => true;
    vi.advanceTimersByTime(1000);
    expect(guestReload).not.toHaveBeenCalled();
  });
});
