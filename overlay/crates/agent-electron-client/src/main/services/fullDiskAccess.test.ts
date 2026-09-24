/**
 * 单元测试: fullDiskAccess - 全磁盘访问检测 + 初始化一次性引导 + 授权翻转重启提示
 *
 * 覆盖：
 * - checkFullDiskAccess：子进程探针 exit 0/2 → granted/denied；非 darwin 恒 true
 *   且不派生；spawn 抛错 → unknown，不误报已授权
 * - 拒绝标记解析：{ dismissed: true } / 裸 true / 缺省
 * - getFullDiskAccessStatus：状态快照区分 granted/denied/unknown
 * - openFullDiskAccessSettings：主路径成功；失败兜底打开隐私主面板；两级失败不抛错
 * - initFullDiskAccessGuard 接线：darwin 注册窗口/失焦/聚焦沿与解锁/唤醒沿，非 darwin
 *   零注册；主窗口首帧弹一次引导窗；「暂不」持久化、「去开启」打开面板且不写
 *   dismissed；dismissed/granted/会话内重复均不弹；聚焦沿只静默复查
 * - 授权流程重启提示：会话内 blocked→passed 翻转弹一次；打开设置后真实失焦再
 *   返回时，即使同会话探针仍 blocked 也弹一次；立即重启统一 relaunch+quit
 *
 * 通过 mock electron(app/dialog/powerMonitor/shell/BrowserWindow) /
 * node:child_process / ../db / ./system/macPermissions / ./i18n 驱动；
 * process.platform 用 Object.defineProperty 桩化（跨平台 CI 可跑 darwin 分支）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockAppOn = vi.fn((..._args: unknown[]) => undefined);
const mockPowerMonitorOn = vi.fn((..._args: unknown[]) => undefined);
const mockDialogShow = vi.fn(
  async (..._args: unknown[]) => ({ response: 1 }) as { response: number },
);
const mockShellOpenExternal = vi.fn(async (..._args: unknown[]) => true);
const mockGetName = vi.fn((..._args: unknown[]) => "Nuwax");
const mockAppRelaunch = vi.fn((..._args: unknown[]) => undefined);
const mockAppExit = vi.fn((..._args: unknown[]) => undefined);
const mockAppQuit = vi.fn((..._args: unknown[]) => undefined);

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getName: (...args: unknown[]) => mockGetName(...args),
    on: (...args: unknown[]) => mockAppOn(...args),
    getPath: (_name: string) =>
      "/Applications/Nuwax.app/Contents/MacOS/Nuwax",
    relaunch: (...args: unknown[]) => mockAppRelaunch(...args),
    exit: (...args: unknown[]) => mockAppExit(...args),
    quit: (...args: unknown[]) => mockAppQuit(...args),
  },
  dialog: {
    showMessageBox: (...args: unknown[]) => mockDialogShow(...args),
  },
  powerMonitor: { on: (...args: unknown[]) => mockPowerMonitorOn(...args) },
  shell: {
    openExternal: (...args: unknown[]) => mockShellOpenExternal(...args),
  },
  BrowserWindow: { getAllWindows: () => [] as never[] },
}));

vi.mock("electron-log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** 下一次探测子进程的退出码（0=通过 / 2=被拦）；默认 0 */
let nextProbeCode: number | null = 0;
const mockSpawn = vi.fn((..._args: unknown[]) => {
  const listeners: Record<string, (...args: unknown[]) => void> = {};
  const child = {
    on: vi.fn((evt: string, cb: (...args: unknown[]) => void) => {
      listeners[evt] = cb;
    }),
    kill: vi.fn(),
  };
  const code = nextProbeCode;
  queueMicrotask(() => listeners["close"]?.(code));
  return child;
});

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

const mockWriteSetting = vi.fn((..._args: unknown[]) => true);
let mockSettingValue: unknown = null;

vi.mock("../db", () => ({
  readSetting: (_key: string) => mockSettingValue,
  writeSetting: (...args: unknown[]) => mockWriteSetting(...args),
}));

let mockOpenPaneResult = true;
const mockOpenMacPrivacySettings = vi.fn(
  async (..._args: unknown[]) => mockOpenPaneResult as boolean,
);

vi.mock("./system/macPermissions", () => ({
  openMacPrivacySettings: (...args: unknown[]) =>
    mockOpenMacPrivacySettings(...args),
}));

vi.mock("./i18n", () => ({
  t: (key: string, ...args: unknown[]) =>
    args.length > 0 ? `${key}:${String(args[0])}` : key,
}));

