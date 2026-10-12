/**
 * 单元测试: preload 的 notices 桥
 *
 * 覆盖：正常透传；特性关闭（No handler registered）或任何错误时返回 null，不抛错。
 */

import { describe, it, expect, vi } from "vitest";
import { NOTICES_IPC } from "@shared/features/open-source-notices/contract";
import { createNoticesBridge } from "./open-source-notices";

describe("createNoticesBridge", () => {
  it("透传 get 与 getLicenseText", async () => {
    const doc = { schema: 1, components: [] };
    const invoke = vi.fn(async (channel: string) => (channel === NOTICES_IPC.GET ? doc : "MIT text"));
    const bridge = createNoticesBridge({ invoke } as never);
    expect(await bridge.get()).toBe(doc);
    expect(await bridge.getLicenseText("ripgrep")).toBe("MIT text");
    expect(invoke).toHaveBeenCalledWith(NOTICES_IPC.GET_LICENSE_TEXT, "ripgrep");
  });

  it("特性关闭或出错：返回 null，不抛错", async () => {
    const invoke = vi.fn(() => Promise.reject(new Error("No handler registered for 'notices:get'")));
    const bridge = createNoticesBridge({ invoke } as never);
    expect(await bridge.get()).toBeNull();
    expect(await bridge.getLicenseText("x")).toBeNull();
  });
});
