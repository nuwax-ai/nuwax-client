import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchPermissionSnapshot } from "./permissionPolling";
import type { PermissionSnapshot } from "@shared/types/permissionOnboarding";
let document: EventTarget & { hidden: boolean };
let window: EventTarget;
const value = { items: [] } as unknown as PermissionSnapshot;
beforeEach(() => {
  vi.useFakeTimers();
  document = Object.assign(new EventTarget(), { hidden: false });
  window = new EventTarget();
});
afterEach(() => vi.useRealTimers());
function setup(read = vi.fn().mockResolvedValue(value)) {
  const update = vi.fn(),
    error = vi.fn();
  const stop = watchPermissionSnapshot({
    read,
    update,
    error,
    document,
    window,
  });
  return { read, update, error, stop };
}
describe("visible permission polling", () => {
  it("polls every 1.5 seconds, refreshes on focus, and stops on unmount", async () => {
    const h = setup();
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.read).toHaveBeenCalledTimes(3);
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(h.read).toHaveBeenCalledTimes(4);
    h.stop();
    expect(vi.getTimerCount()).toBe(0);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.read).toHaveBeenCalledTimes(4);
  });
  it("pauses on hidden and immediately checks on show", async () => {
    const h = setup();
    await Promise.resolve();
    document.hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.read).toHaveBeenCalledTimes(1);
    document.hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(h.read).toHaveBeenCalledTimes(2);
    h.stop();
  });
  it("has no timer when initially hidden", async () => {
    document.hidden = true;
    const h = setup();
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.read).not.toHaveBeenCalled();
    h.stop();
  });
  it("does not overlap and ignores results after hide or unmount", async () => {
    let resolve!: (value: PermissionSnapshot) => void;
    const h = setup(
      vi.fn().mockReturnValue(
        new Promise((r) => {
          resolve = r;
        }),
      ),
    );
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.read).toHaveBeenCalledTimes(1);
    document.hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    resolve(value);
    await Promise.resolve();
    expect(h.update).not.toHaveBeenCalled();
    h.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("ignores a response after stop and retries failures while visible", async () => {
    const h = setup(vi.fn().mockRejectedValue(new Error("unavailable")));
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.error).toHaveBeenCalledTimes(2);
    h.stop();
    let resolve!: (value: PermissionSnapshot) => void;
    const late = setup(
      vi.fn().mockReturnValue(
        new Promise((r) => {
          resolve = r;
        }),
      ),
    );
    late.stop();
    resolve(value);
    await Promise.resolve();
    expect(late.update).not.toHaveBeenCalled();
  });
});
