import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DistHandshakeView } from "@shared/types/distVersionHandshake";
import { useDistHandshake } from "./useDistHandshake";

const hooks = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  states: [] as Array<{ value: unknown }>,
}));
vi.mock("react", () => ({
  useState(initial: unknown) {
    const state = { value: initial };
    hooks.states.push(state);
    return [
      initial,
      (next: unknown) => {
        state.value = typeof next === "function" ? next(state.value) : next;
      },
    ];
  },
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: (effect: () => void | (() => void)) => hooks.effects.push(effect),
}));

const cleanups: Array<() => void> = [];
const readState = () =>
  hooks.states[0].value as {
    snapshot: DistHandshakeView | null;
    observedAt: number;
  };
beforeEach(() => {
  hooks.effects.length = 0;
  hooks.states.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-30T00:00:00Z"));
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function mount(enabled = true) {
  const snapshot = { checkedAt: Date.now() - 60_000 } as DistHandshakeView;
  const getDistHandshake = vi.fn().mockResolvedValue(snapshot);
  vi.stubGlobal("window", {
    electronAPI: { app: { getDistHandshake } },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  useDistHandshake(enabled);
  for (const effect of hooks.effects) {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  }
  return { snapshot, getDistHandshake };
}

describe("dist handshake relative check time", () => {
  it("advances the display clock without rechecking cloud, and stops on unmount", async () => {
    const { snapshot, getDistHandshake } = mount();
    await vi.advanceTimersByTimeAsync(0);
    const observedAt = readState().observedAt;
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(readState().observedAt).toBe(observedAt + 2 * 60_000);
    expect(readState().snapshot).toBe(snapshot);
    expect(getDistHandshake).toHaveBeenCalledTimes(1);
    for (const cleanup of cleanups.splice(0)) cleanup();
    expect(vi.getTimerCount()).toBe(0);
    const stoppedAt = readState().observedAt;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readState().observedAt).toBe(stoppedAt);
  });
  it("does not schedule a clock or read snapshots while disabled", async () => {
    const { getDistHandshake } = mount(false);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(getDistHandshake).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
