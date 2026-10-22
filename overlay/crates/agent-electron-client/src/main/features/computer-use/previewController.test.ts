import { afterEach, describe, expect, it, vi } from "vitest";
import { createCuaPreviewController } from "./previewController";

afterEach(() => vi.useRealTimers());
describe("display-only preview scheduling", () => {
  it("keeps one capture in flight and discards a frame after task selection changes", async () => {
    vi.useFakeTimers();
    let resolve!: (frame: any) => void;
    const capture = vi.fn(() => new Promise<any>(r => { resolve = r; }));
    const publish = vi.fn();
    const controller = createCuaPreviewController({ identity: id => ({ taskId: id, bindingId: id, epoch: 1 }), capture, publish });
    controller.select("A");
    await vi.advanceTimersByTimeAsync(2000);
    expect(capture).toHaveBeenCalledTimes(1);
    controller.select("B");
    resolve({ taskId: "A", status: "ready", frame: { jpeg: "old" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(publish.mock.calls.some(([value]) => value.frame)).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(capture).toHaveBeenLastCalledWith("B");
    controller.dispose();
    resolve({ taskId: "B", status: "ready" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(capture).toHaveBeenCalledTimes(2);
  });
  it("invalidates a pending frame on rebind, lock or task completion without waiting for capture", async () => {
    vi.useFakeTimers();
    let identity: any = { taskId: "A", bindingId: "first", epoch: 1 };
    let resolve!: (value: any) => void;
    const publish = vi.fn(), capture = vi.fn(() => new Promise<any>(r => { resolve = r; }));
    const controller = createCuaPreviewController({ identity: () => identity, capture, publish });
    controller.select("A");
    identity = { ...identity, bindingId: "second", epoch: 2 }; controller.sync();
    expect(publish).toHaveBeenLastCalledWith({ taskId: "A", status: "loading" });
    identity = null; controller.sync();
    expect(publish).toHaveBeenLastCalledWith({ taskId: "A", status: "ended" });
    resolve({ taskId: "A", status: "ready", frame: {} });
    await vi.advanceTimersByTimeAsync(1000);
    expect(publish.mock.calls.some(([value]) => value.frame)).toBe(false);
    controller.dispose();
  });
  it("stops capture when collapsed and does not exceed two frames per second on runtime updates", async () => {
    vi.useFakeTimers();
    const capture = vi.fn(async () => ({ taskId: "A", status: "unavailable" as const }));
    const controller = createCuaPreviewController({ identity: id => ({ taskId: id, bindingId: id, epoch: 1 }), capture, publish: vi.fn() });
    controller.select("A");
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 10; i++) controller.select("A");
    expect(capture).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(capture).toHaveBeenCalledTimes(3);
    controller.select(null);
    await vi.advanceTimersByTimeAsync(2000);
    expect(capture).toHaveBeenCalledTimes(3);
    controller.dispose();
  });
});
