import { afterEach, describe, expect, it, vi } from "vitest";
import type { DistHandshakeView } from "@shared/types/distVersionHandshake";
import { DIST_HANDSHAKE_READ_TIMEOUT_MS, observeDistHandshake, shouldShowDistSnapshotNotice } from "./distHandshake";

const snapshot: DistHandshakeView = {
  backendOrigin: "https://cloud.example", bundled: { name: "n", version: "3.0.3", gitHash: "aaaa111" },
  cloud: { name: "n", version: "3.0.3", gitHash: "bbbb222" }, relation: "different", checkedAt: 100,
  gateway: { origin: "http://127.0.0.1:46800", mode: "dist" },
};
afterEach(() => vi.useRealTimers());

describe("dist mismatch notice", () => {
  it("warns only for a checked mismatch displayed through the same dist gateway", () => {
    expect(shouldShowDistSnapshotNotice(snapshot, "http://127.0.0.1:46800/home")).toBe(true);
    for (const changed of [null, { ...snapshot, relation: "match" }, { ...snapshot, relation: "unknown" },
      { ...snapshot, gateway: null }, { ...snapshot, gateway: { ...snapshot.gateway!, mode: "proxy" } },
      { ...snapshot, checkedAt: null }]) {
      expect(shouldShowDistSnapshotNotice(changed as DistHandshakeView | null, "http://127.0.0.1:46800/home")).toBe(false);
    }
    for (const url of ["https://cloud.example/home", "https://external.example", "invalid", "http://user:secret@127.0.0.1:46800/home"]) {
      expect(shouldShowDistSnapshotNotice(snapshot, url)).toBe(false);
    }
  });

  it("old preload without the private method remains silent", async () => {
    const update = vi.fn(); const on = vi.fn();
    const observer = observeDistHandshake({ on }, update);
    await observer.refresh(); observer.dispose();
    expect(on).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
  });

  it("deduplicates reads and consumes a failed check without keeping an old warning", async () => {
    const getDistHandshake = vi.fn().mockResolvedValueOnce(snapshot).mockRejectedValueOnce(new Error("unavailable"));
    const update = vi.fn(); const observer = observeDistHandshake({ app: { getDistHandshake } }, update);
    const first = observer.refresh(); expect(observer.refresh(true)).toBe(first); await first;
    expect(update).toHaveBeenLastCalledWith({ snapshot, checking: false });
    await observer.refresh(true);
    expect(update).toHaveBeenLastCalledWith({ snapshot: null, checking: false });
    observer.dispose();
  });

  it("invalidates a late response when auth/domain/mode changes and cleans subscriptions", async () => {
    const listeners = new Map<string, () => void>(); const off = vi.fn();
    let finish!: (value: DistHandshakeView) => void;
    const getDistHandshake = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce({ ...snapshot, relation: "match" });
    const update = vi.fn(); const observer = observeDistHandshake({ app: { getDistHandshake }, on: (name, listener) => listeners.set(name, listener), off }, update);
    const pending = observer.refresh(); await Promise.resolve();
    listeners.get("nuwax:authChanged")!(); await observer.refresh();
    finish(snapshot); await pending;
    expect(update).toHaveBeenLastCalledWith({ snapshot: { ...snapshot, relation: "match" }, checking: false });
    observer.dispose(); expect(off).toHaveBeenCalledTimes(3);
  });

  it("removes every listener with the preload's callback wrapper bookkeeping", async () => {
    type Listener = (() => void) & { __ipcWrapper?: () => void };
    const channels = new Map<string, Set<() => void>>();
    const api = {
      app: { getDistHandshake: vi.fn().mockResolvedValue(snapshot) },
      on(event: string, callback: Listener) {
        const wrapper = () => callback();
        callback.__ipcWrapper = wrapper;
        const listeners = channels.get(event) ?? new Set();
        listeners.add(wrapper);
        channels.set(event, listeners);
      },
      off(event: string, callback: Listener) {
        channels.get(event)?.delete(callback.__ipcWrapper ?? callback);
      },
    };
    for (let visit = 0; visit < 3; visit++) {
      const update = vi.fn();
      const observer = observeDistHandshake(api, update);
      await observer.refresh();
      expect([...channels.values()].map(listeners => listeners.size)).toEqual([1, 1, 1]);
      observer.dispose();
      expect([...channels.values()].map(listeners => listeners.size)).toEqual([0, 0, 0]);
      update.mockClear();
      for (const listeners of channels.values()) for (const listener of listeners) listener();
      expect(update).not.toHaveBeenCalled();
    }
  });

  it("a hung or disposed IPC request cannot disable manual recheck forever or update unmounted UI", async () => {
    vi.useFakeTimers();
    let finish!: (value: DistHandshakeView) => void;
    const getDistHandshake = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(snapshot);
    const update = vi.fn(); const observer = observeDistHandshake({ app: { getDistHandshake } }, update);
    const first = observer.refresh(); await vi.advanceTimersByTimeAsync(DIST_HANDSHAKE_READ_TIMEOUT_MS + 1); await first;
    expect(update).toHaveBeenLastCalledWith({ snapshot: null, checking: false });
    await observer.refresh(true); expect(getDistHandshake).toHaveBeenCalledTimes(2);
    observer.dispose(); update.mockClear(); finish(snapshot); await Promise.resolve();
    expect(update).not.toHaveBeenCalled();
  });

  it("settles and releases a hung read immediately when the owner unmounts", async () => {
    vi.useFakeTimers();
    const settled = vi.fn();
    const observer = observeDistHandshake({ app: { getDistHandshake: () => new Promise(() => {}) } }, vi.fn());
    void observer.refresh().then(settled);
    observer.dispose();
    await vi.runAllTimersAsync();
    expect(settled).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
