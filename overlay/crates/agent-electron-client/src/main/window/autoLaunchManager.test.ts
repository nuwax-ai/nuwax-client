import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  packaged: true,
  registered: false,
  allowed: true,
  apply: true,
  preference: null as unknown,
}));

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return state.packaged;
    },
    getLoginItemSettings: vi.fn(() => ({
      openAtLogin: state.registered,
      executableWillLaunchAtLogin: state.allowed,
    })),
    setLoginItemSettings: vi.fn(
      (settings: { openAtLogin: boolean; enabled?: boolean }) => {
        if (state.apply) {
          state.registered = settings.openAtLogin;
          if (settings.enabled !== undefined) state.allowed = settings.enabled;
        }
      },
    ),
  },
}));
vi.mock("electron-log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../db", () => ({
  readSetting: vi.fn(() => state.preference),
  writeSetting: vi.fn((_key: string, value: unknown) => {
    state.preference = value;
    return true;
  }),
}));

import { app } from "electron";
import { writeSetting } from "../db";
import {
  AutoLaunchManager,
  createAutoLaunchManager,
  getAutoLaunchManager,
} from "./autoLaunchManager";

const actualPlatform = process.platform;
const AutoLaunch = require("auto-launch");

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, {
    packaged: true,
    registered: false,
    allowed: true,
    apply: true,
    preference: null,
  });
  Object.defineProperty(process, "platform", { value: "win32" });
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: actualPlatform });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("开机自启动默认值与用户选择", () => {
  it("安装包首次运行默认开启，读写匹配同一启动参数", async () => {
    await new AutoLaunchManager().initializeDefault();
    expect(app.setLoginItemSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        openAtLogin: true,
        enabled: true,
        args: ["--hidden"],
      }),
    );
    expect(app.getLoginItemSettings).toHaveBeenCalledWith({
      args: ["--hidden"],
    });
    expect(state.preference).toBe(true);
  });

  it("关闭后重新创建管理器，默认初始化不再开启", async () => {
    const manager = new AutoLaunchManager();
    await manager.initializeDefault();
    expect(await manager.setEnabled(false)).toBe(true);
    vi.mocked(app.setLoginItemSettings).mockClear();
    await new AutoLaunchManager().initializeDefault();
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
    expect(await manager.isEnabled()).toBe(false);
    expect(state.preference).toBe(false);
  });

  it("关闭后可再次开启", async () => {
    const manager = new AutoLaunchManager();
    await manager.setEnabled(false);
    expect(await manager.setEnabled(true)).toBe(true);
    expect(await manager.isEnabled()).toBe(true);
    expect(state.preference).toBe(true);
  });

  it.each([true, false])("已有选择 %s 时不改系统设置", async (preference) => {
    state.preference = preference;
    await new AutoLaunchManager().initializeDefault();
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
    expect(writeSetting).not.toHaveBeenCalled();
  });

  it("系统已开启时只保存初始化结果", async () => {
    state.registered = true;
    await new AutoLaunchManager().initializeDefault();
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
    expect(state.preference).toBe(true);
  });

  it("用户在系统中关闭后，客户端重启不强行恢复", async () => {
    state.preference = true;
    state.registered = true;
    state.allowed = false;
    const manager = new AutoLaunchManager();
    await manager.initializeDefault();
    expect(await manager.isEnabled()).toBe(false);
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it("开发运行不默认注册，也不保存默认选择", async () => {
    state.packaged = false;
    await new AutoLaunchManager().initializeDefault();
    expect(app.getLoginItemSettings).not.toHaveBeenCalled();
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
    expect(writeSetting).not.toHaveBeenCalled();
  });

  it("系统没有实际应用设置时返回失败，之后可重试默认初始化", async () => {
    state.apply = false;
    const manager = new AutoLaunchManager();
    expect(await manager.setEnabled(true)).toBe(false);
    expect(writeSetting).not.toHaveBeenCalled();
    state.apply = true;
    await manager.initializeDefault();
    expect(state.preference).toBe(true);
  });

  it("读系统状态失败时不按关闭处理，也不改注册项", async () => {
    vi.mocked(app.getLoginItemSettings).mockImplementationOnce(() => {
      throw new Error("read failed");
    });
    await new AutoLaunchManager().initializeDefault();
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
    expect(writeSetting).not.toHaveBeenCalled();
  });

  it("写系统设置异常时返回失败，不保存成功状态", async () => {
    vi.mocked(app.setLoginItemSettings).mockImplementationOnce(() => {
      throw new Error("write failed");
    });
    expect(await new AutoLaunchManager().setEnabled(true)).toBe(false);
    expect(writeSetting).not.toHaveBeenCalled();
  });

  it("持久化失败时返回失败", async () => {
    vi.mocked(writeSetting).mockReturnValueOnce(false);
    expect(await new AutoLaunchManager().setEnabled(true)).toBe(false);
  });

  it("macOS 同样默认开启并支持关闭", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const manager = new AutoLaunchManager();
    await manager.initializeDefault();
    expect(state.preference).toBe(true);
    expect(await manager.setEnabled(false)).toBe(true);
    expect(state.preference).toBe(false);
  });

  it("Linux AppImage 注册持久包路径，开启/关闭都保存选择", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.stubEnv("APPIMAGE", "/home/user/Nuwax.AppImage");
    let enabled = false;
    const enable = vi
      .spyOn(AutoLaunch.prototype, "enable")
      .mockImplementation(function (this: any) {
        expect(this.opts.appPath).toBe("/home/user/Nuwax.AppImage");
        expect(this.opts.isHiddenOnLaunch).toBe(true);
        enabled = true;
        return Promise.resolve();
      });
    vi.spyOn(AutoLaunch.prototype, "disable").mockImplementation(() => {
      enabled = false;
      return Promise.resolve();
    });
    vi.spyOn(AutoLaunch.prototype, "isEnabled").mockImplementation(() =>
      Promise.resolve(enabled),
    );
    const manager = new AutoLaunchManager();
    await manager.initializeDefault();
    expect(enable).toHaveBeenCalledOnce();
    expect(state.preference).toBe(true);
    expect(await manager.setEnabled(false)).toBe(true);
    expect(state.preference).toBe(false);
  });

  it("Linux 创建启动项失败时不保存默认选择", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.spyOn(AutoLaunch.prototype, "isEnabled").mockResolvedValue(false);
    vi.spyOn(AutoLaunch.prototype, "enable").mockRejectedValue(
      new Error("permission denied"),
    );
    await new AutoLaunchManager().initializeDefault();
    expect(writeSetting).not.toHaveBeenCalled();
  });

  it("初始化、IPC、托盘复用同一实例", () => {
    expect(createAutoLaunchManager()).toBe(createAutoLaunchManager());
    expect(getAutoLaunchManager()).toBe(createAutoLaunchManager());
  });
});
