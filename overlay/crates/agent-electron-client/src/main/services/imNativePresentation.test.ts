import { EventEmitter } from "node:events";
import { inflateSync } from "node:zlib";
import type { BrowserWindow, NativeImage, NotificationConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { createIMBadgePng, createIMNativePresentation, formatIMBadgeCount, type IMNativeMessage, type IMNativeNotification, type IMNativePresentationOptions } from "./imNativePresentation";

const mocks = vi.hoisted(() => ({ appOn: vi.fn(), appRemoveListener: vi.fn() }));
vi.mock("electron", () => ({ app: { on: mocks.appOn, removeListener: mocks.appRemoveListener }, nativeImage: {}, Notification: {} }));
vi.mock("electron-log", () => ({ default: { warn: vi.fn() } }));
vi.mock("./i18n", () => ({ t: (_key: string, count: string) => `${count} unread messages` }));
vi.mock("../window/trayManager", () => ({ setTrayUnreadCount: vi.fn() }));

function makeWindow() {
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false),
    isFocused: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    setOverlayIcon: vi.fn(),
  });
  return Object.assign(window, { window: window as unknown as BrowserWindow });
}

class FakeNotification extends EventEmitter implements IMNativeNotification {
  show = vi.fn();
  close = vi.fn();
  constructor(readonly details: NotificationConstructorOptions) { super(); }
}

function setup(overrides: Partial<IMNativePresentationOptions> = {}) {
  const main = makeWindow();
  const secondary = makeWindow();
  const created: FakeNotification[] = [];
  let generation = 1;
  let allowed = true;
  const image = { isEmpty: () => false } as NativeImage;
  const options: IMNativePresentationOptions = {
    platform: "darwin",
    getMainWindow: () => main.window,
    getBusinessWindows: () => [main.window, secondary.window],
    isSessionCurrent: (value) => value === generation,
    isNotificationAllowed: () => allowed,
    setDockBadge: vi.fn(),
    setTrayBadgeCount: vi.fn(),
    createOverlayImage: vi.fn(() => image),
    notificationBackend: {
      isSupported: vi.fn(() => true),
      create: vi.fn((details) => {
        const item = new FakeNotification(details);
        created.push(item);
        return item;
      }),
    },
    ...overrides,
  };
  return {
    main, secondary, options, created, image,
    presentation: createIMNativePresentation(options),
    setGeneration(value: number) { generation = value; },
    setAllowed(value: boolean) { allowed = value; },
  };
}

function message(msgId = "m1", sessionGeneration = 1): IMNativeMessage {
  return { sessionGeneration, msgId, convId: "9223372036854775807", title: "Team", body: "Hello" };
}

