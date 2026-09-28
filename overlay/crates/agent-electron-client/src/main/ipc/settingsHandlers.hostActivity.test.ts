import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  available: true,
  run: vi.fn(),
  prepare: vi.fn(),
  refresh: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, handler) },
}));
vi.mock("../db", () => ({
  getDb: () => mocks.available ? { prepare: mocks.prepare } : null,
  readSetting: vi.fn(),
}));
vi.mock("electron-log", () => ({ default: { warn: mocks.warn } }));
vi.mock("../bootstrap/quickInit", () => ({ readQuickInitConfig: vi.fn() }));
vi.mock("../services/hostActivity", () => ({
  DORMANCY_SETTING_KEY: "nuwax.dormancy",
  refreshHostActivity: mocks.refresh,
}));

import { registerSettingsHandlers } from "./settingsHandlers";

beforeEach(() => {
  mocks.available = true;
  mocks.handlers.clear();
  mocks.run.mockReset();
  mocks.prepare.mockReset().mockReturnValue({ run: mocks.run });
  mocks.refresh.mockReset();
  mocks.warn.mockClear();
  registerSettingsHandlers();
});

describe("settings:set host activity refresh", () => {
  it("休眠设置先持久化再刷新，保留原成功返回", () => {
    expect(mocks.handlers.get("settings:set")!({}, "nuwax.dormancy", { enabled: false })).toBe(true);
    expect(mocks.run).toHaveBeenCalledWith("nuwax.dormancy", '{"enabled":false}');
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.run.mock.invocationCallOrder[0]).toBeLessThan(mocks.refresh.mock.invocationCallOrder[0]);
  });

  it("删除休眠设置恢复默认策略后也刷新", () => {
    expect(mocks.handlers.get("settings:set")!({}, "nuwax.dormancy", null)).toBe(true);
    expect(mocks.prepare).toHaveBeenCalledWith("DELETE FROM settings WHERE key = ?");
    expect(mocks.run).toHaveBeenCalledWith("nuwax.dormancy");
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("无关设置保持原 SQL 与返回，不刷新活动桥", () => {
    expect(mocks.handlers.get("settings:set")!({}, "ordinary.setting", { enabled: false })).toBe(true);
    expect(mocks.run).toHaveBeenCalledWith("ordinary.setting", '{"enabled":false}');
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("数据库不可用保留 false 返回，不刷新", () => {
    mocks.available = false;
    expect(mocks.handlers.get("settings:set")!({}, "nuwax.dormancy", { enabled: false })).toBe(false);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("持久化失败仍抛原错误，不刷新活动桥", () => {
    const error = new Error("write failed");
    mocks.run.mockImplementation(() => { throw error; });
    expect(() => mocks.handlers.get("settings:set")!({}, "nuwax.dormancy", { enabled: false })).toThrow(error);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("活动刷新失败记录日志，已保存设置仍返回 true", () => {
    const error = new Error("refresh failed");
    mocks.refresh.mockImplementation(() => { throw error; });
    expect(mocks.handlers.get("settings:set")!({}, "nuwax.dormancy", { enabled: false })).toBe(true);
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("Host activity"), error);
  });
});
