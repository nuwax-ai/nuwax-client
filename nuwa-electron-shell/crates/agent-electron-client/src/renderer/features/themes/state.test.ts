import { describe, it, expect, vi } from "vitest";
import type {
  HostThemesBridge,
  HostThemesState,
} from "@shared/types/hostBridge";
import { createDesktopThemesStore, observeThemes } from "./state";
const state = (revision: number) => ({ revision } as HostThemesState);
describe("desktop theme observer", () => {
  it("subscribes before reading, rejects stale reads/events and stops after disposal", async () => {
    let notify!: (state: HostThemesState) => void;
    let resolve!: (state: HostThemesState | null) => void;
    const unsubscribe = vi.fn();
    const changed = vi.fn();
    const order: string[] = [];
    const bridge = {
      onChanged: (listener: typeof notify) => {
        order.push("subscribe");
        notify = listener;
        return unsubscribe;
      },
      getState: () => {
        order.push("read");
        return new Promise<HostThemesState | null>((r) => {
          resolve = r;
        });
      },
    } as unknown as HostThemesBridge;
    const dispose = observeThemes(bridge, changed);
    expect(order).toEqual(["subscribe", "read"]);
    notify(state(5));
    resolve(state(2));
    await Promise.resolve();
    notify(state(4));
    notify(state(5));
    expect(changed.mock.calls).toEqual([[state(5)]]);
    notify(state(6));
    dispose();
    notify(state(7));
    expect(changed.mock.calls).toEqual([[state(5)], [state(6)]]);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it("handles absent/older bridges and does not let a null read erase an event", async () => {
    const changed = vi.fn();
    observeThemes(undefined, changed)();
    expect(changed).toHaveBeenLastCalledWith(null);
    let notify!: (state: HostThemesState) => void;
    const bridge = {
      onChanged: (listener: typeof notify) => {
        notify = listener;
        return vi.fn();
      },
      getState: async () => null,
    } as unknown as HostThemesBridge;
    const dispose = observeThemes(bridge, changed);
    notify(state(3));
    await Promise.resolve();
    expect(changed).toHaveBeenLastCalledWith(state(3));
    dispose();
    const old = observeThemes(bridge, changed);
    await Promise.resolve();
    expect(changed).toHaveBeenLastCalledWith(null);
    old();
  });
  it("consumes failed reads and ignores reads after disposal", async () => {
    const changed = vi.fn();
    const bridge = {
      onChanged: () => vi.fn(),
      getState: async () => {
        throw new Error("offline");
      },
    } as unknown as HostThemesBridge;
    const dispose = observeThemes(bridge, changed);
    dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(changed).not.toHaveBeenCalled();
  });
});

it("shares one host subscription and releases it only after the final consumer leaves", async () => {
  const unsubscribe = vi.fn();
  const onChanged = vi.fn(() => unsubscribe);
  const getState = vi.fn(async () => state(1));
  const store = createDesktopThemesStore({
    onChanged,
    getState,
  } as unknown as HostThemesBridge);
  const first = store.subscribe(vi.fn());
  const second = store.subscribe(vi.fn());
  await Promise.resolve();
  expect(onChanged).toHaveBeenCalledOnce();
  expect(getState).toHaveBeenCalledOnce();
  expect(store.getSnapshot()).toEqual(state(1));
  first();
  expect(unsubscribe).not.toHaveBeenCalled();
  second();
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(store.getSnapshot()).toBeNull();
});
