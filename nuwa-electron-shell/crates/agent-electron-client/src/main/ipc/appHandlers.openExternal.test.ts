import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HandlerContext } from "@shared/types/ipc";

const { handlers, openExternal } = vi.hoisted(() => ({
  handlers: new Map<string, (event: any, url: any) => Promise<any>>(),
  openExternal: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: { handle: (name: string, handler: any) => handlers.set(name, handler) },
  app: { isPackaged: false },
  dialog: {},
  shell: { openExternal },
  BrowserWindow: {},
  systemPreferences: { isTrustedAccessibilityClient: () => false, getMediaAccessStatus: () => "granted" },
}));
vi.mock("electron-log", () => ({ default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock("../bootstrap/logConfig", () => ({ LATEST_LOG_BASENAME: "latest.log" }));
vi.mock("../services/autoUpdater", () => ({}));
vi.mock("../services/system/deviceId", () => ({}));
vi.mock("../services/system/macNotificationPermission", () => ({ checkMacNotificationPermission: vi.fn() }));
vi.mock("../services/system/macPermissions", () => ({
  isMacPrivacyPane: () => false,
  openMacPrivacySettings: vi.fn(),
}));
vi.mock("../services/frontendDistVersion", () => ({}));
vi.mock("../services/loopbackGateway", () => ({
  resolveBackendOrigin: () => "https://test.example", loopbackGatewayStatus: () => ({ running: false }),
}));
vi.mock("../services/commercialTicketSession", () => ({ ticketEpoch: () => 0 }));
vi.mock("../window/trayManager", () => ({}));
vi.mock("../window/autoLaunchManager", () => ({}));
vi.mock("../services/i18n", () => ({ t: (key: string) => key }));
vi.mock("./bridgeTrust", () => ({}));

import { registerAppHandlers } from "./appHandlers";
import { DEFAULT_DEV_SERVER_PORT } from "../services/constants";

describe("shell:openExternal security policy (regression)", () => {
  const devEntry = `http://localhost:${DEFAULT_DEV_SERVER_PORT}/`;
  const mainFrame = { url: devEntry };
  const mockHost = { mainFrame, getURL: () => devEntry, isDestroyed: () => false };
  const validEvent = { sender: mockHost, senderFrame: mainFrame };

  beforeEach(() => {
    vi.resetAllMocks();
    handlers.clear();
    registerAppHandlers({ getMainWindow: () => ({ webContents: mockHost } as any) } as HandlerContext);
  });

  it("rejects non-http(s) schemes like file: or javascript: before calling shell.openExternal", async () => {
    const handler = handlers.get("shell:openExternal");
    expect(handler).toBeDefined();

    for (const dangerousUri of [
      "file:///C:/run.exe",
      "javascript:void(0)",
      "data:text/html,test",
      "ms-msdt:/test",
      "powershell:run",
      "cmd:run",
      "mailto:test@example.com",
    ]) {
      const res = await handler!(validEvent, dangerousUri);
      expect(res.success).toBe(false);
      expect(res.error).toBe("Only HTTP(S) webpages can be opened externally");
      expect(openExternal).not.toHaveBeenCalled();
    }
  });

  it("rejects untrusted sender or foreign frame before calling shell.openExternal", async () => {
    const handler = handlers.get("shell:openExternal");
    const foreignEvent = { sender: {}, senderFrame: { url: devEntry } };
    const res = await handler!(foreignEvent, "https://example.com/");
    expect(res.success).toBe(false);
    expect(res.error).toBe("Untrusted external-open source");
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("permits valid https URL from trusted sender frame", async () => {
    const handler = handlers.get("shell:openExternal");
    openExternal.mockResolvedValue(undefined);
    const res = await handler!(validEvent, "https://example.com/docs");
    expect(res).toEqual({ success: true });
    expect(openExternal).toHaveBeenCalledWith("https://example.com/docs");
  });
});
