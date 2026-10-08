import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loadNative, readSettings, warn } = vi.hoisted(() => ({
  loadNative: vi.fn(), readSettings: vi.fn(), warn: vi.fn(),
}));
vi.mock("node:module", () => ({ createRequire: () => loadNative }));
vi.mock("electron-log", () => ({ default: { warn } }));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  loadNative.mockReturnValue({ readSettings });
});
afterEach(() => Object.defineProperty(process, "platform", platform));

describe("macOS system notification permission", () => {
  it.each([[0, "denied"], [1, "denied"], [2, "granted"], [3, "granted"], [-1, "unknown"], [4, "unknown"], [99, "unknown"]])(
    "maps authorization status %s to %s", async (status, expected) => {
      readSettings.mockResolvedValue(status);
      const { checkMacNotificationPermission } = await import("./macNotificationPermission");
      expect(await checkMacNotificationPermission()).toBe(expected);
      expect(loadNative).toHaveBeenCalledWith(expect.stringMatching(/mac-notification-permission\.node$/));
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
  it.each(["win32", "linux"])("does not load native code on %s", async (value) => {
    Object.defineProperty(process, "platform", { value, configurable: true });
    const { checkMacNotificationPermission } = await import("./macNotificationPermission");
    expect(await checkMacNotificationPermission()).toBe("unknown");
    expect(loadNative).not.toHaveBeenCalled();
  });
});
