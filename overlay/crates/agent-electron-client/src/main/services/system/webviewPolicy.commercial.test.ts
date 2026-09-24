import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appOn: vi.fn(),
  sessions: new Map<string, {
    setPermissionRequestHandler: ReturnType<typeof vi.fn>;
    setPermissionCheckHandler: ReturnType<typeof vi.fn>;
    setSpellCheckerEnabled: ReturnType<typeof vi.fn>;
  }>(),
  defaultSession: {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setSpellCheckerEnabled: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  app: { on: mocks.appOn },
  session: {
    defaultSession: mocks.defaultSession,
    fromPartition: (partition: string) => {
      const isolated = {
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        setSpellCheckerEnabled: vi.fn(),
      };
      mocks.sessions.set(partition, isolated);
      return isolated;
    },
  },
  BrowserWindow: class {},
}));
vi.mock("electron-log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("../auth/businessOrigins", () => ({
  businessBridgeOrigins: () => ["https://business.example"],
  httpOrigin: (value: string) => {
    try {
      const url = new URL(value);
      return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.origin : null;
    } catch {
      return null;
    }
  },
}));

import {
  configureIsolatedWebSession,
  destroyTrustedBusinessPopups,
  initWebviewPolicy,
} from "./webviewPolicy";

function makeContents(url: string, type: string) {
  const listeners = new Map<string, (...args: any[]) => void>();
  let openHandler: ((details: { url: string; features: string }) => any) | undefined;
  return {
    on: vi.fn((event: string, listener: (...args: any[]) => void) => listeners.set(event, listener)),
    getURL: () => url,
    getType: () => type,
    setWindowOpenHandler: vi.fn((handler) => { openHandler = handler; }),
    emit: (event: string, ...args: any[]) => listeners.get(event)?.(...args),
    open: (target: string) => openHandler?.({ url: target, features: "" }),
  };
}

beforeEach(() => {
  mocks.appOn.mockClear();
  mocks.sessions.clear();
  destroyTrustedBusinessPopups();
});

describe("commercial popup session policy", () => {
  it("denies every permission in a fresh external memory session", () => {
    configureIsolatedWebSession("temp:external-test");
    const isolated = mocks.sessions.get("temp:external-test")!;
    const request = isolated.setPermissionRequestHandler.mock.lastCall![0];
    const check = isolated.setPermissionCheckHandler.mock.lastCall![0];
    const callback = vi.fn();
    request(null, "media", callback);
    expect(callback).toHaveBeenCalledWith(false);
    expect(check(null, "media")).toBe(false);
    expect(isolated.setSpellCheckerEnabled).toHaveBeenCalledWith(false);
  });

  it("shares the business session only for trusted popups and closes them on domain switch", () => {
    initWebviewPolicy(() => null);
    const created = mocks.appOn.mock.calls.find(([event]) => event === "web-contents-created")![1];
    const host = makeContents("file:///app/index.html", "window");
    const guest = makeContents("https://business.example/home", "webview");
    created(null, host);
    host.emit("did-attach-webview", null, guest);

    const trusted = guest.open("https://business.example/order");
    expect(trusted.action).toBe("allow");
    expect(trusted.overrideBrowserWindowOptions.webPreferences.partition).toBeUndefined();
    const popup = { isDestroyed: vi.fn(() => false), destroy: vi.fn(), on: vi.fn() };
    guest.emit("did-create-window", popup, { url: "https://business.example/order" });

    const external = guest.open("https://external.example/path");
    const partition = external.overrideBrowserWindowOptions.webPreferences.partition;
    expect(partition).toMatch(/^temp:nuwax-external-/);
    expect(mocks.sessions.has(partition)).toBe(true);

    destroyTrustedBusinessPopups();
    expect(popup.destroy).toHaveBeenCalledOnce();
  });
});
