import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  available: true,
  run: vi.fn(),
  prepare: vi.fn(),
  refresh: vi.fn(),
  warn: vi.fn(),
  notifyCapture: vi.fn(),
  shortcutAvailable: vi.fn(),
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
vi.mock("../features", () => ({ notifyCapturePreferencesChanged: mocks.notifyCapture, saveCaptureShortcutPreference: mocks.shortcutAvailable }));
import { CAPTURE_SHORTCUT_SETTING, CAPTURE_RECORD_SHORTCUT_SETTING } from '@shared/features/capture/contract';

beforeEach(() => {
  mocks.available = true;
  mocks.handlers.clear();
  mocks.run.mockReset();
  mocks.prepare.mockReset().mockReturnValue({ run: mocks.run });
  mocks.refresh.mockReset();
  mocks.warn.mockClear();
  mocks.notifyCapture.mockReset();
  mocks.shortcutAvailable.mockReset().mockImplementation((_shortcut, _action, persist) => { persist(); return true; });
  registerSettingsHandlers();
});

describe("settings:set host activity refresh", () => {
  it("消息提示音只保存布尔值，重置时恢复默认，不改变其它设置", () => {
    const set = mocks.handlers.get("settings:set")!;
    const key = "nuwax.im.messageSound.enabled";
    expect(set({}, key, "false")).toBe(false);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(set({}, key, false)).toBe(true);
    expect(mocks.run).toHaveBeenCalledWith(key, "false");
    expect(set({}, key, null)).toBe(true);
    expect(mocks.run).toHaveBeenLastCalledWith(key);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it("本机文件开关独立保存布尔值，拒绝字符串 false，删除后由特性默认值接管", () => {
    const set = mocks.handlers.get("settings:set")!;
    expect(set({}, "features.local-files.enabled", "false")).toBe(false);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(set({}, "features.local-files.enabled", false)).toBe(true);
    expect(mocks.run).toHaveBeenCalledWith("features.local-files.enabled", "false");
    expect(set({}, "features.local-files.enabled", null)).toBe(true);
    expect(mocks.run).toHaveBeenLastCalledWith("features.local-files.enabled");
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.notifyCapture).not.toHaveBeenCalled();
  });

  it('capture accelerators reject reserved and duplicate keys and notify menus only after persistence', () => {
    const notify = mocks.notifyCapture;
    const set = mocks.handlers.get('settings:set')!;
    expect(set({}, CAPTURE_SHORTCUT_SETTING, 'CmdOrCtrl+Shift+R')).toBe(false);
    expect(set({}, CAPTURE_SHORTCUT_SETTING, 'CmdOrCtrl+C')).toBe(false);
    expect(mocks.run).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
    expect(mocks.shortcutAvailable).not.toHaveBeenCalled();
    expect(set({}, CAPTURE_RECORD_SHORTCUT_SETTING, 'CmdOrCtrl+Alt+G')).toBe(true);
    expect(mocks.run).toHaveBeenCalledWith(CAPTURE_RECORD_SHORTCUT_SETTING, '"CmdOrCtrl+Alt+G"');
    expect(notify).toHaveBeenCalledOnce();
    expect(mocks.run.mock.invocationCallOrder[0]).toBeLessThan(notify.mock.invocationCallOrder[0]);
  });

  it.each([CAPTURE_SHORTCUT_SETTING, CAPTURE_RECORD_SHORTCUT_SETTING])('unavailable %s preserves persisted settings and menus', key => {
    mocks.shortcutAvailable.mockReturnValue(false);
    expect(() => mocks.handlers.get('settings:set')!({}, key, 'CmdOrCtrl+Alt+G'))
      .toThrow('CAPTURE_SHORTCUT_UNAVAILABLE');
    expect(mocks.shortcutAvailable).toHaveBeenCalledOnce();
    expect(mocks.shortcutAvailable).toHaveBeenCalledWith('CmdOrCtrl+Alt+G', key === CAPTURE_SHORTCUT_SETTING ? 'screenshot' : 'mp4', expect.any(Function));
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.notifyCapture).not.toHaveBeenCalled();
  });

  it('checks the default when resetting and does not probe when the database is unavailable', () => {
    mocks.shortcutAvailable.mockReturnValue(false);
    expect(() => mocks.handlers.get('settings:set')!({}, CAPTURE_SHORTCUT_SETTING, null))
      .toThrow('CAPTURE_SHORTCUT_UNAVAILABLE');
    expect(mocks.shortcutAvailable).toHaveBeenCalledWith('CmdOrCtrl+Shift+A', 'screenshot', expect.any(Function));
    mocks.shortcutAvailable.mockClear();
    mocks.available = false;
    expect(mocks.handlers.get('settings:set')!({}, CAPTURE_SHORTCUT_SETTING, 'CmdOrCtrl+Alt+G')).toBe(false);
    expect(mocks.shortcutAvailable).not.toHaveBeenCalled();
  });
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
