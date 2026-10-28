import { describe, expect, it, vi } from "vitest";
import { createLocalFilesBridge } from "./local-files";
import { LOCAL_FILES_IPC as CH } from "@shared/features/local-files/contract";

describe("本机文件 preload 契约", () => {
  it("所有调用只转发指定命令与参数；旧/关闭宿主探测返回不可用", async () => {
    const invoke = vi.fn().mockResolvedValue({ success: true, data: {} });
    const bridge = createLocalFilesBridge({ invoke });
    const target = { contextId: "ctx", path: "doc.txt" };
    await bridge.stat(target); expect(invoke).toHaveBeenLastCalledWith(CH.STAT, target);
    await bridge.preparePreview(target); expect(invoke).toHaveBeenLastCalledWith(CH.PREPARE_PREVIEW, target);
    await bridge.saveFile(target, { operationId: "save" }); expect(invoke).toHaveBeenLastCalledWith(CH.SAVE_FILE, target, { operationId: "save" });
    await bridge.exportWorkspace("ctx", { operationId: "zip" }); expect(invoke).toHaveBeenLastCalledWith(CH.EXPORT_WORKSPACE, "ctx", { operationId: "zip" });
    await bridge.releasePreview("grant"); expect(invoke).toHaveBeenLastCalledWith(CH.RELEASE_PREVIEW, "grant");
    await bridge.releaseContext("ctx"); expect(invoke).toHaveBeenLastCalledWith(CH.RELEASE_CONTEXT, "ctx");
    invoke.mockRejectedValue(new Error("No handler"));
    expect(await bridge.getCapabilities()).toEqual({ apiVersion: 3, available: false });
    await expect(bridge.releasePreview("grant")).resolves.toBeUndefined();
  });
});
