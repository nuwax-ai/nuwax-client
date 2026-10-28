/** guest 页点击必须通知宿主收起 Windows/Linux 自绘菜单（bug 2427）。 */
import { describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { on: vi.fn(), send, invoke: vi.fn() },
}));

describe("webview guest 顶栏菜单收起事件", () => {
  it("捕获 pointerdown 并发送主进程信号，guest 已获焦时仍有效", async () => {
    const addEventListener = vi.fn();
    vi.stubGlobal("window", { addEventListener });
    vi.resetModules();
    try {
      await import("./webviewPerfBridge");
      expect(addEventListener).toHaveBeenCalledWith(
        "pointerdown",
        expect.any(Function),
        true,
      );
      const onPointerDown = addEventListener.mock.calls.find(
        ([event]) => event === "pointerdown",
      )?.[1] as (() => void) | undefined;
      expect(onPointerDown).toBeTypeOf("function");
      onPointerDown?.();
      expect(send).toHaveBeenCalledWith("nuwax:guest-pointer-down");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
