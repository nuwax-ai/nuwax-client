import { describe, expect, it, vi } from "vitest";
import { createThemesBridge, themesCapabilityProbe } from "./themes";
import { THEMES_CHANGED } from "@shared/features/themes/contract";
import type { HostThemesState } from "@shared/types/hostBridge";
const state = (revision: number) => ({ revision } as HostThemesState);
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
describe("themes preload", () => {
  it("re-reads invalidations, ignores stale responses, and cleans up listeners and pending reads", async () => {
    const reads: ((value: HostThemesState) => void)[] = [];
    const ipc = {
      invoke: vi.fn((channel: string) =>
        channel.endsWith("getState")
          ? new Promise<HostThemesState>((resolve) => reads.push(resolve))
          : Promise.resolve()
      ),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const bridge = createThemesBridge(ipc as never);
    const listener = vi.fn();
    const off = bridge.onChanged(listener);
    const changed = ipc.on.mock.calls[0][1] as (
      event: unknown,
      rev: unknown
    ) => void;
    expect(ipc.on.mock.calls[0][0]).toBe(THEMES_CHANGED);
    changed(null, 2);
    reads[1](state(2));
    await tick();
    reads[0](state(1));
    await tick();
    expect(listener.mock.calls).toEqual([[state(2)]]);
    changed(null, { files: "must never be used" });
    expect(reads).toHaveLength(2);
    changed(null, 3);
    off();
    reads[2](state(3));
    await tick();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(ipc.removeListener).toHaveBeenCalledWith(THEMES_CHANGED, changed);
    expect(ipc.invoke).toHaveBeenCalledWith("themes:unsubscribe");
  });
  it("does not return a getState response older than an observed invalidation", async () => {
    const reads: ((value: HostThemesState) => void)[] = [];
    const ipc = {
      invoke: vi.fn((channel: string) =>
        channel.endsWith("getState")
          ? new Promise<HostThemesState>((resolve) => reads.push(resolve))
          : Promise.resolve()
      ),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const bridge = createThemesBridge(ipc as never);
    const off = bridge.onChanged(vi.fn());
    const pending = bridge.getState();
    const changed = ipc.on.mock.calls[0][1] as (
      event: unknown,
      rev: unknown
    ) => void;
    changed(null, 3);
    reads[1](state(2));
    expect(await pending).toBeNull();
    off();
    reads[0](state(1));
    reads[2](state(3));
    await tick();
  });
  it("uses separate host channels and preserves the canonical method arguments", async () => {
    const ipc = {
      invoke: vi.fn(async () => null),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const bridge = createThemesBridge(ipc as never, true);
    await bridge.select("id", "system", true);
    expect(ipc.invoke).toHaveBeenCalledWith(
      "host:themes:select",
      "id",
      "system",
      true
    );
    await bridge.install({}, true);
    expect(ipc.invoke).toHaveBeenCalledWith("host:themes:install", {}, true);
    expect(
      await themesCapabilityProbe(
        {},
        "themes",
        { themes: bridge },
        async () => true
      )
    ).toBe(false);
  });
});
