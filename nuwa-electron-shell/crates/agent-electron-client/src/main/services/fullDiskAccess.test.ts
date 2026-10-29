import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  read: vi.fn(),
  settings: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("electron-log", () => ({ default: { warn: vi.fn() } }));
vi.mock("../db", () => ({ readSetting: mocks.read }));
vi.mock("./system/macPermissions", () => ({
  openMacPrivacySettings: mocks.settings,
}));
import {
  getFullDiskAccessStatus,
  isFullDiskAccessPromptDismissed,
  openFullDiskAccessSettings,
  probeFullDiskAccess,
} from "./fullDiskAccess";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let child: EventEmitter & { kill: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  Object.defineProperty(process, "platform", {
    value: "darwin",
    configurable: true,
  });
  child = Object.assign(new EventEmitter(), { kill: vi.fn() });
  mocks.spawn.mockReturnValue(child);
});
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process, "platform", platform);
});
describe("silent FDA probe", () => {
  it.each([
    [0, "granted"],
    [2, "denied"],
    [3, "unknown"],
    [null, "unknown"],
  ])("maps exit %s to %s", async (code, expected) => {
    const pending = probeFullDiskAccess();
    child.emit("close", code);
    expect(await pending).toBe(expected);
    expect(mocks.spawn.mock.calls[0][2].env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(mocks.settings).not.toHaveBeenCalled();
  });
  it("reports timeout without changing permissions", async () => {
    const pending = probeFullDiskAccess();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toBe("unknown");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("close", 0);
  });
  it("handles spawn failure and asynchronous error", async () => {
    mocks.spawn.mockImplementationOnce(() => {
      throw new Error("spawn failed");
    });
    expect(await probeFullDiskAccess()).toBe("unknown");
    const pending = probeFullDiskAccess();
    child.emit("error", new Error("exec failed"));
    expect(await pending).toBe("unknown");
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["win32", "linux"])("does not spawn on %s", async (value) => {
    Object.defineProperty(process, "platform", { value, configurable: true });
    expect(await probeFullDiskAccess()).toBe("granted");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it.each([true, { dismissed: true }, false, null])(
    "reads the legacy dismissal %j",
    (value) => {
      mocks.read.mockReturnValue(value);
      expect(isFullDiskAccessPromptDismissed()).toBe(
        value === true ||
          (typeof value === "object" &&
            value !== null &&
            "dismissed" in value &&
            value.dismissed === true),
      );
    },
  );
  it("does not mistake an inconclusive probe for granted", async () => {
    const pending = getFullDiskAccessStatus();
    child.emit("close", 3);
    expect(await pending).toMatchObject({
      probeStatus: "unknown",
      granted: false,
    });
  });
  it("uses the shared settings fallback", async () => {
    mocks.settings.mockResolvedValue(false);
    expect(await openFullDiskAccessSettings()).toBe(false);
    expect(mocks.settings).toHaveBeenCalledWith("file_access");
  });
});
