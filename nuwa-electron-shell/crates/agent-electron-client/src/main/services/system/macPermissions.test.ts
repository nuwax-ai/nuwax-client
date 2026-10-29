import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { openExternal, openPath, requestPermission } = vi.hoisted(() => ({
  openExternal: vi.fn(),
  openPath: vi.fn(),
  requestPermission: vi.fn(),
}));
vi.mock("electron", () => ({ shell: { openExternal, openPath } }));
vi.mock("./macNotificationPermission", () => ({ requestMacNotificationPermission: requestPermission }));
vi.mock("electron-log", () => ({ default: { error: vi.fn() } }));
import { isMacPrivacyPane, openMacPrivacySettings } from "./macPermissions";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(process, "platform", {
    value: "darwin",
    configurable: true,
  });
  openExternal.mockResolvedValue(undefined);
  openPath.mockResolvedValue("");
  requestPermission.mockResolvedValue("granted");
});
afterEach(() => Object.defineProperty(process, "platform", platform));

describe("macOS notification settings entry", () => {
  it.each([
    ["screen_recording", "Privacy_ScreenCapture"],
    ["accessibility", "Privacy_Accessibility"],
    ["file_access", "Privacy_AllFiles"],
  ] as const)(
    "maps %s and falls back to Privacy & Security",
    async (key, suffix) => {
      expect(await openMacPrivacySettings(key)).toBe(true);
      expect(openExternal).toHaveBeenLastCalledWith(
        `x-apple.systempreferences:com.apple.preference.security?${suffix}`,
      );
      openExternal.mockRejectedValueOnce(new Error("missing pane"));
      expect(await openMacPrivacySettings(key)).toBe(true);
      expect(openExternal).toHaveBeenLastCalledWith(
        "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension",
      );
      openExternal.mockRejectedValue(new Error("missing settings"));
      expect(await openMacPrivacySettings(key)).toBe(false);
    },
  );
  it("accepts notifications and rejects prototype/unsupported keys", () => {
    expect(isMacPrivacyPane("notifications")).toBe(true);
    for (const key of ["constructor", "toString", "__proto__", "invalid"])
      expect(isMacPrivacyPane(key)).toBe(false);
  });
  it("opens the Notifications settings pane", async () => {
    expect(await openMacPrivacySettings("notifications")).toBe(true);
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(requestPermission.mock.invocationCallOrder[0]).toBeLessThan(openExternal.mock.invocationCallOrder[0]);
    expect(openExternal).toHaveBeenCalledWith(
      "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
    );
    expect(openPath).not.toHaveBeenCalled();
  });
  it("waits for the explicit authorization request before opening settings", async () => {
    let resolve!: (status: string) => void;
    requestPermission.mockReturnValue(new Promise<string>(done => { resolve = done; }));
    const result = openMacPrivacySettings("notifications");
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(openExternal).not.toHaveBeenCalled();
    resolve("denied");
    expect(await result).toBe(true);
    expect(openExternal).toHaveBeenCalledOnce();
  });
  it.each(["denied", "unknown"])("still opens settings when authorization is %s", async (status) => {
    requestPermission.mockResolvedValue(status);
    expect(await openMacPrivacySettings("notifications")).toBe(true);
    expect(openExternal).toHaveBeenCalledOnce();
  });
  it("falls back to System Settings when the deep link fails", async () => {
    openExternal.mockRejectedValue(new Error("Unavailable pane"));
    expect(await openMacPrivacySettings("notifications")).toBe(true);
    expect(openPath).toHaveBeenCalledWith(
      "/System/Applications/System Settings.app",
    );
  });
  it.each(["error string", "throw"])(
    "reports fallback failure: %s",
    async (failure) => {
      openExternal.mockRejectedValue(new Error("Unavailable pane"));
      if (failure === "throw")
        openPath.mockRejectedValue(new Error("Open failed"));
      else openPath.mockResolvedValue("Application missing");
      expect(await openMacPrivacySettings("notifications")).toBe(false);
    },
  );
  it.each(["win32", "linux"])(
    "does not open macOS settings on %s",
    async (value) => {
      Object.defineProperty(process, "platform", { value, configurable: true });
      expect(await openMacPrivacySettings("notifications")).toBe(false);
      expect(openExternal).not.toHaveBeenCalled();
      expect(openPath).not.toHaveBeenCalled();
      expect(requestPermission).not.toHaveBeenCalled();
    },
  );
});
