import { afterEach, describe, expect, it, vi } from "vitest";
import { CuaRuntimeRecovery } from "./runtimeRecovery";

afterEach(() => vi.useRealTimers());
describe("CUA runtime recovery", () => {
  it("deduplicates repairs and retries a transient failure with backoff", async () => {
    vi.useFakeTimers();
    const repair = vi.fn().mockRejectedValueOnce(new Error("daemonNotReady")).mockResolvedValue(undefined);
    const state = vi.fn();
    const recovery = new CuaRuntimeRecovery({ allowed: () => true, repair, state });
    recovery.request(); recovery.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(repair).toHaveBeenCalledTimes(1);
    expect(state).toHaveBeenCalledWith("degraded", "daemonNotReady");
    await vi.advanceTimersByTimeAsync(1300);
    expect(repair).toHaveBeenCalledTimes(2);
    expect(state).toHaveBeenLastCalledWith("ready");
    recovery.cancel();
  });
  it("a late repair cannot publish ready after revocation", async () => {
    vi.useFakeTimers();
    let finish!: () => void, allowed = true;
    const state = vi.fn(), repair = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const recovery = new CuaRuntimeRecovery({ allowed: () => allowed, repair, state });
    recovery.request(); await vi.advanceTimersByTimeAsync(0);
    allowed = false; recovery.cancel(); finish();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state).not.toHaveBeenCalledWith("ready");
    expect(repair).toHaveBeenCalledOnce();
  });
  it.each(["permissionsRequired", "policyNotActive", "helperStillRunning"])("does not retry %s without user action", async reason => {
    vi.useFakeTimers();
    const repair = vi.fn().mockRejectedValue(new Error(reason)), state = vi.fn();
    const recovery = new CuaRuntimeRecovery({ allowed: () => true, repair, state });
    recovery.request(); await vi.advanceTimersByTimeAsync(120_000);
    expect(repair).toHaveBeenCalledOnce();
    recovery.cancel();
  });
});
