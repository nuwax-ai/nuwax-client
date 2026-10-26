import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HandlerContext } from "@shared/types/ipc";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => Promise<any>>(),
  existing: vi.fn(),
  create: vi.fn(),
  enabled: vi.fn(),
  setEnabled: vi.fn(),
  refreshTray: vi.fn(),
  rawGet: vi.fn(),
  rawSet: vi.fn(),
}));
vi.mock("electron", () => ({
  ipcMain: { handle: (name: string, handler: any) => mocks.handlers.set(name, handler) },
  app: { getLoginItemSettings: mocks.rawGet, setLoginItemSettings: mocks.rawSet },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {}, shell: {}, systemPreferences: {},
}));
vi.mock("electron-log", () => ({ default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock("../bootstrap/logConfig", () => ({ LATEST_LOG_BASENAME: "latest.log" }));
vi.mock("../services/autoUpdater", () => ({}));
vi.mock("../services/system/deviceId", () => ({}));
vi.mock("../services/system/macNotificationPermission", () => ({}));
vi.mock("../services/system/macPermissions", () => ({}));
vi.mock("../services/frontendDistVersion", () => ({}));
vi.mock("../window/trayManager", () => ({ getTrayManager: () => ({ refreshAutoLaunchState: mocks.refreshTray }) }));
vi.mock("../window/autoLaunchManager", () => ({
  getAutoLaunchManager: mocks.existing,
  createAutoLaunchManager: mocks.create,
}));
vi.mock("../services/i18n", () => ({ t: (key: string) => key }));
vi.mock("./bridgeTrust", () => ({}));
import { registerAppHandlers } from "./appHandlers";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.handlers.clear();
  mocks.existing.mockReturnValue(null);
  mocks.create.mockReturnValue({ isEnabled: mocks.enabled, setEnabled: mocks.setEnabled });
  mocks.enabled.mockResolvedValue(true);
  mocks.setEnabled.mockResolvedValue(true);
  mocks.rawGet.mockReturnValue({ openAtLogin: false });
  registerAppHandlers({} as HandlerContext);
});

describe("autolaunch IPC shares the manager policy", () => {
  it("reads through the same platform policy even before the manager exists", async () => {
    expect(await mocks.handlers.get("autolaunch:get")!()).toBe(true);
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.rawGet).not.toHaveBeenCalled();
  });

  it("does not reintroduce hidden macOS login settings through the fallback", async () => {
    expect(await mocks.handlers.get("autolaunch:set")!({}, true)).toEqual({ success: true });
    expect(mocks.setEnabled).toHaveBeenCalledWith(true);
    expect(mocks.rawSet).not.toHaveBeenCalled();
    expect(mocks.refreshTray).toHaveBeenCalledOnce();
  });

  it("reports a rejected fallback setting instead of broadcasting success", async () => {
    mocks.setEnabled.mockResolvedValue(false);
    expect((await mocks.handlers.get("autolaunch:set")!({}, false)).success).toBe(false);
    expect(mocks.refreshTray).not.toHaveBeenCalled();
    expect(mocks.rawSet).not.toHaveBeenCalled();
  });

  it("reuses the existing manager", async () => {
    mocks.existing.mockReturnValue({ isEnabled: mocks.enabled, setEnabled: mocks.setEnabled });
    await mocks.handlers.get("autolaunch:set")!({}, false);
    expect(mocks.setEnabled).toHaveBeenCalledWith(false);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
