import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ exposed: new Map<string, any>(), invoke: vi.fn() }));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: (key: string, value: unknown) => mocks.exposed.set(key, value) },
  ipcRenderer: { invoke: mocks.invoke, send: vi.fn(), on: vi.fn() },
}));
import "./webviewPerfBridge";
it("passes artifact save URL/name to its own IPC channel and returns the write result", async () => {
  mocks.invoke.mockResolvedValueOnce({ success: true, path: "/tmp/report.html" });
  const result = await mocks.exposed.get("NuwaClawBridge").native.saveFile("/report.html", "report.html");
  expect(mocks.invoke).toHaveBeenCalledWith("native:saveFile", { url: "/report.html", filename: "report.html" });
  expect(result).toEqual({ success: true, path: "/tmp/report.html" });
});
