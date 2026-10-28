/**
 * 单元测试: preload 特性命名空间汇总
 *
 * 覆盖：业务页命名空间含 capture/localFiles，宿主壳命名空间含
 * notices/computerUse/features/capture；canUse 特性侧探测按命名空间归属派发。
 */

import { describe, it, expect, vi } from "vitest";
import { featureNamespaces, hostFeatureNamespaces, probeFeatureCapability } from "./index";
import { HOST_CAPTURE_MENU_IPC } from "@shared/features/capture/contract";

describe("命名空间汇总", () => {
  const ipc = { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() } as never;

  it("业务页命名空间包含 capture 与 localFiles", () => {
    expect(Object.keys(featureNamespaces(ipc))).toEqual(["capture", "localFiles"]);
  });

  it("宿主壳通过独立通道提供 notices/computerUse/features/capture", () => {
    expect(Object.keys(hostFeatureNamespaces(ipc))).toEqual(["notices", "computerUse", "features", "capture"]);
  });

  it("canUse 特性侧探测按命名空间归属派发，非特性命名空间返回 null", async () => {
    expect(probeFeatureCapability("theme", { methods: ["syncTheme"] }, "theme.syncTheme", {}, async () => true)).toBeNull();
    const authorize = vi.fn(async () => true);
    const bridge = { capture: { getCapabilities: async () => ({ available: true, formats: { still: ["png"], video: ["mp4"], gif: false } }) } };
    await expect(probeFeatureCapability("capture", { methods: ["screenshot"], variant: "png" }, "capture.screenshot.png", bridge, authorize)).resolves.toBe(true);
    await expect(probeFeatureCapability("capture", { methods: ["record"], variant: "gif" }, "capture.record.gif", bridge, authorize)).resolves.toBe(false);
    const offline = { capture: { getCapabilities: async () => ({ available: false }) } };
    await expect(probeFeatureCapability("capture", { methods: ["screenshot"] }, "capture.screenshot", offline, authorize)).resolves.toBe(false);
    await expect(probeFeatureCapability("localFiles", { methods: ["listFiles"] }, "localFiles.listFiles",
      { localFiles: { getCapabilities: async () => ({ apiVersion: 1, available: true }) } }, authorize)).resolves.toBe(true);
    await expect(probeFeatureCapability("localFiles", { methods: ["listFiles"] }, "localFiles.listFiles",
      { localFiles: { getCapabilities: async () => ({ apiVersion: 1, available: false }) } }, authorize)).resolves.toBe(false);
  });

  it("原生捕获菜单事件只给 host，校验命令并解除真实 listener", () => {
    const on = vi.fn();
    const removeListener = vi.fn();
    const privateIpc = { invoke: vi.fn(), on, removeListener } as never;
    expect("onMenuAction" in featureNamespaces(privateIpc).capture).toBe(false);
    const listener = vi.fn();
    const off = hostFeatureNamespaces(privateIpc).capture.onMenuAction!(listener);
    const [channel, handler] = on.mock.calls[0];
    expect(channel).toBe(HOST_CAPTURE_MENU_IPC);
    for (const action of ["screenshot", "mp4", "webm", "gif", "delete", {}, null]) handler({}, action);
    expect(listener.mock.calls).toEqual([["screenshot"], ["mp4"], ["webm"], ["gif"]]);
    off();
    expect(removeListener).toHaveBeenCalledWith(HOST_CAPTURE_MENU_IPC, handler);
  });
});
