import { afterEach, describe, expect, it, vi } from "vitest";
import { observeServiceReadiness } from "./serviceReadiness";
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
async function flush() {
  for (let i = 0; i < 8; ++i) await Promise.resolve();
}
afterEach(() => vi.useRealTimers());
function fixture() {
  const cached = deferred<{ ok: boolean } | null>();
  let listener!: (payload: unknown) => void;
  const api = {
    on: vi.fn((_event, next) => {
      listener = next;
    }),
    off: vi.fn(),
    services: {
      readyState: vi.fn(() => cached.promise),
      waitForReady: vi.fn(async () => null),
    },
  };
  const snapshot = vi.fn();
  const activity = vi.fn();
  const observer = observeServiceReadiness(api, snapshot, activity);
  return {
    cached,
    api,
    snapshot,
    activity,
    observer,
    emit: (value: unknown) => listener(value),
  };
}
describe("service readiness observation", () => {
  it("does not let an old cached failure replace a newer ready push", async () => {
    const f = fixture();
    await flush();
    f.emit({ ok: true });
    f.cached.resolve({ ok: false });
    await flush();
    expect(f.snapshot.mock.calls).toEqual([[{ ok: true }]]);
    f.observer.dispose();
  });
  it("keeps the main probe authoritative and prevents duplicate retries after IPC ack", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.cached.resolve({ ok: false });
    await flush();
    expect(f.observer.retry()).toBe(true);
    expect(f.observer.retry()).toBe(false);
    await flush();
    f.api.services.readyState.mockImplementationOnce(async () => null);
    vi.advanceTimersByTime(15_000);
    await flush();
    expect(f.activity).toHaveBeenLastCalledWith("waiting");
    expect(f.snapshot).toHaveBeenCalledTimes(1);
    f.api.services.readyState.mockImplementationOnce(async () => null);
    expect(f.observer.retry()).toBe(false);
    expect(f.api.services.waitForReady).toHaveBeenCalledTimes(1);
    f.emit({ ok: true });
    expect(f.activity).toHaveBeenLastCalledWith(null);
    f.observer.dispose();
  });
  it("unlocks after a rejected retry and ignores late work on disposal", async () => {
    const f = fixture();
    f.cached.resolve({ ok: false });
    await flush();
    f.api.services.waitForReady.mockRejectedValueOnce(
      new Error("private backend content"),
    );
    f.observer.retry();
    await flush();
    expect(f.activity).toHaveBeenLastCalledWith("failed");
    expect(f.observer.retry()).toBe(true);
    await flush();
    f.observer.dispose();
    const count = f.snapshot.mock.calls.length;
    f.emit({ ok: true });
    expect(f.snapshot).toHaveBeenCalledTimes(count);
    expect(f.api.off).toHaveBeenCalledWith(
      "services:ready",
      expect.any(Function),
    );
  });
  it("offers recovery if the readiness bridge cannot be read", async () => {
    const f = fixture();
    f.cached.reject(new Error("lost IPC"));
    await flush();
    expect(f.activity).toHaveBeenLastCalledWith("failed");
    expect(f.observer.retry()).toBe(true);
    await flush();
    f.observer.dispose();
  });
  it("rechecks an initial null snapshot without a new probe when the ready event is missing", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.cached.resolve(null);
    await flush();
    f.api.services.readyState.mockImplementationOnce(async () => ({
      ok: true,
    }));
    vi.advanceTimersByTime(15_000);
    await flush();
    expect(f.snapshot).toHaveBeenLastCalledWith({ ok: true });
    expect(f.api.services.waitForReady).not.toHaveBeenCalled();
    f.observer.dispose();
  });
  it("recovers a completed retry from the main snapshot when its ready event is missing", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.cached.resolve({ ok: false });
    await flush();
    f.observer.retry();
    await flush();
    f.api.services.readyState.mockImplementationOnce(async () => ({
      ok: false,
      elapsedMs: 30_001,
    }));
    vi.advanceTimersByTime(15_000);
    await flush();
    expect(f.snapshot).toHaveBeenLastCalledWith({
      ok: false,
      elapsedMs: 30_001,
    });
    expect(f.observer.retry()).toBe(true);
    await flush();
    expect(f.api.services.waitForReady).toHaveBeenCalledTimes(2);
    f.observer.dispose();
  });
  it("unlocks a stalled read for another safe status check without duplicate probes", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await flush();
    vi.advanceTimersByTime(15_000);
    await flush();
    f.api.services.readyState.mockImplementationOnce(async () => ({
      ok: true,
    }));
    expect(f.observer.retry()).toBe(false);
    await flush();
    expect(f.snapshot).toHaveBeenLastCalledWith({ ok: true });
    f.cached.resolve({ ok: false });
    await flush();
    expect(f.snapshot).toHaveBeenCalledTimes(1);
    expect(f.api.services.waitForReady).not.toHaveBeenCalled();
    f.observer.dispose();
  });
});
