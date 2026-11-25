/**
 * 单元测试: acpSetupBudgets — 会话建立阶段的预算与超时包装
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ACP_SETUP_BUDGETS_ENV,
  ACP_SETUP_DEFAULT_BUDGETS,
  AcpSetupTimeoutError,
  getAcpSetupBudgets,
  isAcpSetupTimeoutError,
  parseSetupTimeoutStage,
  resetAcpSetupBudgetsCacheForTests,
  resolveAcpSetupBudgets,
  setupTimeoutMessage,
  withSetupTimeout,
} from "./acpSetupBudgets";

describe("resolveAcpSetupBudgets", () => {
  it("无环境变量时返回默认预算", () => {
    expect(resolveAcpSetupBudgets({})).toEqual(ACP_SETUP_DEFAULT_BUDGETS);
  });

  it("环境变量可按字段覆盖，未给出的字段保持默认", () => {
    const budgets = resolveAcpSetupBudgets({
      [ACP_SETUP_BUDGETS_ENV]: JSON.stringify({ loadHardMs: 90_000, minRetryMs: 30000.7 }),
    });
    expect(budgets.loadHardMs).toBe(90_000);
    expect(budgets.minRetryMs).toBe(30_000);
    expect(budgets.newSessionHardMs).toBe(ACP_SETUP_DEFAULT_BUDGETS.newSessionHardMs);
  });

  it("非法 JSON 或非正数回落默认值", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveAcpSetupBudgets({ [ACP_SETUP_BUDGETS_ENV]: "{not json" })).toEqual(
        ACP_SETUP_DEFAULT_BUDGETS,
      );
      expect(
        resolveAcpSetupBudgets({
          [ACP_SETUP_BUDGETS_ENV]: JSON.stringify({ loadHardMs: -1 }),
        }),
      ).toEqual(ACP_SETUP_DEFAULT_BUDGETS);
      expect(
        resolveAcpSetupBudgets({
          [ACP_SETUP_BUDGETS_ENV]: JSON.stringify({ loadHardMs: "40000" }),
        }),
      ).toEqual(ACP_SETUP_DEFAULT_BUDGETS);
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
  });

  it("软超时不允许超过硬上限", () => {
    const budgets = resolveAcpSetupBudgets({
      [ACP_SETUP_BUDGETS_ENV]: JSON.stringify({ loadSoftMs: 50_000 }),
    });
    expect(budgets.loadSoftMs).toBe(budgets.loadHardMs);
  });

  it("预算在进程内只解析一次", () => {
    resetAcpSetupBudgetsCacheForTests();
    expect(getAcpSetupBudgets()).toBe(getAcpSetupBudgets());
  });
});

describe("parseSetupTimeoutStage", () => {
  it("取回 setupTimeoutMessage 生成文案里的阶段名", () => {
    expect(parseSetupTimeoutStage(setupTimeoutMessage("handshake", 10_000))).toBe(
      "handshake",
    );
    expect(parseSetupTimeoutStage("engine spawn timed out after 10000ms")).toBe(
      "engine spawn",
    );
  });

  it("不是超时文案时返回 null", () => {
    expect(parseSetupTimeoutStage("Workspace directory does not exist: /missing")).toBeNull();
    expect(parseSetupTimeoutStage("handshake timed out")).toBeNull();
    expect(parseSetupTimeoutStage("")).toBeNull();
  });
});

describe("withSetupTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("在硬上限 reject AcpSetupTimeoutError，底层 promise 不被取消", async () => {
    vi.useFakeTimers();
    const underlying = vi.fn(() => new Promise<string>(() => {}));
    const wrapped = withSetupTimeout(underlying(), {
      stage: "new",
      hardMs: 1_000,
    });
    const rejected = expect(wrapped).rejects.toThrow(AcpSetupTimeoutError);
    await vi.advanceTimersByTimeAsync(999);
    expect(underlying).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const err = await wrapped.catch((e) => e);
    await rejected;
    expect(isAcpSetupTimeoutError(err)).toBe(true);
    expect(err.stage).toBe("new");
    expect(err.hardMs).toBe(1_000);
  });

  it("先完成则原样返回结果", async () => {
    vi.useFakeTimers();
    const result = await withSetupTimeout(Promise.resolve("ok"), {
      stage: "load",
      hardMs: 1_000,
    });
    expect(result).toBe("ok");
  });

  it("底层 reject 时透传原错误", async () => {
    vi.useFakeTimers();
    const failure = new Error("boom");
    await expect(
      withSetupTimeout(Promise.reject(failure), { stage: "load", hardMs: 1_000 }),
    ).rejects.toBe(failure);
  });

  it("到软超时调用一次 onSoft，之后仍等到结果或硬上限", async () => {
    vi.useFakeTimers();
    const onSoft = vi.fn();
    const wrapped = withSetupTimeout(
      new Promise<string>((resolve) => setTimeout(() => resolve("late"), 800)),
      { stage: "load", hardMs: 1_000, softMs: 300, onSoft },
    );
    await vi.advanceTimersByTimeAsync(299);
    expect(onSoft).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onSoft).toHaveBeenCalledTimes(1);
    expect(onSoft).toHaveBeenCalledWith({ stage: "load", softMs: 300 });
    await vi.advanceTimersByTimeAsync(500);
    expect(await wrapped).toBe("late");
    // settle 之后不再触发
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onSoft).toHaveBeenCalledTimes(1);
  });

  it("软超时前已完成则不触发 onSoft", async () => {
    vi.useFakeTimers();
    const onSoft = vi.fn();
    await withSetupTimeout(Promise.resolve("fast"), {
      stage: "load",
      hardMs: 1_000,
      softMs: 300,
      onSoft,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onSoft).not.toHaveBeenCalled();
  });

  it("onSoft 抛错不影响等待", async () => {
    vi.useFakeTimers();
    const onSoft = vi.fn(() => {
      throw new Error("logger broke");
    });
    const wrapped = withSetupTimeout(
      new Promise<string>((resolve) => setTimeout(() => resolve("ok"), 50)),
      { stage: "load", hardMs: 1_000, softMs: 10, onSoft },
    );
    await vi.advanceTimersByTimeAsync(50);
    expect(await wrapped).toBe("ok");
    expect(onSoft).toHaveBeenCalledTimes(1);
  });
});
