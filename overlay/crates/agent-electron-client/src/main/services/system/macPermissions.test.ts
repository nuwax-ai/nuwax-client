import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { openExternal, openPath } = vi.hoisted(() => ({ openExternal: vi.fn(), openPath: vi.fn() }));
vi.mock("electron", () => ({ shell: { openExternal, openPath } }));
vi.mock("electron-log", () => ({ default: { error: vi.fn() } }));
import { isMacPrivacyPane, openMacPrivacySettings } from "./macPermissions";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  openExternal.mockResolvedValue(undefined);
  openPath.mockResolvedValue("");
});
afterEach(() => Object.defineProperty(process, "platform", platform));

describe("macOS notification settings entry", () => {
  it("accepts notifications and rejects prototype/unsupported keys", () => {
    expect(isMacPrivacyPane("notifications")).toBe(true);
    for (const key of ["constructor", "toString", "__proto__", "invalid"]) expect(isMacPrivacyPane(key)).toBe(false);
  });
  it("opens the Notifications settings pane", async () => {
    expect(await openMacPrivacySettings("notifications")).toBe(true);
    expect(openExternal).toHaveBeenCalledWith("x-apple.systempreferences:com.apple.Notifications-Settings.extension");
    expect(openPath).not.toHaveBeenCalled();
  });
  it("falls back to System Settings when the deep link fails", async () => {
    openExternal.mockRejectedValue(new Error("Unavailable pane"));
    expect(await openMacPrivacySettings("notifications")).toBe(true);
    expect(openPath).toHaveBeenCalledWith("/System/Applications/System Settings.app");
  });
  it.each(["error string", "throw"])("reports fallback failure: %s", async (failure) => {
    openExternal.mockRejectedValue(new Error("Unavailable pane"));
    if (failure === "throw") openPath.mockRejectedValue(new Error("Open failed"));
    else openPath.mockResolvedValue("Application missing");
    expect(await openMacPrivacySettings("notifications")).toBe(false);
  });
  it.each(["win32", "linux"])("does not open macOS settings on %s", async (value) => {
    Object.defineProperty(process, "platform", { value, configurable: true });
    expect(await openMacPrivacySettings("notifications")).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
    expect(openPath).not.toHaveBeenCalled();
  });
});
