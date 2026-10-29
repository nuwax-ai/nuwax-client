import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  fda: vi.fn(),
  dismissed: vi.fn(),
  screen: vi.fn(),
  ax: vi.fn(),
  notification: vi.fn(),
  sources: vi.fn(),
  settings: vi.fn(),
  relaunch: vi.fn(),
  quit: vi.fn(),
  showItemInFolder: vi.fn(),
  packaged: false,
  exePath: "/Applications/Electron.app/Contents/MacOS/Electron",
}));
vi.mock("electron", () => ({
  app: {
    getPath: () => mock.exePath,
    get isPackaged() { return mock.packaged; },
    relaunch: mock.relaunch,
    quit: mock.quit,
    on: vi.fn(),
  },
  shell: { showItemInFolder: mock.showItemInFolder },
  desktopCapturer: { getSources: mock.sources },
  systemPreferences: {
    getMediaAccessStatus: mock.screen,
    isTrustedAccessibilityClient: mock.ax,
  },
}));
vi.mock("electron-log", () => ({ default: { warn: vi.fn() } }));
vi.mock("@shared/constants", () => ({ APP_DISPLAY_NAME: "女娲Nuwax" }));
vi.mock("../db", () => ({ readSetting: mock.read, writeSetting: mock.write }));
vi.mock("./fullDiskAccess", () => ({
  probeFullDiskAccess: mock.fda,
  isFullDiskAccessPromptDismissed: mock.dismissed,
}));
vi.mock("./system/macNotificationPermission", () => ({
  checkMacNotificationPermission: mock.notification,
}));
vi.mock("./system/macPermissions", () => ({
  openMacPrivacySettings: mock.settings,
}));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let service: typeof import("./permissionOnboarding");
beforeEach(async () => {
  vi.resetAllMocks();
  vi.resetModules();
  mock.packaged = false;
  mock.exePath = "/Applications/Electron.app/Contents/MacOS/Electron";
  Object.defineProperty(process, "platform", {
    value: "darwin",
    configurable: true,
  });
  mock.screen.mockReturnValue("denied");
  mock.fda.mockResolvedValue("denied");
  mock.ax.mockReturnValue(false);
  mock.notification.mockResolvedValue("unknown");
  mock.sources.mockResolvedValue([]);
  mock.settings.mockResolvedValue(true);
  service = await import("./permissionOnboarding");
});
afterEach(() => Object.defineProperty(process, "platform", platform));
describe("permission onboarding snapshot", () => {
  it("is read-only, names the actual bundle, and distinguishes unknown", async () => {
    expect(await service.getPermissionSnapshot()).toMatchObject({
      platform: "darwin",
      appName: "Electron",
      appPath: "/Applications/Electron.app",
      seen: false,
      helperAvailable: false,
      items: [
        { key: "screen_recording", status: "denied" },
        { key: "file_access", status: "denied" },
        { key: "notifications", status: "unknown" },
      ],
    });
    expect(mock.ax).not.toHaveBeenCalled();
    expect(mock.sources).not.toHaveBeenCalled();
    expect(mock.settings).not.toHaveBeenCalled();
  });
  it("marks fresh grants pending restart, preserves it on unknown, and detects revocation", async () => {
    await service.getPermissionSnapshot();
    mock.screen.mockReturnValue("granted");
    mock.fda.mockResolvedValue("granted");
    expect(
      (await service.getPermissionSnapshot()).items
        .slice(0, 2)
        .map((i) => i.status),
    ).toEqual(["restart_required", "restart_required"]);
    mock.fda.mockResolvedValue("unknown");
    expect((await service.getPermissionSnapshot()).items[1].status).toBe(
      "restart_required",
    );
    mock.fda.mockResolvedValue("denied");
    expect((await service.getPermissionSnapshot()).items[1].status).toBe(
      "denied",
    );
  });
  it("does not ask for restart when already granted at launch", async () => {
    mock.screen.mockReturnValue("granted");
    mock.fda.mockResolvedValue("granted");
    expect(
      (await service.getPermissionSnapshot()).items
        .slice(0, 2)
        .map((i) => i.status),
    ).toEqual(["granted", "granted"]);
  });
  it("isolates detection failure to one row", async () => {
    mock.screen.mockImplementation(() => {
      throw new Error("unavailable");
    });
    expect(
      (await service.getPermissionSnapshot()).items.map((i) => i.status),
    ).toEqual(["unknown", "denied", "unknown"]);
  });
  it("coalesces concurrent checks", async () => {
    let resolve!: (status: string) => void;
    mock.fda.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const first = service.getPermissionSnapshot();
    const second = service.getPermissionSnapshot();
    expect(first).toBe(second);
    expect(mock.fda).toHaveBeenCalledTimes(1);
    resolve("denied");
    await first;
  });
  it.each(["win32", "linux"])(
    "has no macOS rows or checks on %s",
    async (value) => {
      Object.defineProperty(process, "platform", { value, configurable: true });
      expect((await service.getPermissionSnapshot()).items).toEqual([]);
      expect(mock.fda).not.toHaveBeenCalled();
      expect(mock.ax).not.toHaveBeenCalled();
      expect(
        await service.openGuidedPermissionSettings("screen_recording"),
      ).toBe(false);
    },
  );
  it("persists seen separately and respects the old FDA skip", async () => {
    service.markPermissionOnboardingSeen();
    expect(mock.write).toHaveBeenCalledWith(
      service.PERMISSION_ONBOARDING_SETTING,
      true,
    );
    mock.dismissed.mockReturnValue(true);
    expect((await service.getPermissionSnapshot()).seen).toBe(true);
  });
  it("does not surface the authorization window on Windows", () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
    const provider = vi.fn();
    service.setPermissionGuideWindowProvider(provider);
    expect(service.openPermissionGuide("overview")).toBe(false);
    expect(service.openPermissionGuide("screen_recording")).toBe(false);
    expect(provider).not.toHaveBeenCalled();
  });
  it("keeps helper identity independent and requests only on a click", async () => {
    const adapter = {
      check: vi.fn().mockResolvedValue({
        accessibility: "granted",
        screen_recording: "denied",
      }),
      request: vi.fn().mockResolvedValue(true),
      enabled: () => true,
      appPath: () => "/Applications/Nuwax Computer Use.app",
    };
    const unregister = service.registerHelperPermissionAdapter(adapter);
    const snapshot = await service.getPermissionSnapshot();
    expect(snapshot.items.slice(3).map((i) => i.status)).toEqual([
      "granted",
      "denied",
    ]);
    expect(adapter.check).toHaveBeenCalledTimes(1);
    expect(adapter.request).not.toHaveBeenCalled();
    await service.openGuidedPermissionSettings("helper_screen_recording");
    expect(adapter.request).not.toHaveBeenCalled();
    expect(mock.settings).toHaveBeenCalledWith("screen_recording");
    expect(mock.sources).not.toHaveBeenCalled();
    unregister();
    expect(
      await service.openGuidedPermissionSettings("helper_accessibility"),
    ).toBe(false);
  });
  it("registers only the host screen permission on its explicit row action", async () => {
    await service.openGuidedPermissionSettings("screen_recording");
    expect(mock.sources).toHaveBeenCalledTimes(1);
    expect(mock.settings).toHaveBeenCalledWith("screen_recording");
    expect(
      await service.openGuidedPermissionSettings("accessibility" as any),
    ).toBe(false);
    expect(mock.ax).not.toHaveBeenCalled();
    expect(await service.openGuidedPermissionSettings("__proto__" as any)).toBe(
      false,
    );
  });
  it("distinguishes an installed but disabled helper and keeps its actions inactive", async () => {
    const request = vi.fn();
    service.registerHelperPermissionAdapter({
      check: async () => ({ accessibility: "denied", screen_recording: "denied" }),
      request,
      appPath: () => "/Applications/Nuwax Computer Use.app",
      enabled: () => false,
    });
    expect(await service.getPermissionSnapshot()).toMatchObject({ helperAvailable: true, helperAppAvailable: true, helperEnabled: false });
    expect(await service.openGuidedPermissionSettings("helper_accessibility")).toBe(false);
    expect(await service.showPermissionDragChip("helper_accessibility")).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(mock.settings).not.toHaveBeenCalled();
  });
  it("uses relaunch plus normal quit for cleanup", () => {
    service.restartForPermissions();
    expect(mock.relaunch).toHaveBeenCalledTimes(1);
    expect(mock.quit).toHaveBeenCalledTimes(1);
  });
  it("resolves drag identities only for mac list-type keys", () => {
    expect(service.getPermissionDragIdentity("screen_recording")).toBeNull();
    expect(service.getPermissionDragIdentity("notifications")).toBeNull();
    expect(service.getPermissionDragIdentity("__proto__" as any)).toBeNull();
    const main = service.getPermissionDragIdentity("file_access");
    expect(main).toMatchObject({
      key: "file_access",
      appName: "Electron",
      appPath: "/Applications/Electron.app",
    });
    // No adapter registered: helper rows have nothing to drag.
    expect(service.getPermissionDragIdentity("helper_accessibility")).toBeNull();
  });
  it("drags the helper bundle only while its adapter exposes a path", () => {
    const unregister = service.registerHelperPermissionAdapter({
      check: async () => ({ accessibility: "unknown", screen_recording: "unknown" }),
      request: async () => false,
    });
    expect(service.getPermissionDragIdentity("helper_screen_recording")).toBeNull();
    unregister();
    const withPath = service.registerHelperPermissionAdapter({
      check: async () => ({ accessibility: "unknown", screen_recording: "unknown" }),
      request: async () => false,
      appPath: () => "/Applications/Nuwax Computer Use.app",
    });
    expect(service.getPermissionDragIdentity("helper_accessibility")).toMatchObject({
      key: "helper_accessibility",
      appName: "Nuwax Computer Use",
      appPath: "/Applications/Nuwax Computer Use.app",
    });
    withPath();
  });
  it("uses the packaged product display name without changing the dragged bundle", () => {
    mock.packaged = true;
    mock.exePath = "/Applications/Nuwax.app/Contents/MacOS/Nuwax";
    expect(service.getPermissionDragIdentity("file_access")).toEqual({
      key: "file_access", appName: "女娲Nuwax", appPath: "/Applications/Nuwax.app",
    });
  });
  it("rejects drag chip requests without a resolvable identity", async () => {
    expect(await service.showPermissionDragChip("screen_recording")).toBe(false);
    expect(await service.showPermissionDragChip("__proto__" as any)).toBe(false);
    // helper rows without a registered adapter path have nothing to drag
    expect(await service.showPermissionDragChip("helper_accessibility")).toBe(false);
    expect(service.hidePermissionDragChip()).toBe(true);
  });
  it("hide cancels a helper card still checking enable intent", async () => {
    let release!: (enabled: boolean) => void;
    service.registerHelperPermissionAdapter({
      check: async () => ({ accessibility: "unknown", screen_recording: "unknown" }),
      request: async () => false,
      appPath: () => "/Applications/Nuwax Computer Use.app",
      enabled: () => new Promise(resolve => { release = resolve; }),
    });
    const pending = service.showPermissionDragChip("helper_accessibility");
    service.hidePermissionDragChip();
    release(true);
    expect(await pending).toBe(false);
  });
  it("only guides raw OS errors for a current document with FDA denied", async () => {
    const win = {
      isDestroyed: () => false,
      isMinimized: () => true,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      webContents: { send: vi.fn() },
    };
    service.setPermissionGuideWindowProvider(() => win as any);
    await service.guideForFileAccessError(
      { code: "permission-denied" },
      () => true,
    );
    await service.guideForFileAccessError({ code: "EPERM" }, () => false);
    expect(win.webContents.send).not.toHaveBeenCalled();
    await service.guideForFileAccessError({ code: "EACCES" }, () => true);
    expect(win.webContents.send).toHaveBeenCalledWith(
      "permissions:guide",
      "file_access",
    );
    mock.fda.mockResolvedValue("granted");
    await service.guideForFileAccessError({ code: "EPERM" }, () => true);
    expect(win.webContents.send).toHaveBeenCalledTimes(1);
  });
});
