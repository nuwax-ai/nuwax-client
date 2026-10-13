/**
 * 单元测试: preload 特性命名空间汇总
 *
 * 覆盖：业务页命名空间含 capture，宿主壳命名空间含 notices，互不混入。
 */

import { describe, it, expect, vi } from "vitest";
import { featureNamespaces, hostFeatureNamespaces } from "./index";
import { HOST_CAPTURE_MENU_IPC } from "@shared/features/capture/contract";

describe("命名空间汇总", () => {
  const ipc = { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() } as never;

  it("业务页命名空间只含 capture", () => {
    expect(Object.keys(featureNamespaces(ipc))).toEqual(["capture"]);
  });

  it("宿主壳通过独立通道提供 notices 与 capture", () => {
    expect(Object.keys(hostFeatureNamespaces(ipc))).toEqual(["notices", "capture"]);
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