import {
  FULL_DISK_ACCESS_SETTING_KEY,
  checkFullDiskAccess,
  probeFullDiskAccess,
  isFullDiskAccessPromptDismissed,
  getFullDiskAccessStatus,
  openFullDiskAccessSettings,
  initFullDiskAccessGuard,
  _resetFullDiskAccessForTest,
} from "./fullDiskAccess";

// ---- platform 桩化：默认 darwin（本文件核心分支），用例内可改 ----
const REAL_PLATFORM = process.platform;

function stubPlatform(value: string): void {
  Object.defineProperty(process, "platform", {
    value,
    configurable: true,
  });
}

/** 取 initFullDiskAccessGuard 注册的某个 app.on 监听器并触发 */
function fireAppEvent(event: string, ...args: unknown[]): void {
  const call = mockAppOn.mock.calls.find(([evt]) => evt === event);
  expect(call, `app.on("${event}") 未注册`).toBeDefined();
  (call![1] as (...a: unknown[]) => void)(...args);
}

/** 构造假窗口并触发其 ready-to-show（初始化引导的真实触发沿） */
async function fireWindowReadyToShow(): Promise<void> {
  const win = { once: vi.fn() };
  fireAppEvent("browser-window-created", {}, win);
  const readyCall = vi.mocked(win.once).mock.calls.find(
    ([evt]) => evt === "ready-to-show",
  );
  expect(readyCall, "win.once(ready-to-show) 未注册").toBeDefined();
  (readyCall![1] as () => void)();
  // runInitPromptOnce 是 void 触发的 async 链：探针子进程 close → 判定 → 可选
  // dialog。等探针派生后空转两拍让整链落定，再由用例断言 dialog 有无。
  await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
  await settleProbe();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  _resetFullDiskAccessForTest();
  stubPlatform("darwin");
  nextProbeCode = 0;
  mockSpawn.mockClear();
  mockSettingValue = null;
  mockWriteSetting.mockClear().mockReturnValue(true);
  mockDialogShow.mockClear().mockResolvedValue({ response: 1 });
  mockAppOn.mockClear();
  mockPowerMonitorOn.mockClear();
  mockShellOpenExternal.mockClear().mockResolvedValue(true);
  mockOpenMacPrivacySettings.mockClear();
  mockOpenPaneResult = true;
  mockGetName.mockClear().mockReturnValue("Nuwax");
  mockAppRelaunch.mockClear();
  mockAppExit.mockClear();
  mockAppQuit.mockClear();
});

afterEach(() => {
  stubPlatform(REAL_PLATFORM);
});

