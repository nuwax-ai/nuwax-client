import type { WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalProduct = process.env.NUWAX_APP_IDENTIFIER;

function fakeContents(host?: WebContents) {
  const listeners = new Map<string, (...args: any[]) => void>();
  let destroyed = false;
  const contents = {
    hostWebContents: host,
    isDestroyed: () => destroyed,
    send: vi.fn(),
    on: vi.fn((event: string, listener: (...args: any[]) => void) => {
      listeners.set(event, listener);
    }),
    emit: (event: string, ...args: any[]) => listeners.get(event)?.(...args),
    destroy: () => {
      destroyed = true;
      listeners.get("destroyed")?.();
    },
  };
  return Object.assign(contents, { webContents: contents as unknown as WebContents });
}

async function setup(product = "nuwax") {
  process.env.NUWAX_APP_IDENTIFIER = product;
  vi.resetModules();
  return import("./newTaskAvailability");
}

afterEach(() => {
  if (originalProduct === undefined) delete process.env.NUWAX_APP_IDENTIFIER;
  else process.env.NUWAX_APP_IDENTIFIER = originalProduct;
});

describe("new task availability", () => {
  it.each([
    ["nuwax", false],
    ["nuwaclaw", true],
  ])("%s retains its default availability", async (product, available) => {
    const service = await setup(product);
    expect(service.isGuestNewTaskAvailable(fakeContents().webContents)).toBe(available);
    expect(service.isMainNewTaskAvailable()).toBe(available);
  });

  it("syncs main guest changes to the host and supports unsubscribe", async () => {
    const service = await setup();
    const host = fakeContents();
    const guest = fakeContents(host.webContents);
    const subscriber = vi.fn();
    const unsubscribe = service.onMainNewTaskAvailabilityChanged(subscriber);
    service.setGuestNewTaskAvailable(guest.webContents, true, host.webContents);
    service.setGuestNewTaskAvailable(guest.webContents, true, host.webContents);
    expect(service.isGuestNewTaskAvailable(guest.webContents)).toBe(true);
    expect(service.isMainNewTaskAvailable()).toBe(true);
    expect(host.send).toHaveBeenCalledWith("nuwax:layout-changed", { newTaskAvailable: true });
    expect(subscriber).toHaveBeenCalledOnce();

    unsubscribe();
    service.setGuestNewTaskAvailable(guest.webContents, false, host.webContents);
    expect(service.isGuestNewTaskAvailable(guest.webContents)).toBe(false);
    expect(service.isMainNewTaskAvailable()).toBe(false);
    expect(host.send).toHaveBeenLastCalledWith("nuwax:layout-changed", { newTaskAvailable: false });
    expect(subscriber).toHaveBeenCalledOnce();
    expect(guest.on.mock.calls.map(([event]) => event)).toEqual([
      "did-start-navigation", "destroyed",
    ]);
  });

  it("resets on full navigation and destruction, preserving SPA and child frames", async () => {
    const service = await setup();
    const host = fakeContents();
    const guest = fakeContents(host.webContents);
    service.setGuestNewTaskAvailable(guest.webContents, true, host.webContents);
    guest.emit("did-start-navigation", {}, "/iframe", false, false);
    guest.emit("did-start-navigation", {}, "/home#fragment", true, true);
    guest.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    expect(service.isMainNewTaskAvailable()).toBe(true);

    guest.emit("did-start-navigation", {}, "/login", false, true);
    expect(service.isGuestNewTaskAvailable(guest.webContents)).toBe(false);
    expect(service.isMainNewTaskAvailable()).toBe(false);
    expect(host.send).toHaveBeenLastCalledWith("nuwax:layout-changed", { newTaskAvailable: false });
    service.setGuestNewTaskAvailable(guest.webContents, true, host.webContents);
    guest.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    expect(service.isMainNewTaskAvailable()).toBe(false);

    service.setGuestNewTaskAvailable(guest.webContents, true, host.webContents);
    guest.destroy();
    service.setGuestNewTaskAvailable(guest.webContents, true, host.webContents);
    expect(service.isGuestNewTaskAvailable(guest.webContents)).toBe(false);
    expect(service.isMainNewTaskAvailable()).toBe(false);
    expect(host.send).toHaveBeenLastCalledWith("nuwax:layout-changed", { newTaskAvailable: false });
  });

  it("keeps independent guests separate and rejects an unrelated host identity", async () => {
    const service = await setup();
    const host = fakeContents();
    const mainGuest = fakeContents(host.webContents);
    const otherHost = fakeContents();
    const otherGuest = fakeContents(otherHost.webContents);
    service.setGuestNewTaskAvailable(mainGuest.webContents, true, host.webContents);
    service.setGuestNewTaskAvailable(otherGuest.webContents, false, host.webContents);
    expect(service.isGuestNewTaskAvailable(otherGuest.webContents)).toBe(false);
    expect(service.isMainNewTaskAvailable()).toBe(true);
    service.setGuestNewTaskAvailable(otherGuest.webContents, true);
    otherGuest.emit("did-start-navigation", {}, "/other", false, true);
    expect(service.isGuestNewTaskAvailable(otherGuest.webContents)).toBe(false);
    expect(service.isGuestNewTaskAvailable(mainGuest.webContents)).toBe(true);
    expect(service.isMainNewTaskAvailable()).toBe(true);
    expect(host.send).toHaveBeenCalledOnce();
    expect(otherHost.send).not.toHaveBeenCalled();
  });

  it("old guest navigation, late cleanup and destruction cannot overwrite its replacement", async () => {
    const service = await setup();
    const host = fakeContents();
    const oldGuest = fakeContents(host.webContents);
    const newGuest = fakeContents(host.webContents);
    service.setGuestNewTaskAvailable(oldGuest.webContents, true, host.webContents);
    service.setGuestNewTaskAvailable(newGuest.webContents, true, host.webContents);
    oldGuest.emit("did-start-navigation", {}, "/old", false, true);
    service.setGuestNewTaskAvailable(oldGuest.webContents, false, host.webContents);
    oldGuest.destroy();
    expect(service.isGuestNewTaskAvailable(newGuest.webContents)).toBe(true);
    expect(service.isMainNewTaskAvailable()).toBe(true);
    expect(host.send).toHaveBeenCalledTimes(2);
    newGuest.destroy();
    expect(service.isMainNewTaskAvailable()).toBe(false);
  });
});
