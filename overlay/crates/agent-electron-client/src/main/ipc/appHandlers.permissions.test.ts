import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HandlerContext } from "@shared/types/ipc";

const { handlers, query, openSettings, accessibility } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => Promise<any>>(),
  query: vi.fn(), openSettings: vi.fn(), accessibility: vi.fn(),
}));
vi.mock("electron", () => ({
  ipcMain: { handle: (name: string, handler: (...args: any[]) => Promise<any>) => handlers.set(name, handler) },
  app: {}, dialog: {}, shell: {}, BrowserWindow: {},
  systemPreferences: { isTrustedAccessibilityClient: accessibility, getMediaAccessStatus: () => "granted" },
}));
vi.mock("electron-log", () => ({ default: { error: vi.fn() } }));
vi.mock("../bootstrap/logConfig", () => ({ LATEST_LOG_BASENAME: "latest.log" }));
vi.mock("../services/autoUpdater", () => ({}));
vi.mock("../services/system/deviceId", () => ({}));
vi.mock("../services/system/macNotificationPermission", () => ({ checkMacNotificationPermission: query }));
vi.mock("../services/system/macPermissions", () => ({
  isMacPrivacyPane: (key: string) => ["accessibility", "screen_recording", "file_access", "notifications"].includes(key),
  openMacPrivacySettings: openSettings,
}));
vi.mock("../services/frontendDistVersion", () => ({}));
vi.mock("../window/trayManager", () => ({}));
vi.mock("../window/autoLaunchManager", () => ({}));
vi.mock("../services/i18n", () => ({ t: (key: string) => key }));
vi.mock("./bridgeTrust", () => ({}));
import { registerAppHandlers } from "./appHandlers";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  vi.resetAllMocks(); handlers.clear();
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  accessibility.mockReturnValue(true);
  registerAppHandlers({} as HandlerContext);
});
afterEach(() => Object.defineProperty(process, "platform", platform));

describe("permissions IPC notification entry", () => {
  it.each(["granted", "denied", "unknown"])("adds system notification status %s and preserves existing rows", async (status) => {
    query.mockResolvedValue(status);
    const result = await handlers.get("permissions:check")!();
    expect(result.map((item: { key: string }) => item.key)).toEqual(["accessibility", "screen_recording", "file_access", "notifications"]);
    expect(result[3]).toEqual({
      key: "notifications", name: "Claw.PermissionsPage.macosNotifications",
      description: "Claw.PermissionsPage.macosNotificationsDesc", status,
    });
    expect(accessibility).toHaveBeenCalledWith(false);
  });
  it.each([true, false])("reports settings result %s through the existing contract", async (success) => {
    openSettings.mockResolvedValue(success);
    expect((await handlers.get("permissions:openSettings")!({}, "notifications")).success).toBe(success);
    expect(openSettings).toHaveBeenCalledWith("notifications");
  });
  it("rejects unsupported settings keys", async () => {
    expect((await handlers.get("permissions:openSettings")!({}, "invalid")).success).toBe(false);
    expect(openSettings).not.toHaveBeenCalled();
  });
  it.each(["win32", "linux"])("preserves an empty system permission list on %s", async (value) => {
    Object.defineProperty(process, "platform", { value, configurable: true });
    expect(await handlers.get("permissions:check")!()).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
