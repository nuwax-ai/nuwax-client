/**
 * 单元测试: preload capture 桥
 *
 * 覆盖：特性关闭（No handler registered）时 getCapabilities→available:false、其余→unsupported；
 * 处理函数真实抛错时返回 failed 且带错误信息（不静默吞）；正常结果原样透传；
 * readChunk 返回独立 ArrayBuffer（含 Buffer 池偏移场景）与 null；onStateChange 订阅/退订。
 */

import { describe, it, expect, vi } from "vitest";
import { CAPTURE_IPC } from "@shared/features/capture/contract";
import { createCaptureBridge } from "./capture";

function fakeIpc(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>) {
  const listeners = new Map<string, Set<(...a: unknown[]) => void>>();
  return {
    invoke: vi.fn(invoke),
    on: vi.fn((channel: string, fn: (...a: unknown[]) => void) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel)!.add(fn);
    }),
    removeListener: vi.fn((channel: string, fn: (...a: unknown[]) => void) => {
      listeners.get(channel)?.delete(fn);
    }),
    emit: (channel: string, ...args: unknown[]) =>
      listeners.get(channel)?.forEach((fn) => fn({}, ...args)),
  };
}

const noHandler = (channel: string) =>
  Promise.reject(new Error(`Error invoking remote method '${channel}': Error: No handler registered for '${channel}'`));

describe("特性关闭（主进程未注册 IPC）", () => {
  it("getCapabilities 返回 available:false，其余调用返回 unsupported", async () => {
    const bridge = createCaptureBridge(fakeIpc((c) => noHandler(c)) as never);
    const caps = await bridge.getCapabilities();
    expect(caps.available).toBe(false);
    expect(caps.formats).toEqual({ still: [], video: [], gif: false });
    expect(await bridge.screenshot()).toMatchObject({ success: false, code: "unsupported" });
    expect(await bridge.record({ output: "mp4" })).toMatchObject({ success: false, code: "unsupported" });
    expect(await bridge.readChunk("id", 0, 1)).toBeNull();
    await expect(bridge.cancel()).resolves.toBeUndefined();
    await expect(bridge.release("id")).resolves.toBeUndefined();
  });
});

describe("处理函数真实失败", () => {
  it("返回 failed 并带上错误信息，而不是吞掉", async () => {
    const bridge = createCaptureBridge(fakeIpc(() => Promise.reject(new Error("disk full"))) as never);
    expect(await bridge.screenshot()).toEqual({ success: false, code: "failed", error: "disk full" });
  });
});

describe("正常路径", () => {
  it("结果与参数原样透传", async () => {
    const ok = { success: true, resultId: "r1" };
    const ipc = fakeIpc(async () => ok);
    const bridge = createCaptureBridge(ipc as never);
    expect(await bridge.screenshot({ format: "png" })).toBe(ok);
    expect(ipc.invoke).toHaveBeenCalledWith(CAPTURE_IPC.SCREENSHOT, { format: "png" });
  });

  it("readChunk：返回独立的 ArrayBuffer；Buffer 池中带偏移的视图被正确切片", async () => {
    const pool = new Uint8Array([9, 9, 1, 2, 3, 9]).buffer;
    const view = new Uint8Array(pool, 2, 3);
    const bridge = createCaptureBridge(fakeIpc(async () => view) as never);
    const out = await bridge.readChunk("r1", 0, 3);
    expect(out).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(out!)]).toEqual([1, 2, 3]);

    const exact = new Uint8Array([4, 5]);
    const bridge2 = createCaptureBridge(fakeIpc(async () => exact) as never);
    expect([...new Uint8Array((await bridge2.readChunk("r", 0, 2))!)]).toEqual([4, 5]);

    const bridge3 = createCaptureBridge(fakeIpc(async () => null) as never);
    expect(await bridge3.readChunk("r", 0, 2)).toBeNull();
  });

  it("onStateChange：订阅收到状态，退订后不再收到", () => {
    const ipc = fakeIpc(async () => undefined);
    const bridge = createCaptureBridge(ipc as never);
    const seen: string[] = [];
    const off = bridge.onStateChange((s) => seen.push(s));
    ipc.emit(CAPTURE_IPC.STATE_CHANGED, "selecting");
    off();
    ipc.emit(CAPTURE_IPC.STATE_CHANGED, "idle");
    expect(seen).toEqual(["selecting"]);
  });
});