describe("IM native unread badge", () => {
  it("caps display at 99+ and clears only on an explicit zero/account cleanup", () => {
    const fixture = setup();
    for (const count of [1, 99, 100, 101]) fixture.presentation.setUnreadCount(count);
    fixture.main.emit("focus");
    expect(fixture.options.setDockBadge).toHaveBeenLastCalledWith("99+");
    fixture.presentation.setUnreadCount(0);
    expect(fixture.options.setDockBadge).toHaveBeenLastCalledWith("");
    expect(fixture.options.setTrayBadgeCount).toHaveBeenLastCalledWith(0);
    expect([0, -1, 3.2, Infinity].map(formatIMBadgeCount)).toEqual(["", "", "", ""]);
  });

  it("reapplies Windows count on restore/show and preserves its true accessibility count", () => {
    const fixture = setup({ platform: "win32" });
    fixture.presentation.setUnreadCount(102);
    fixture.presentation.setUnreadCount(102);
    expect(fixture.main.setOverlayIcon.mock.calls).toEqual([[fixture.image, "102 unread messages"]]);
    fixture.main.emit("restore");
    fixture.main.emit("show");
    expect(fixture.main.setOverlayIcon).toHaveBeenCalledTimes(3);
    expect(fixture.options.createOverlayImage).toHaveBeenCalledOnce();
    fixture.presentation.setUnreadCount(500);
    expect(fixture.options.createOverlayImage).toHaveBeenCalledOnce();
    expect(fixture.main.setOverlayIcon).toHaveBeenLastCalledWith(fixture.image, "500 unread messages");
    fixture.presentation.clear();
    expect(fixture.main.setOverlayIcon).toHaveBeenLastCalledWith(null, "");
  });

  it("moves restore listeners to a replacement window and removes them on disposal", () => {
    const first = makeWindow();
    const second = makeWindow();
    let current = first.window;
    const fixture = setup({ platform: "win32", getMainWindow: () => current });
    fixture.presentation.setUnreadCount(12);
    current = second.window;
    fixture.presentation.setUnreadCount(12);
    expect(first.listenerCount("restore")).toBe(0);
    expect(second.listenerCount("restore")).toBe(1);
    expect(second.setOverlayIcon).toHaveBeenCalledWith(fixture.image, "12 unread messages");
    fixture.presentation.dispose();
    fixture.presentation.dispose();
    expect(second.listenerCount("restore")).toBe(0);
    expect(second.listenerCount("show")).toBe(0);
    expect(second.listenerCount("closed")).toBe(0);
    fixture.presentation.setUnreadCount(30);
    expect(second.setOverlayIcon).toHaveBeenLastCalledWith(null, "");
  });

  it("restores the cached Windows badge when the main window is recreated without another unread event", async () => {
    const first = makeWindow();
    const second = makeWindow();
    let current = first.window;
    const fixture = setup({ platform: "win32", getMainWindow: () => current });
    fixture.presentation.setUnreadCount(120);
    current = second.window;
    const onCreated = mocks.appOn.mock.calls.at(-1)![1];
    onCreated();
    onCreated();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(first.listenerCount("restore")).toBe(0);
    expect(second.setOverlayIcon.mock.calls).toEqual([[fixture.image, "120 unread messages"]]);
    expect(fixture.options.setTrayBadgeCount).toHaveBeenLastCalledWith(120);
    fixture.presentation.dispose();
    expect(mocks.appRemoveListener).toHaveBeenLastCalledWith("browser-window-created", onCreated);
  });

  it("tray failures do not block the application badge and disposal clears both counts", () => {
    const fixture = setup({ setTrayBadgeCount: vi.fn(() => { throw new Error("Tray unavailable"); }) });
    expect(() => fixture.presentation.setUnreadCount(3)).not.toThrow();
    expect(fixture.options.setDockBadge).toHaveBeenLastCalledWith("3");
    fixture.presentation.dispose();
    expect(fixture.options.setTrayBadgeCount).toHaveBeenLastCalledWith(0);
    expect(fixture.options.setDockBadge).toHaveBeenLastCalledWith("");
  });

  it("a destroyed/closed window is skipped without resetting the cached count", () => {
    const fixture = setup({ platform: "win32" });
    fixture.presentation.setUnreadCount(3);
    fixture.main.isDestroyed.mockReturnValue(true);
    fixture.main.emit("closed");
    fixture.presentation.setUnreadCount(3);
    expect(fixture.main.listenerCount("restore")).toBe(0);
    expect(fixture.main.setOverlayIcon).toHaveBeenCalledOnce();
  });

  it("generates a valid transparent 16px PNG with a red numeric badge", () => {
    const png = createIMBadgePng(105);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.readUInt32BE(16)).toBe(16);
    expect(png.readUInt32BE(20)).toBe(16);
    expect(png[25]).toBe(6);
    const idatLength = png.readUInt32BE(33);
    const pixels = inflateSync(png.subarray(41, 41 + idatLength));
    expect(pixels.length).toBe(16 * 65);
    expect(pixels.subarray(1, 5)).toEqual(Buffer.from([0, 0, 0, 0]));
    expect(pixels.includes(Buffer.from([230, 41, 57, 255]))).toBe(true);
    expect(pixels.includes(Buffer.from([255, 255, 255, 255]))).toBe(true);
    expect(createIMBadgePng(100)).toEqual(createIMBadgePng(105));
  });
});