/** 等待探针子进程 close 回调落定（queueMicrotask 已足够，再加一拍保险） */
async function settleProbe(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

// ── checkFullDiskAccess ──

describe("checkFullDiskAccess", () => {
  it("子进程探针 exit 0 → granted，且用 execPath + ELECTRON_RUN_AS_NODE 派生", async () => {
    nextProbeCode = 0;
    await expect(checkFullDiskAccess()).resolves.toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mockSpawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(cmd).toBe(process.execPath);
    expect(args[0]).toBe("-e");
    expect(opts.env.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("子进程探针 exit 2（EPERM）→ denied", async () => {
    nextProbeCode = 2;
    await expect(checkFullDiskAccess()).resolves.toBe(false);
  });

  it("非 darwin 恒 true 且不派生子进程", async () => {
    stubPlatform("win32");
    await expect(checkFullDiskAccess()).resolves.toBe(true);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("spawn 同步抛错 → unknown；旧布尔 API 仍不误弹引导", async () => {
    mockSpawn.mockImplementationOnce(() => {
      throw new Error("spawn boom");
    });
    await expect(probeFullDiskAccess()).resolves.toBe("unknown");
    mockSpawn.mockImplementationOnce(() => {
      throw new Error("spawn boom");
    });
    await expect(checkFullDiskAccess()).resolves.toBe(true);
  });

  it("子进程异常退出 → unknown，不记录未授权", async () => {
    nextProbeCode = null;
    await expect(probeFullDiskAccess()).resolves.toBe("unknown");
    expect(mockDialogShow).not.toHaveBeenCalled();
  });

  it("探针目标异常而非权限拒绝 → unknown", async () => {
    nextProbeCode = 3;
    await expect(probeFullDiskAccess()).resolves.toBe("unknown");
  });
});

// ── 拒绝标记 ──

describe("isFullDiskAccessPromptDismissed", () => {
  it("对象形态 { dismissed: true } 与历史裸 true 均视为已拒绝", () => {
    mockSettingValue = { dismissed: true };
    expect(isFullDiskAccessPromptDismissed()).toBe(true);
    mockSettingValue = true;
    expect(isFullDiskAccessPromptDismissed()).toBe(true);
  });

  it("缺省/异常值视为未拒绝", () => {
    mockSettingValue = null;
    expect(isFullDiskAccessPromptDismissed()).toBe(false);
    mockSettingValue = { dismissed: false };
    expect(isFullDiskAccessPromptDismissed()).toBe(false);
    mockSettingValue = "garbage";
    expect(isFullDiskAccessPromptDismissed()).toBe(false);
  });
});

// ── getFullDiskAccessStatus ──

describe("getFullDiskAccessStatus", () => {
  it("状态快照：明确拒绝", async () => {
    nextProbeCode = 2;
    mockSettingValue = { dismissed: true };
    await expect(getFullDiskAccessStatus()).resolves.toEqual({
      supported: true,
      granted: false,
      probeStatus: "denied",
      dismissed: true,
    });
  });

  it("探测无法启动时状态为 unknown，不能显示已授权", async () => {
    mockSpawn.mockImplementationOnce(() => {
      throw new Error("spawn boom");
    });
    await expect(getFullDiskAccessStatus()).resolves.toEqual({
      supported: true,
      granted: false,
      probeStatus: "unknown",
      dismissed: false,
    });
  });

  it("探测超时也显示 unknown，不冒充已授权", async () => {
    vi.useFakeTimers();
    const kill = vi.fn();
    mockSpawn.mockImplementationOnce(() => ({ on: vi.fn(), kill }));
    try {
      const status = getFullDiskAccessStatus();
      await vi.advanceTimersByTimeAsync(5000);
      await expect(status).resolves.toMatchObject({
        granted: false,
        probeStatus: "unknown",
      });
      expect(kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("非 darwin：supported=false/granted=true", async () => {
    stubPlatform("linux");
    await expect(getFullDiskAccessStatus()).resolves.toEqual({
      supported: false,
      granted: true,
      probeStatus: "granted",
      dismissed: false,
    });
  });
});

// ── openFullDiskAccessSettings ──

describe("openFullDiskAccessSettings", () => {
  it("面板 URL 打开成功 → 不走兜底", async () => {
    await expect(openFullDiskAccessSettings()).resolves.toBe(true);
    expect(mockOpenMacPrivacySettings).toHaveBeenCalledWith("file_access");
    expect(mockShellOpenExternal).not.toHaveBeenCalled();
  });

  it("面板 URL 失败 → 兜底打开隐私主面板", async () => {
    mockOpenPaneResult = false;
    await expect(openFullDiskAccessSettings()).resolves.toBe(true);
    expect(mockShellOpenExternal).toHaveBeenCalledWith(
      "x-apple.systempreferences:com.apple.preference.security",
    );
  });

  it("两级均失败 → false 不抛错", async () => {
    mockOpenPaneResult = false;
    mockShellOpenExternal.mockRejectedValueOnce(new Error("boom"));
    await expect(openFullDiskAccessSettings()).resolves.toBe(false);
  });
});

// ── initFullDiskAccessGuard：接线与一次性引导 ──

describe("initFullDiskAccessGuard", () => {
  it("非 darwin：零注册零引导", () => {
    stubPlatform("win32");
    initFullDiskAccessGuard();
    expect(mockAppOn).not.toHaveBeenCalled();
    expect(mockPowerMonitorOn).not.toHaveBeenCalled();
  });

  it("darwin：注册窗口创建/失焦/聚焦沿与解锁/唤醒沿", () => {
    initFullDiskAccessGuard();
    expect(mockAppOn).toHaveBeenCalledWith(
      "browser-window-created",
      expect.any(Function),
    );
    expect(mockAppOn).toHaveBeenCalledWith(
      "browser-window-blur",
      expect.any(Function),
    );
    expect(mockAppOn).toHaveBeenCalledWith(
      "browser-window-focus",
      expect.any(Function),
    );
    expect(mockPowerMonitorOn).toHaveBeenCalledWith(
      "unlock-screen",
      expect.any(Function),
    );
    expect(mockPowerMonitorOn).toHaveBeenCalledWith(
      "resume",
      expect.any(Function),
    );
  });

  it("未授权且未拒绝 → 主窗口首帧弹一次引导窗", async () => {
    initFullDiskAccessGuard();
    nextProbeCode = 2;
    await fireWindowReadyToShow();
    expect(mockDialogShow).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalled();
  });

  it("点「暂不」（response 1）→ 持久化 dismissed", async () => {
    initFullDiskAccessGuard();
    nextProbeCode = 2;
    mockDialogShow.mockResolvedValueOnce({ response: 1 });
    await fireWindowReadyToShow();
    expect(mockWriteSetting).toHaveBeenCalledWith(
      FULL_DISK_ACCESS_SETTING_KEY,
      { dismissed: true },
    );
  });

  it("点「去开启」（response 0）→ 打开 FDA 面板且不写 dismissed", async () => {
    initFullDiskAccessGuard();
    nextProbeCode = 2;
    mockDialogShow.mockResolvedValueOnce({ response: 0 });
    await fireWindowReadyToShow();
    expect(mockOpenMacPrivacySettings).toHaveBeenCalledWith("file_access");
    expect(mockWriteSetting).not.toHaveBeenCalled();
  });

  it("已授权 → 不弹窗", async () => {
    initFullDiskAccessGuard();
    // 探针默认 exit 0（granted）
    await fireWindowReadyToShow();
    expect(mockDialogShow).not.toHaveBeenCalled();
  });

  it("探测无法判断 → 不弹引导，也不声称已授权", async () => {
    initFullDiskAccessGuard();
    mockSpawn.mockImplementationOnce(() => {
      throw new Error("spawn boom");
    });
    await fireWindowReadyToShow();
    expect(mockDialogShow).not.toHaveBeenCalled();
    mockSpawn.mockImplementationOnce(() => {
      throw new Error("spawn boom");
    });
    await expect(getFullDiskAccessStatus()).resolves.toMatchObject({
      granted: false,
      probeStatus: "unknown",
    });
  });

  it("未授权但用户拒绝过（dismissed）→ 不弹窗", async () => {
    initFullDiskAccessGuard();
    nextProbeCode = 2;
    mockSettingValue = { dismissed: true };
    await fireWindowReadyToShow();
    expect(mockDialogShow).not.toHaveBeenCalled();
  });

  it("同会话第二扇窗口首帧 → 不再弹（每会话至多一次）", async () => {
    initFullDiskAccessGuard();
    nextProbeCode = 2;
    await fireWindowReadyToShow();
    await fireWindowReadyToShow();
    expect(mockDialogShow).toHaveBeenCalledTimes(1);
  });

  it("聚焦沿只静默复查（探针执行）绝不弹窗", async () => {
    initFullDiskAccessGuard();
    nextProbeCode = 2;
    fireAppEvent("browser-window-focus", {}, {});
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
    await settleProbe();
    expect(mockDialogShow).not.toHaveBeenCalled();
  });

  it("重复调用幂等（不重复注册监听）", () => {
    initFullDiskAccessGuard();
    initFullDiskAccessGuard();
    const createdCalls = mockAppOn.mock.calls.filter(
      ([evt]) => evt === "browser-window-created",
    );
    expect(createdCalls).toHaveLength(1);
  });
});

// ── 授权翻转 → 重启提示 ──

describe("授权翻转重启提示", () => {
  it("打开设置后真实失焦再返回：探针仍 blocked 也弹一次重启提示", async () => {
    initFullDiskAccessGuard();
    nextProbeCode = 2;
    mockDialogShow.mockResolvedValueOnce({ response: 0 });
    await fireWindowReadyToShow();
    mockDialogShow.mockClear().mockResolvedValue({ response: 1 });

    fireAppEvent("browser-window-blur", {}, {});
    fireAppEvent("browser-window-focus", {}, {});

    await vi.waitFor(() => expect(mockDialogShow).toHaveBeenCalledTimes(1));
    const options = (mockDialogShow.mock.calls[0][1] ??
      mockDialogShow.mock.calls[0][0]) as { type: string };
    expect(options.type).toBe("info");
  });

  it("打开设置后未观察到失焦就聚焦：不误弹重启提示", async () => {
    initFullDiskAccessGuard();
    nextProbeCode = 2;
    mockDialogShow.mockResolvedValueOnce({ response: 0 });
    await fireWindowReadyToShow();
    mockDialogShow.mockClear();

    fireAppEvent("browser-window-focus", {}, {});
    await settleProbe();

    expect(mockDialogShow).not.toHaveBeenCalled();
  });

  it("原生 modal 已预先失焦：超过切换保护期再聚焦仍弹重启提示", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      initFullDiskAccessGuard();
      nextProbeCode = 2;
      mockDialogShow.mockResolvedValueOnce({ response: 0 });
      await fireWindowReadyToShow();
      mockDialogShow.mockClear().mockResolvedValue({ response: 1 });

      nowSpy.mockReturnValue(2000);
      fireAppEvent("browser-window-focus", {}, {});

      await vi.waitFor(() => expect(mockDialogShow).toHaveBeenCalledTimes(1));
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("打开系统设置失败：后续失焦/聚焦不留下伪重启提示", async () => {
    initFullDiskAccessGuard();
    nextProbeCode = 2;
    mockOpenPaneResult = false;
    mockShellOpenExternal.mockRejectedValueOnce(new Error("boom"));
    mockDialogShow.mockResolvedValueOnce({ response: 0 });
    await fireWindowReadyToShow();
    mockDialogShow.mockClear();

    fireAppEvent("browser-window-blur", {}, {});
    fireAppEvent("browser-window-focus", {}, {});
    await settleProbe();

    expect(mockDialogShow).not.toHaveBeenCalled();
  });

  it("用户已点过「暂不开启」：从设置返回也不再弹重启提示", async () => {
    initFullDiskAccessGuard();
    nextProbeCode = 2;
    mockSettingValue = { dismissed: true };
    await fireWindowReadyToShow();
    expect(mockDialogShow).not.toHaveBeenCalled();

    await openFullDiskAccessSettings();
    fireAppEvent("browser-window-blur", {}, {});
    fireAppEvent("browser-window-focus", {}, {});
    await settleProbe();

    expect(mockDialogShow).not.toHaveBeenCalled();
  });

  it("用户已点过「暂不开启」：探针由 blocked→passed 也不主动提示", async () => {
    mockSettingValue = { dismissed: true };
    nextProbeCode = 2;
    await checkFullDiskAccess();
    nextProbeCode = 0;
    await checkFullDiskAccess();
    await settleProbe();

    expect(mockDialogShow).not.toHaveBeenCalled();
  });

  it("会话内 未授权→已授权 翻转 → 弹一次重启提示（info 窗）", async () => {
    nextProbeCode = 2;
    await checkFullDiskAccess();
    await settleProbe();
    nextProbeCode = 0;
    mockDialogShow.mockClear().mockResolvedValue({ response: 1 });
    await checkFullDiskAccess();
    await vi.waitFor(() => expect(mockDialogShow).toHaveBeenCalledTimes(1));
    const options = (mockDialogShow.mock.calls[0][1] ??
      mockDialogShow.mock.calls[0][0]) as { type: string };
    expect(options.type).toBe("info");
  });

  it("启动即已授权（无翻转）→ 永不弹重启提示", async () => {
    await checkFullDiskAccess();
    await checkFullDiskAccess();
    await settleProbe();
    expect(mockDialogShow).not.toHaveBeenCalled();
  });

  it("重启提示每会话至多一次（翻转后反复复查不重复弹）", async () => {
    nextProbeCode = 2;
    await checkFullDiskAccess();
    await settleProbe();
    nextProbeCode = 0;
    mockDialogShow.mockClear().mockResolvedValue({ response: 1 });
    await checkFullDiskAccess();
    await checkFullDiskAccess();
    await checkFullDiskAccess();
    await vi.waitFor(() => expect(mockDialogShow).toHaveBeenCalledTimes(1));
    await settleProbe();
    expect(mockDialogShow).toHaveBeenCalledTimes(1);
  });

  it("dev（非打包）点「立即重启」→ relaunch + quit（走 before-quit 清理链，不再裸 exit）", async () => {
    nextProbeCode = 2;
    await checkFullDiskAccess();
    await settleProbe();
    nextProbeCode = 0;
    mockDialogShow.mockClear().mockResolvedValueOnce({ response: 0 });
    await checkFullDiskAccess();
    await vi.waitFor(() => expect(mockDialogShow).toHaveBeenCalledTimes(1));
    await settleProbe();
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockAppRelaunch).toHaveBeenCalledTimes(1);
    expect(mockAppQuit).toHaveBeenCalledTimes(1);
    expect(mockAppExit).not.toHaveBeenCalled();
  });

  it("打包版点「立即重启」→ relaunch + quit（走 before-quit 清理链，不再裸 exit）", async () => {
    const electronMock = (await vi.importMock("electron")) as {
      app: { isPackaged: boolean };
    };
    electronMock.app.isPackaged = true;
    try {
      nextProbeCode = 2;
      await checkFullDiskAccess();
      await settleProbe();
      nextProbeCode = 0;
      mockDialogShow.mockClear().mockResolvedValueOnce({ response: 0 });
      await checkFullDiskAccess();
      await vi.waitFor(() => expect(mockDialogShow).toHaveBeenCalledTimes(1));
      await vi.waitFor(() =>
        expect(mockAppRelaunch).toHaveBeenCalledTimes(1),
      );
      expect(mockAppQuit).toHaveBeenCalledTimes(1);
      expect(mockAppExit).not.toHaveBeenCalled();
    } finally {
      electronMock.app.isPackaged = false;
    }
  });
});
