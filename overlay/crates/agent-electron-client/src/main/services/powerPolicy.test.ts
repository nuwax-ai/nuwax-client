/**
 * 单元测试: powerPolicy - 电源策略（「允许锁屏运行」）
 *
 * 覆盖：
 * - 纯函数：normalizePowerPolicyMode（裸字符串/存储形态 { mode }/异常值回退 off）
 * - 三档 → powerSaveBlocker 断言类型对拍（keepAwake/keepDisplayOn/off）
 * - 换档释放旧断言、同档幂等、setMode 非法值拒绝不写库
 * - initPowerPolicy 读库恢复 + 重复调用幂等
 *
 * 通过 mock electron(powerSaveBlocker) / electron-log / ../db 驱动
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockStart = vi.fn((..._args: unknown[]) => 101);
const mockStop = vi.fn((..._args: unknown[]) => undefined);
const mockIsStarted = vi.fn((..._args: unknown[]) => true);

vi.mock("electron", () => ({
  powerSaveBlocker: {
    start: (...args: unknown[]) => mockStart(...args),
    stop: (...args: unknown[]) => mockStop(...args),
    isStarted: (...args: unknown[]) => mockIsStarted(...args),
  },
}));

vi.mock("electron-log", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockWriteSetting = vi.fn((..._args: unknown[]) => true);
let mockSettingValue: unknown = null;

vi.mock("../db", () => ({
  readSetting: (_key: string) => mockSettingValue,
  writeSetting: (...args: unknown[]) => mockWriteSetting(...args),
}));

import {
  POWER_POLICY_SETTING_KEY,
  normalizePowerPolicyMode,
  getPowerPolicyMode,
  setPowerPolicyMode,
  initPowerPolicy,
  _resetPowerPolicyForTest,
} from "./powerPolicy";

beforeEach(() => {
  _resetPowerPolicyForTest();
  mockStart.mockClear().mockReturnValue(101);
  mockStop.mockClear();
  mockIsStarted.mockClear().mockReturnValue(true);
  mockWriteSetting.mockClear().mockReturnValue(true);
  mockSettingValue = null;
});

// ── normalizePowerPolicyMode ──

describe("normalizePowerPolicyMode", () => {
  it("三档合法值原样通过", () => {
    expect(normalizePowerPolicyMode("off")).toBe("off");
    expect(normalizePowerPolicyMode("keepAwake")).toBe("keepAwake");
    expect(normalizePowerPolicyMode("keepDisplayOn")).toBe("keepDisplayOn");
  });

  it("存储形态 { mode } 取字段解析", () => {
    expect(normalizePowerPolicyMode({ mode: "keepAwake" })).toBe("keepAwake");
    expect(normalizePowerPolicyMode({ mode: "off" })).toBe("off");
  });

  it("缺省/异常值一律回退 off", () => {
    expect(normalizePowerPolicyMode(null)).toBe("off");
    expect(normalizePowerPolicyMode(undefined)).toBe("off");
    expect(normalizePowerPolicyMode("nonsense")).toBe("off");
    expect(normalizePowerPolicyMode(42)).toBe("off");
    expect(normalizePowerPolicyMode({ mode: "nonsense" })).toBe("off");
    expect(normalizePowerPolicyMode({})).toBe("off");
  });
});

// ── getPowerPolicyMode ──

describe("getPowerPolicyMode", () => {
  it("从 settings 表读 { mode } 并解析", () => {
    mockSettingValue = { mode: "keepDisplayOn" };
    expect(getPowerPolicyMode()).toBe("keepDisplayOn");
  });

  it("库值缺失/异常回退 off", () => {
    mockSettingValue = null;
    expect(getPowerPolicyMode()).toBe("off");
    mockSettingValue = "garbage";
    expect(getPowerPolicyMode()).toBe("off");
  });
});

// ── setPowerPolicyMode ──

describe("setPowerPolicyMode", () => {
  it("keepAwage → 持有 prevent-app-suspension 并写库", () => {
    const result = setPowerPolicyMode("keepAwake");
    expect(result).toEqual({ mode: "keepAwake" });
    expect(mockWriteSetting).toHaveBeenCalledWith(POWER_POLICY_SETTING_KEY, {
      mode: "keepAwake",
    });
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledWith("prevent-app-suspension");
    expect(mockStop).not.toHaveBeenCalled();
  });

  it("keepDisplayOn → 持有 prevent-display-sleep", () => {
    setPowerPolicyMode("keepDisplayOn");
    expect(mockStart).toHaveBeenCalledWith("prevent-display-sleep");
  });

  it("off → 不持有断言，仅写库", () => {
    const result = setPowerPolicyMode("off");
    expect(result).toEqual({ mode: "off" });
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockWriteSetting).toHaveBeenCalledTimes(1);
  });

  it("keepAwake 换 keepDisplayOn → 先停旧断言再起新断言", () => {
    setPowerPolicyMode("keepAwake");
    mockStart.mockClear();
    setPowerPolicyMode("keepDisplayOn");
    expect(mockStop).toHaveBeenCalledWith(101);
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledWith("prevent-display-sleep");
  });

  it("任意档切 off → 释放现有断言且不再持有", () => {
    setPowerPolicyMode("keepDisplayOn");
    setPowerPolicyMode("off");
    expect(mockStop).toHaveBeenCalledWith(101);
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it("同档重复 set → 幂等不重复 start", () => {
    setPowerPolicyMode("keepAwake");
    setPowerPolicyMode("keepAwake");
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it("非法值抛错且不写库", () => {
    expect(() => setPowerPolicyMode("nonsense")).toThrow(/invalid power policy/);
    expect(() => setPowerPolicyMode(undefined)).toThrow(/invalid power policy/);
    expect(mockWriteSetting).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
  });
});

// ── initPowerPolicy ──

describe("initPowerPolicy", () => {
  it("boot 读库恢复上次档位", () => {
    mockSettingValue = { mode: "keepAwake" };
    initPowerPolicy();
    expect(mockStart).toHaveBeenCalledWith("prevent-app-suspension");
  });

  it("boot 无库值 → 保持 off 零断言", () => {
    initPowerPolicy();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("重复调用幂等，不重复 start", () => {
    mockSettingValue = { mode: "keepDisplayOn" };
    initPowerPolicy();
    initPowerPolicy();
    expect(mockStart).toHaveBeenCalledTimes(1);
  });
});
