import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HandlerContext } from "@shared/types/ipc";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  getSnapshot: vi.fn(),
}));
vi.mock("electron", () => ({
  ipcMain: { handle: (name: string, handler: any) => mocks.handlers.set(name, handler) },
  app: { isPackaged: false }, dialog: {}, shell: {}, BrowserWindow: {}, systemPreferences: {},
}));
vi.mock("electron-log", () => ({ default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock("../bootstrap/logConfig", () => ({ LATEST_LOG_BASENAME: "latest.log" }));
vi.mock("../services/autoUpdater", () => ({}));
vi.mock("../services/system/deviceId", () => ({}));
vi.mock("../services/system/macNotificationPermission", () => ({}));
vi.mock("../services/system/macPermissions", () => ({}));
vi.mock("../services/frontendDistVersion", () => ({}));
vi.mock("../services/distVersionHandshake", () => ({ distHandshake: { getSnapshot: mocks.getSnapshot } }));
vi.mock("../services/loopbackGateway", () => ({
  resolveBackendOrigin: () => "https://current.example",
  loopbackGatewayStatus: () => ({ running: true, origin: "http://127.0.0.1:46800", mode: "dist" }),
}));
vi.mock("../services/commercialTicketSession", () => ({ ticketEpoch: () => 9 }));
vi.mock("../services/auth/businessOrigins", () => ({ businessBridgeOrigins: () => [], httpOrigin: () => null }));
vi.mock("../window/trayManager", () => ({}));
vi.mock("../window/autoLaunchManager", () => ({}));
vi.mock("../services/i18n", () => ({ t: (key: string) => key }));
import { registerAppHandlers } from "./appHandlers";

describe("bundled frontend diagnostic IPC authorization", () => {
  const mainFrame = { url: "file:///app/index.html" };
  const host = { mainFrame, getURL: () => mainFrame.url };

  beforeEach(() => {
    vi.resetAllMocks(); mocks.handlers.clear();
    mocks.getSnapshot.mockResolvedValue({ backendOrigin: "https://current.example", bundled: null, cloud: null, relation: "unknown", checkedAt: null });
    registerAppHandlers({ getMainWindow: () => ({ webContents: host }) } as unknown as HandlerContext);
  });

  it("only accepts the shell's local main frame, not a business guest or child frame", () => {
    const read = mocks.handlers.get("app:getDistHandshake")!;
    for (const event of [
      { sender: { mainFrame, getURL: () => "https://current.example" }, senderFrame: mainFrame },
      { sender: host, senderFrame: { url: mainFrame.url } },
    ]) expect(() => read(event, true)).toThrow("Host renderer required");
    expect(mocks.getSnapshot).not.toHaveBeenCalled();
  });

  it("derives source and session in main and does not treat a caller's URL as force", async () => {
    await mocks.handlers.get("app:getDistHandshake")!({ sender: host, senderFrame: mainFrame }, "https://untrusted.example?token=secret");
    expect(mocks.getSnapshot).toHaveBeenCalledWith("https://current.example", { force: false, scope: 9 });
  });
});
