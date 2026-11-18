import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import log from "electron-log";
import { expect, it, vi } from "vitest";
import { observeMicroAppLoadLogs } from "./microAppLoadLog";

vi.mock("electron-log", () => ({ default: { info: vi.fn(), warn: vi.fn() } }));

it("records only a structured diagnostic from the trusted top-level frame", () => {
  const line = "[MicroAppLoad] app=im attempt=1 event=auth-probe phase=im-auth durationMs=32 httpStatus=401 timeMs=1794971592000";
  const mainFrame = { url: "https://test.example" };
  const contents = Object.assign(new EventEmitter(), {
    id: 123,
    mainFrame,
    isDestroyed: () => false,
  });
  observeMicroAppLoadLogs(contents as unknown as WebContents, (frame) => frame.url === "https://test.example");
  const emit = (message: string, frame = mainFrame) => {
    contents.emit("console-message", { message, frame, level: "warning" });
  };
  emit(line + " url=https://app.test?token=private");
  emit(line + "\n");
  emit(line, { ...mainFrame });
  mainFrame.url = "https://untrusted.example";
  emit(line);
  mainFrame.url = "https://test.example";
  emit(line);
  expect(log.warn).toHaveBeenCalledOnce();
  expect(log.warn).toHaveBeenCalledWith(line, { webContentsId: 123 });
});
