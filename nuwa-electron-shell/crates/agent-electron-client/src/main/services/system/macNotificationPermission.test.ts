import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loadNative, readSettings, requestAuthorization, warn } = vi.hoisted(() => ({
  loadNative: vi.fn(), readSettings: vi.fn(), requestAuthorization: vi.fn(), warn: vi.fn(),
}));
vi.mock("node:module", () => ({ createRequire: () => loadNative }));
vi.mock("electron-log", () => ({ default: { warn } }));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  loadNative.mockReturnValue({ readSettings, requestAuthorization });
});
afterEach(() => Object.defineProperty(process, "platform", platform));

describe("macOS system notification permission", () => {
  it.each([[0, "denied"], [1, "denied"], [2, "granted"], [3, "granted"], [-1, "unknown"], [4, "unknown"], [99, "unknown"]])(
    "maps authorization status %s to %s", async (status, expected) => {
      readSettings.mockResolvedValue(status);
      const { checkMacNotificationPermission } = await import("./macNotificationPermission");
      expect(await checkMacNotificationPermission()).toBe(expected);
      expect(loadNative).toHaveBeenCalledWith(expect.stringMatching(/mac-notification-permission\.node$/));
      expect(requestAuthorization).not.toHaveBeenCalled();
    },
  );
  it("shares concurrent queries but observes permission revocation on the next query", async () => {
    let resolve!: (status: number) => void;
    readSettings.mockReturnValueOnce(new Promise<number>((done) => { resolve = done; }));
    const { checkMacNotificationPermission } = await import("./macNotificationPermission");
    const first = checkMacNotificationPermission();
    const second = checkMacNotificationPermission();
    expect(second).toBe(first);
    await Promise.resolve();
    expect(readSettings).toHaveBeenCalledTimes(1);
    resolve(2);
    expect(await first).toBe("granted");
    readSettings.mockResolvedValueOnce(1);
    expect(await checkMacNotificationPermission()).toBe("denied");
    expect(loadNative).toHaveBeenCalledTimes(1);
  });
  it("missing addon is unknown and can recover on a later check", async () => {
    loadNative.mockImplementationOnce(() => { throw new Error("Module missing"); });
    readSettings.mockResolvedValue(2);
    const { checkMacNotificationPermission } = await import("./macNotificationPermission");
    expect(await checkMacNotificationPermission()).toBe("unknown");
    expect(await checkMacNotificationPermission()).toBe("granted");
  });
  it("native query rejection remains unknown", async () => {
    readSettings.mockRejectedValue(new Error("Query failed"));
    const { checkMacNotificationPermission } = await import("./macNotificationPermission");
    expect(await checkMacNotificationPermission()).toBe("unknown");
    expect(warn).toHaveBeenCalledOnce();
  });
  it("coalesces explicit requests independently of a pending passive check", async () => {
    let resolveCheck!: (status: number) => void;
    let resolveRequest!: (status: number) => void;
    readSettings.mockReturnValueOnce(new Promise<number>(done => { resolveCheck = done; }));
    requestAuthorization.mockReturnValueOnce(new Promise<number>(done => { resolveRequest = done; }));
    const { checkMacNotificationPermission, requestMacNotificationPermission } = await import("./macNotificationPermission");
    const check = checkMacNotificationPermission();
    const request = requestMacNotificationPermission();
    expect(requestMacNotificationPermission()).toBe(request);
    await Promise.resolve();
    expect(requestAuthorization).toHaveBeenCalledOnce();
    resolveCheck(0);
    expect(await check).toBe("denied");
    resolveRequest(2);
    expect(await request).toBe("granted");
    requestAuthorization.mockResolvedValueOnce(1);
    expect(await requestMacNotificationPermission()).toBe("denied");
    readSettings.mockResolvedValueOnce(2);
    expect(await checkMacNotificationPermission()).toBe("granted");
  });
  it.each([0, 1, 2, 3, -1])("maps the current native authorization result %s", async (status) => {
    requestAuthorization.mockResolvedValue(status);
    const { notificationPermissionStatus, requestMacNotificationPermission } = await import("./macNotificationPermission");
    expect(await requestMacNotificationPermission()).toBe(notificationPermissionStatus(status));
    expect(readSettings).not.toHaveBeenCalled();
  });
  it("recovers after an authorization failure without blocking system settings", async () => {
    requestAuthorization.mockRejectedValueOnce(new Error("Request failed")).mockResolvedValueOnce(2);
    const { requestMacNotificationPermission } = await import("./macNotificationPermission");
    expect(await requestMacNotificationPermission()).toBe("unknown");
    expect(await requestMacNotificationPermission()).toBe("granted");
    expect(warn).toHaveBeenCalledOnce();
  });
  it("handles a missing or outdated addon as unknown", async () => {
    loadNative.mockImplementationOnce(() => { throw new Error("Missing addon"); });
    const { requestMacNotificationPermission } = await import("./macNotificationPermission");
    expect(await requestMacNotificationPermission()).toBe("unknown");
    loadNative.mockReturnValueOnce({ readSettings });
    expect(await requestMacNotificationPermission()).toBe("unknown");
  });
  it.each(["win32", "linux"])("does not load native code on %s", async (value) => {
    Object.defineProperty(process, "platform", { value, configurable: true });
    const { checkMacNotificationPermission, requestMacNotificationPermission } = await import("./macNotificationPermission");
    expect(await checkMacNotificationPermission()).toBe("unknown");
    expect(await requestMacNotificationPermission()).toBe("unknown");
    expect(loadNative).not.toHaveBeenCalled();
  });
});