describe("IM native notifications", () => {
  it("suppresses notifications when any business window is focused without clearing badges", () => {
    const fixture = setup();
    fixture.presentation.setUnreadCount(8);
    fixture.secondary.isFocused.mockReturnValue(true);
    expect(fixture.presentation.showMessage(message())).toBe(false);
    fixture.secondary.isFocused.mockReturnValue(false);
    expect(fixture.presentation.showMessage(message())).toBe(false);
    expect(fixture.presentation.showMessage(message("m2"))).toBe(true);
    expect(fixture.created).toHaveLength(1);
    expect(fixture.options.setDockBadge).toHaveBeenLastCalledWith("8");
  });

  it("checks support and lock/sleep/preference gates before creating native objects", () => {
    const fixture = setup();
    fixture.setAllowed(false);
    expect(fixture.presentation.showMessage(message())).toBe(false);
    fixture.setAllowed(true);
    vi.mocked(fixture.options.notificationBackend!.isSupported).mockReturnValue(false);
    expect(fixture.presentation.showMessage(message("m2"))).toBe(false);
    expect(fixture.created).toHaveLength(0);
  });

  it("notification click restores/shows/focuses the app once and retains unread counts", () => {
    const fixture = setup();
    fixture.presentation.setUnreadCount(8);
    fixture.main.isMinimized.mockReturnValue(true);
    fixture.presentation.showMessage(message());
    const click = fixture.created[0].listeners("click")[0];
    click();
    click();
    expect(fixture.main.restore).toHaveBeenCalledOnce();
    expect(fixture.main.show).toHaveBeenCalledOnce();
    expect(fixture.main.focus).toHaveBeenCalledOnce();
    expect(fixture.options.setTrayBadgeCount).toHaveBeenLastCalledWith(8);
    expect(fixture.options.setDockBadge).toHaveBeenLastCalledWith("8");
    expect(fixture.created[0].close).toHaveBeenCalledOnce();
  });

  it("rejects stale creation and stale clicks across session generations", () => {
    const fixture = setup();
    expect(fixture.presentation.showMessage(message("old", 0))).toBe(false);
    fixture.presentation.showMessage(message());
    fixture.setGeneration(2);
    fixture.created[0].emit("click");
    expect(fixture.main.show).not.toHaveBeenCalled();
    expect(fixture.presentation.showMessage(message("m1", 2))).toBe(true);
  });

  it("keeps a timed-out Windows toast clickable in Action Center without clearing its count", () => {
    const fixture = setup({ platform: "win32" });
    fixture.presentation.setUnreadCount(120);
    fixture.presentation.showMessage(message());
    const notification = fixture.created[0];
    notification.emit("close", { reason: "timedOut" });
    expect(notification.listenerCount("click")).toBe(1);
    expect(notification.close).not.toHaveBeenCalled();
    notification.emit("click");
    expect(fixture.main.show).toHaveBeenCalledOnce();
    expect(fixture.main.focus).toHaveBeenCalledOnce();
    expect(fixture.options.setTrayBadgeCount).toHaveBeenLastCalledWith(120);
    expect(fixture.main.setOverlayIcon).toHaveBeenLastCalledWith(fixture.image, "120 unread messages");
    fixture.presentation.dispose();
  });

  it.each(["userCanceled", "applicationHidden"])("releases explicitly dismissed Windows toast %s", reason => {
    const fixture = setup({ platform: "win32" });
    fixture.presentation.showMessage(message());
    const notification = fixture.created[0];
    const click = notification.listeners("click")[0];
    notification.emit("close", { reason });
    expect(notification.eventNames()).toEqual([]);
    click();
    expect(fixture.main.show).not.toHaveBeenCalled();
    fixture.presentation.dispose();
  });

  it("an already displayed notification still opens after notification preference changes", () => {
    const fixture = setup();
    fixture.presentation.showMessage(message());
    fixture.setAllowed(false);
    fixture.main.isFocused.mockReturnValue(true);
    fixture.created[0].emit("click");
    expect(fixture.main.show).toHaveBeenCalledOnce();
    expect(fixture.main.focus).toHaveBeenCalledOnce();
  });

  it("account cleanup closes native objects and makes retained callbacks inert", () => {
    const fixture = setup();
    fixture.presentation.setUnreadCount(5);
    fixture.presentation.showMessage(message());
    const click = fixture.created[0].listeners("click")[0];
    fixture.presentation.clear();
    click();
    expect(fixture.created[0].close).toHaveBeenCalledOnce();
    expect(fixture.created[0].eventNames()).toEqual([]);
    expect(fixture.main.show).not.toHaveBeenCalled();
    expect(fixture.options.setDockBadge).toHaveBeenLastCalledWith("");
    fixture.presentation.dispose();
    expect(fixture.presentation.showMessage(message("new"))).toBe(false);
  });

  it("failed and synchronous failure paths release native resources without throwing", () => {
    const fixture = setup();
    fixture.presentation.showMessage(message());
    expect(() => fixture.created[0].emit("failed")).not.toThrow();
    expect(fixture.created[0].close).toHaveBeenCalledOnce();
    expect(fixture.created[0].eventNames()).toEqual([]);
    vi.mocked(fixture.options.notificationBackend!.create).mockImplementationOnce((details) => {
      const notification = new FakeNotification(details);
      notification.show.mockImplementation(() => { throw new Error("OS rejected notification"); });
      fixture.created.push(notification);
      return notification;
    });
    expect(fixture.presentation.showMessage(message("m2"))).toBe(false);
    expect(fixture.created[1].close).toHaveBeenCalledOnce();
    expect(fixture.created[1].eventNames()).toEqual([]);
  });

  it("bounds native objects and message dedup while preserving recent message suppression", () => {
    const fixture = setup();
    for (let index = 0; index < 2050; index += 1) fixture.presentation.showMessage(message(String(index)));
    expect(fixture.created.filter((notification) => notification.eventNames().length > 0)).toHaveLength(20);
    expect(fixture.created.every((notification) => notification.close.mock.calls.length === 0)).toBe(true);
    expect(fixture.presentation.showMessage(message("2049"))).toBe(false);
    expect(fixture.presentation.showMessage(message("0"))).toBe(true);
    fixture.presentation.dispose();
    expect(fixture.created.filter((notification) => notification.close.mock.calls.length === 1)).toHaveLength(20);
    expect(fixture.created.every((notification) => notification.eventNames().length === 0)).toBe(true);
  });
});
