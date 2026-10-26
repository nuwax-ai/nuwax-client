import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadNative: vi.fn(), show: vi.fn(), release: vi.fn(), close: vi.fn(), legacy: vi.fn(),
}));
vi.mock("node:module", () => ({ createRequire: () => mocks.loadNative }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    show = vi.fn(); close = vi.fn();
    constructor(options: unknown) { super(); mocks.legacy(options); }
  }
  return { app: { on: vi.fn(), removeListener: vi.fn() }, nativeImage: {}, Notification };
});
vi.mock("electron-log", () => ({ default: { warn: vi.fn() } }));
vi.mock("../i18n", () => ({ t: () => "unread" }));
vi.mock("../../window/trayManager", () => ({ setTrayUnreadCount: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.loadNative.mockReturnValue({ showNotification: mocks.show, releaseNotification: mocks.release, closeNotification: mocks.close });
});

function callback() { return mocks.show.mock.calls[0][4] as (event: "click" | "close" | "failed", code: number) => void; }

describe("modern macOS notification backend", () => {
  it.each(["darwin", "win32", "linux"] as const)("uses the correct production backend on %s", async platform => {
    const { createIMNativePresentation } = await import("../imNativePresentation");
    const window = { isDestroyed: () => false, isFocused: () => false, isMinimized: () => false, show: vi.fn(), focus: vi.fn(), setOverlayIcon: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
    const presentation = createIMNativePresentation({
      platform, getMainWindow: () => window as any, isSessionCurrent: () => true,
      setDockBadge: vi.fn(), setTrayBadgeCount: vi.fn(),
    });
    expect(presentation.showMessage({ sessionGeneration: 1, msgId: "m", convId: "c", title: "Team", body: "Hello" })).toBe(true);
    expect(mocks.show).toHaveBeenCalledTimes(platform === "darwin" ? 1 : 0);
    expect(mocks.legacy).toHaveBeenCalledTimes(platform === "darwin" ? 0 : 1);
    if (platform === "darwin") {
      callback()("click", 0);
      expect(window.show).toHaveBeenCalledOnce();
      expect(window.focus).toHaveBeenCalledOnce();
    }
    presentation.dispose();
  });

  it("preserves options and reuses one registration per object", async () => {
    const { MacNativeNotification } = await import("./macNativeNotification");
    const notification = new MacNativeNotification({ title: "群聊", body: "新消息", silent: true });
    notification.show(); notification.show();
    expect(mocks.show).toHaveBeenCalledOnce();
    expect(mocks.show).toHaveBeenCalledWith(expect.stringMatching(/^nuwax\.im\./), "群聊", "新消息", true, expect.any(Function));
    notification.removeAllListeners();
    expect(mocks.release).toHaveBeenCalledWith(mocks.show.mock.calls[0][0]);
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it("releases old account listeners without deleting OS history and ignores queued clicks", async () => {
    const { MacNativeNotification } = await import("./macNativeNotification");
    const notification = new MacNativeNotification({ title: "Team" });
    const click = vi.fn(); notification.on("click", click); notification.show();
    notification.removeAllListeners(); callback()("click", 0);
    expect(click).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.close).not.toHaveBeenCalled();
    notification.close(); notification.close();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("relays native failures with an error code and prevents delivery after close", async () => {
    const { MacNativeNotification } = await import("./macNativeNotification");
    const notification = new MacNativeNotification({ title: "Team" });
    const failure = vi.fn(); notification.on("failed", failure); notification.show();
    callback()("failed", 1);
    expect(failure).toHaveBeenCalledWith({ code: 1 });
    notification.close(); notification.show(); callback()("failed", 2);
    expect(failure).toHaveBeenCalledOnce();
    expect(mocks.show).toHaveBeenCalledOnce();
  });

  it("does not load the addon for an object closed before showing", async () => {
    const { MacNativeNotification } = await import("./macNativeNotification");
    const notification = new MacNativeNotification({ title: "Team" });
    notification.close(); notification.show();
    expect(mocks.loadNative).not.toHaveBeenCalled();
  });

  it("drops JS callbacks even if native listener cleanup fails", async () => {
    const { MacNativeNotification } = await import("./macNativeNotification");
    const notification = new MacNativeNotification({ title: "Team" });
    const click = vi.fn(); notification.on("click", click); notification.show();
    mocks.release.mockImplementation(() => { throw new Error("Native cleanup failed"); });
    expect(() => notification.removeAllListeners()).toThrow("Native cleanup failed");
    callback()("click", 0);
    expect(click).not.toHaveBeenCalled();
    expect(notification.listenerCount("click")).toBe(0);
  });

  it("fails explicitly when the native addon cannot load", async () => {
    mocks.loadNative.mockImplementation(() => { throw new Error("Missing addon"); });
    const { MacNativeNotification } = await import("./macNativeNotification");
    expect(() => new MacNativeNotification({ title: "Team" }).show()).toThrow("Missing addon");
    expect(mocks.legacy).not.toHaveBeenCalled();
  });
});
