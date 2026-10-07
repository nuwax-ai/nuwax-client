import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const popupWindows: Array<{
    options: unknown;
    loadURL: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    isDestroyed: () => boolean;
    webContents: { session: unknown; getURL: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; once: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> };
  }> = [];
  const defaultSession = {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setSpellCheckerEnabled: vi.fn(),
    on: vi.fn(),
  };
  const partitionSessions = new Map<string, {
    setPermissionRequestHandler: ReturnType<typeof vi.fn>;
    setPermissionCheckHandler: ReturnType<typeof vi.fn>;
    setSpellCheckerEnabled: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  }>();
  const fromPartition = vi.fn((partition: string) => {
    const ses = {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setSpellCheckerEnabled: vi.fn(),
      on: vi.fn(),
    };
    partitionSessions.set(partition, ses);
    return ses;
  });
  return { appOn: vi.fn(), showMessageBoxSync: vi.fn(), defaultSession, partitionSessions, fromPartition, popupWindows,
    attachHostActivityBusinessWindow: vi.fn(), trustInitialBusinessNavigation: vi.fn() };
});
const settings = new Map<string, unknown>();

vi.mock("electron", () => ({
  app: { on: mocks.appOn },
  dialog: { showMessageBoxSync: mocks.showMessageBoxSync },
  session: { defaultSession: mocks.defaultSession, fromPartition: mocks.fromPartition },
  BrowserWindow: class {
    loadURL = vi.fn(async () => undefined);
    focus = vi.fn();
    show = vi.fn();
    on = vi.fn();
    destroyed = false;
    destroy = vi.fn(() => { this.destroyed = true; });
    isDestroyed = () => this.destroyed;
    webContents = { session: undefined as unknown, getURL: vi.fn(() => ""), on: vi.fn(), once: vi.fn(), removeListener: vi.fn() };
    constructor(public options: unknown) {
      const configured = options as { webPreferences?: { session?: unknown; partition?: string }; webContents?: typeof this.webContents };
      if (configured.webContents) this.webContents = configured.webContents;
      else this.webContents.session = configured.webPreferences?.session ??
        mocks.partitionSessions.get(configured.webPreferences?.partition ?? "") ?? mocks.defaultSession;
      mocks.popupWindows.push(this);
    }
  },
}));
vi.mock("electron-log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../db", () => ({
  readSetting: (key: string) => settings.get(key) ?? null,
}));
vi.mock("../hostActivity", () => ({
  attachHostActivityBusinessWindow: mocks.attachHostActivityBusinessWindow,
}));
vi.mock("../sessionAuthInjection", () => ({
  trustInitialBusinessNavigation: mocks.trustInitialBusinessNavigation,
}));

vi.mock("../i18n", () => ({ t: (key: string) => key }));

const business = "https://business.example";
const external = "https://external.example";
const originalProduct = process.env.NUWAX_APP_IDENTIFIER;

function fakeContents(type: "window" | "webview", url: string, session: unknown = mocks.defaultSession) {
  return {
    getType: () => type,
    getURL: () => url,
    mainFrame: { framesInSubtree: [{ origin: new URL(url || "about:blank").origin }] },
    session,
    isDestroyed: () => false,
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    send: vi.fn(),
    openDevTools: vi.fn(),
  };
}

function popup(target: string, referrer: string) {
  return {
    url: target,
    features: "width=500,height=300",
    referrer: { url: referrer, policy: "strict-origin-when-cross-origin" },
  } as never;
}

async function setup(product = "nuwax") {
  process.env.NUWAX_APP_IDENTIFIER = product;
  vi.resetModules();
  const { initWebviewPolicy } = await import("./webviewPolicy");
  initWebviewPolicy(() => null);
  const created = mocks.appOn.mock.calls.find(([name]) => name === "web-contents-created")?.[1];
  expect(created).toBeTypeOf("function");
  return created as (_event: unknown, contents: ReturnType<typeof fakeContents>) => void;
}

function attachedWebview(created: Awaited<ReturnType<typeof setup>>, source: string) {
  const host = fakeContents("window", "file:///app/index.html");
  const guest = fakeContents("webview", source);
  created({}, host);
  const attach = host.on.mock.calls.find(([name]) => name === "did-attach-webview")?.[1];
  expect(attach).toBeTypeOf("function");
  attach({}, guest);
  return guest;
}

function webviewPopupHandler(created: Awaited<ReturnType<typeof setup>>, source: string) {
  const guest = attachedWebview(created, source);
  return guest.setWindowOpenHandler.mock.lastCall?.[0] as (details: unknown) => {
    action: string;
    overrideBrowserWindowOptions?: { webPreferences: Record<string, unknown>; width: number; height: number };
  };
}

beforeEach(() => {
  settings.clear();
  settings.set("step1_config", { serverHost: business });
  mocks.appOn.mockClear();
  mocks.showMessageBoxSync.mockReset();
  mocks.defaultSession.on.mockClear();
  mocks.fromPartition.mockClear();
  mocks.partitionSessions.clear();
  mocks.popupWindows.length = 0;
  mocks.attachHostActivityBusinessWindow.mockClear();
  mocks.trustInitialBusinessNavigation.mockClear();
});
afterEach(() => {
  if (originalProduct === undefined) delete process.env.NUWAX_APP_IDENTIFIER;
  else process.env.NUWAX_APP_IDENTIFIER = originalProduct;
});

describe("standalone page unload confirmation", () => {
  async function unloadWindow(url = `${external}/cashier`, mainWindow = false) {
    process.env.NUWAX_APP_IDENTIFIER = "nuwax";
    vi.resetModules();
    const contents = fakeContents("window", url);
    const win = { webContents: contents, isDestroyed: () => false };
    const { initWebviewPolicy } = await import("./webviewPolicy");
    initWebviewPolicy(() => mainWindow ? win as never : null);
    const created = mocks.appOn.mock.calls.find(([name]) => name === "browser-window-created")![1];
    created({}, win);
    const handler = contents.on.mock.calls.find(([name]) => name === "will-prevent-unload")![1];
    const event = { preventDefault: vi.fn() };
    return { win, event, unload: () => handler(event) };
  }

  it("lets a pending cashier close when the user chooses to leave", async () => {
    const { win, event, unload } = await unloadWindow();
    mocks.showMessageBoxSync.mockReturnValue(0);
    unload();
    expect(mocks.showMessageBoxSync).toHaveBeenCalledWith(win, expect.objectContaining({
      type: "question",
      buttons: ["Claw.Webview.leave", "Claw.Webview.stay"],
      defaultId: 1,
      cancelId: 1,
    }));
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("keeps the pending cashier open when the user stays or dismisses the dialog", async () => {
    const { event, unload } = await unloadWindow();
    mocks.showMessageBoxSync.mockReturnValue(1);
    unload();
    expect(mocks.showMessageBoxSync).toHaveBeenCalledOnce();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("also confirms unsaved work in a standalone business page", async () => {
    const { event, unload } = await unloadWindow(`${business}/editor`);
    mocks.showMessageBoxSync.mockReturnValue(1);
    unload();
    expect(mocks.showMessageBoxSync).toHaveBeenCalledOnce();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("preserves the main window close-to-tray policy", async () => {
    const { event, unload } = await unloadWindow(`${business}/home`, true);
    unload();
    expect(mocks.showMessageBoxSync).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("does not take over shell or blank-page unload", async () => {
    for (const url of ["file:///app/index.html", "about:blank"]) {
      const { event, unload } = await unloadWindow(url);
      unload();
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(mocks.showMessageBoxSync).not.toHaveBeenCalled();
  });

  it("preserves the page if a native dialog cannot be shown", async () => {
    const { event, unload } = await unloadWindow();
    mocks.showMessageBoxSync.mockImplementation(() => { throw new Error("dialog unavailable"); });
    expect(unload).not.toThrow();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("keeps the community window lifecycle unchanged", async () => {
    await setup("nuwaclaw");
    expect(mocks.appOn.mock.calls.some(([name]) => name === "browser-window-created")).toBe(false);
  });
});

describe("window.open session boundary", () => {
  it.each([
    ["webview", business],
    ["webview", external],
    ["window", business],
    ["window", external],
  ] as const)("%s popup to %s keeps native close controls even when the page requests no frame", async (type, target) => {
    const created = await setup();
    const opener = type === "webview"
      ? attachedWebview(created, `${business}/home`)
      : fakeContents("window", `${business}/home`);
    if (type === "window") created({}, opener);
    const handler = opener.setWindowOpenHandler.mock.lastCall![0];
    const result = handler({
      ...(popup(`${target}/cashier`, `${business}/home`) as object),
      features: "width=500,height=300,frame=no",
    });
    expect(result.overrideBrowserWindowOptions).toMatchObject({
      frame: true,
      titleBarStyle: "default",
      titleBarOverlay: false,
      closable: true,
    });
  });

  it.each([
    ["webview", business, business, business, true],
    ["window", business, business, business, true],
    ["webview", business, business, external, false],
    ["window", external, external, business, false],
    ["window", business, external, business, false],
    ["window", business, business, "https://user:pass@business.example", false],
  ] as const)("%s popup activity bridge follows existing trust classification: %s %s %s", async (type, source, referrer, target, trusted) => {
    const created = await setup();
    const opener = type === "webview" ? attachedWebview(created, `${source}/home`) : fakeContents(type, `${source}/home`);
    created({}, opener);
    const handler = opener.setWindowOpenHandler.mock.lastCall?.[0] as (details: unknown) => {
      overrideBrowserWindowOptions: { webPreferences: Record<string, unknown> };
    };
    const preferences = handler(popup(`${target}/agent`, `${referrer}/home`)).overrideBrowserWindowOptions.webPreferences;
    const didCreate = opener.on.mock.calls.find(([name]) => name === "did-create-window")?.[1];
    const win = { webContents: { session: preferences.session ?? { isolated: true } }, on: vi.fn() };
    didCreate(win);
    if (trusted) expect(mocks.attachHostActivityBusinessWindow).toHaveBeenCalledWith(win);
    else expect(mocks.attachHostActivityBusinessWindow).not.toHaveBeenCalled();
  });

  it("trusted business webview opens trusted target with business session and bridge", async () => {
    const handler = webviewPopupHandler(await setup(), `${business}/home`);
    const result = handler(popup(`${business}/agent`, `${business}/home`));
    const options = result.overrideBrowserWindowOptions!;
    expect(result.action).toBe("allow");
    expect(options.width).toBe(1000);
    expect(options.height).toBe(600);
    expect(options.webPreferences.session).toBe(mocks.defaultSession);
    expect(options.webPreferences.partition).toBeUndefined();
    expect(options.webPreferences.preload).toMatch(/webviewPerfBridge\.js$/);
    expect(options.webPreferences.additionalArguments).toEqual(expect.arrayContaining([
      "--nuwax-host-product=nuwax",
    ]));
  });

  it("destroys trusted window.open popups when the business domain changes", async () => {
    const created = await setup();
    const guest = fakeContents("webview", `${business}/home`);
    created({}, guest);
    const didCreate = guest.on.mock.calls.find(([name]) => name === "did-create-window")?.[1] as
      ((win: unknown) => void) | undefined;
    expect(didCreate).toBeTypeOf("function");
    const businessDestroy = vi.fn();
    const externalDestroy = vi.fn();
    const fakeWindow = (session: unknown, destroy: ReturnType<typeof vi.fn>) => ({
      webContents: { session }, isDestroyed: () => false, destroy, on: vi.fn(),
    });
    didCreate!(fakeWindow(mocks.defaultSession, businessDestroy));
    didCreate!(fakeWindow({ isolated: true }, externalDestroy));

    const { destroyTrustedBusinessPopups } = await import("./webviewPolicy");
    destroyTrustedBusinessPopups();
    expect(businessDestroy).toHaveBeenCalledTimes(1);
    expect(externalDestroy).not.toHaveBeenCalled();
    expect(mocks.attachHostActivityBusinessWindow).toHaveBeenCalledOnce();
  });

  it("business to external popup has no bridge and a fresh memory session", async () => {
    const handler = webviewPopupHandler(await setup(), `${business}/home`);
    const first = handler(popup(`${external}/docs`, `${business}/home`)).overrideBrowserWindowOptions!;
    const second = handler(popup(`${external}/docs`, `${business}/home`)).overrideBrowserWindowOptions!;
    expect(first.webPreferences.preload).toBeUndefined();
    expect(first.webPreferences.session).toBeUndefined();
    expect(first.webPreferences.partition).toMatch(/^temp:nuwax-popup-/);
    expect(second.webPreferences.partition).not.toBe(first.webPreferences.partition);
    const isolated = mocks.partitionSessions.get(first.webPreferences.partition as string);
    expect(isolated).toBeDefined();
    expect(isolated?.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(isolated?.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
    expect(isolated?.setSpellCheckerEnabled).toHaveBeenCalledWith(false);
    const request = isolated?.setPermissionRequestHandler.mock.lastCall?.[0] as (
      contents: unknown, permission: string, callback: (allowed: boolean) => void,
    ) => void;
    const check = isolated?.setPermissionCheckHandler.mock.lastCall?.[0] as (
      contents: unknown, permission: string,
    ) => boolean;
    const answer = vi.fn();
    request(null, "media", answer);
    expect(answer).toHaveBeenCalledWith(false);
    expect(check(null, "notifications")).toBe(false);
    expect(check(null, "fullscreen")).toBe(true);
  });

  it("external webview, external iframe and credentialed URL cannot inherit business session", async () => {
    const created = await setup();
    const externalHandler = webviewPopupHandler(created, `${external}/docs`);
    const businessHandler = webviewPopupHandler(created, `${business}/home`);
    for (const result of [
      externalHandler(popup(`${business}/agent`, `${external}/docs`)),
      businessHandler(popup(`${business}/agent`, `${external}/iframe`)),
      businessHandler(popup(`https://user:pass@business.example/agent`, `${business}/home`)),
      businessHandler(popup(`${business}/agent`, `https://user:pass@business.example/home`)),
    ]) {
      expect(result.overrideBrowserWindowOptions?.webPreferences.partition)
        .toMatch(/^temp:nuwax-popup-/);
      expect(result.overrideBrowserWindowOptions?.webPreferences.preload).toBeUndefined();
    }
  });

  it.each([
    ["webview", "direct", "/"],
    ["window", "direct", "/repo/doc/fixture"],
    ["webview", "gateway", "/repo/doc/fixture"],
    ["window", "gateway", "/"],
  ] as const)("%s noreferrer business link keeps the logged-in session in %s mode: %s", async (type, mode, route) => {
    const created = await setup();
    const gateway = "http://127.0.0.1:46800";
    if (mode === "gateway") settings.set("nuwax.loopback", { enabled: true, origin: gateway });
    const source = mode === "gateway" ? gateway : business;
    const opener = type === "webview"
      ? attachedWebview(created, `${source}/instant-message`)
      : fakeContents(type, `${source}/instant-message`);
    if (type === "window") created({}, opener);
    const handler = opener.setWindowOpenHandler.mock.lastCall![0] as
      (details: unknown) => import("electron").WindowOpenHandlerResponse;
    const url = `${business}${route}`;
    const result = handler(popup(url, ""));
    expect(result.action).toBe("allow");
    expect(result.overrideBrowserWindowOptions?.webPreferences?.session).toBe(mocks.defaultSession);
    expect(result.overrideBrowserWindowOptions?.webPreferences?.partition).toBeUndefined();
    expect(result.overrideBrowserWindowOptions?.webPreferences?.preload).toMatch(/webviewPerfBridge\.js$/);
    const contents = result.createWindow!(result.overrideBrowserWindowOptions!);
    expect(mocks.trustInitialBusinessNavigation).toHaveBeenCalledWith(contents, url);
    const win = mocks.popupWindows.at(-1)!;
    expect(mocks.trustInitialBusinessNavigation.mock.invocationCallOrder[0])
      .toBeLessThan(win.loadURL.mock.invocationCallOrder[0]);
    expect(mocks.attachHostActivityBusinessWindow).toHaveBeenCalledWith(win);
  });

  it.each([external, "null"])("noreferrer business page stays isolated when an iframe origin is %s", async (origin) => {
    const opener = attachedWebview(await setup(), `${business}/instant-message`);
    opener.mainFrame.framesInSubtree.push({ origin });
    const handler = opener.setWindowOpenHandler.mock.lastCall![0];
    expect(handler(popup(`${business}/repo/doc/fixture`, "")).action).toBe("deny");
    const win = mocks.popupWindows.at(-1)!;
    expect(win.webContents.session).not.toBe(mocks.defaultSession);
    expect((win.options as any).webPreferences.preload).toBeUndefined();
    expect(mocks.trustInitialBusinessNavigation).not.toHaveBeenCalled();
  });

  it("does not infer a noreferrer POST form's source from its business target", async () => {
    const handler = webviewPopupHandler(await setup(), `${business}/home`);
    expect(handler({
      ...popup(`${business}/repo/doc/fixture`, ""),
      postBody: { contentType: "application/x-www-form-urlencoded", data: [{ type: "rawData", bytes: Buffer.from("value=fixture") }] },
    }).action).toBe("deny");
    expect(mocks.popupWindows.at(-1)!.webContents.session).not.toBe(mocks.defaultSession);
    expect(mocks.trustInitialBusinessNavigation).not.toHaveBeenCalled();
  });

  it("popup from isolated BrowserWindow remains isolated, including second level popup", async () => {
    const created = await setup();
    const isolated = fakeContents("window", `${business}/home`, { isolated: true });
    created({}, isolated);
    const handler = isolated.setWindowOpenHandler.mock.lastCall?.[0] as (details: unknown) => {
      overrideBrowserWindowOptions: { webPreferences: Record<string, unknown> };
    };
    const child = handler(popup(`${business}/agent`, `${business}/home`));
    expect(child.overrideBrowserWindowOptions.webPreferences.partition).toMatch(/^temp:nuwax-popup-/);
    expect(child.overrideBrowserWindowOptions.webPreferences.preload).toBeUndefined();
    const grandchild = handler(popup(`${external}/docs`, `${business}/home`));
    expect(grandchild.overrideBrowserWindowOptions.webPreferences.partition)
      .not.toBe(child.overrideBrowserWindowOptions.webPreferences.partition);
    const didCreate = isolated.on.mock.calls.find(([name]) => name === "did-create-window")?.[1];
    didCreate({ webContents: { session: { isolated: true } }, on: vi.fn() });
    expect(mocks.attachHostActivityBusinessWindow).not.toHaveBeenCalled();
  });

  it("trusted standalone business window keeps bridge for trusted child", async () => {
    const created = await setup();
    const businessWindow = fakeContents("window", `${business}/home`);
    created({}, businessWindow);
    const handler = businessWindow.setWindowOpenHandler.mock.lastCall?.[0] as (details: unknown) => {
      overrideBrowserWindowOptions: { webPreferences: Record<string, unknown> };
    };
    const child = handler(popup(`${business}/agent`, `${business}/home`));
    expect(child.overrideBrowserWindowOptions.webPreferences.session).toBe(mocks.defaultSession);
    expect(child.overrideBrowserWindowOptions.webPreferences.preload).toMatch(/webviewPerfBridge\.js$/);
  });

  it("denies about:blank and preserves the community popup defaults", async () => {
    const created = await setup("nuwaclaw");
    const handler = webviewPopupHandler(created, `${external}/home`);
    expect(handler(popup("about:blank", `${external}/home`))).toEqual({ action: "deny" });
    const result = handler(popup(`${business}/agent`, `${external}/home`));
    expect(result.overrideBrowserWindowOptions?.webPreferences.partition).toBeUndefined();
    expect(result.overrideBrowserWindowOptions?.webPreferences.preload).toBeUndefined();
    const contents = fakeContents("window", `${external}/home`);
    created({}, contents);
    const didCreate = contents.on.mock.calls.find(([name]) => name === "did-create-window")?.[1];
    didCreate({ webContents: { session: mocks.defaultSession }, on: vi.fn() });
    expect(mocks.attachHostActivityBusinessWindow).not.toHaveBeenCalled();
  });
});

describe("business top-level navigation boundary", () => {
  it("moves _self cross-origin navigation into an isolated window", async () => {
    const guest = attachedWebview(await setup(), `${business}/home`);
    const onNavigate = guest.on.mock.calls.find(([name]) => name === "will-frame-navigate")?.[1];
    const event = { url: `${external}/docs`, isMainFrame: true, preventDefault: vi.fn() };
    onNavigate(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(mocks.popupWindows).toHaveLength(1);
    expect(mocks.popupWindows[0].loadURL).toHaveBeenCalledWith(`${external}/docs`);
    expect((mocks.popupWindows[0].options as any).webPreferences.partition)
      .toMatch(/^temp:nuwax-popup-/);
    expect((mocks.popupWindows[0].options as any).webPreferences.preload).toBeUndefined();
    const sameOrigin = { url: `${business}/agent`, isMainFrame: true, preventDefault: vi.fn() };
    onNavigate(sameOrigin);
    expect(sameOrigin.preventDefault).not.toHaveBeenCalled();
    const iframe = { url: `${external}/embed`, isMainFrame: false, preventDefault: vi.fn() };
    onNavigate(iframe);
    expect(iframe.preventDefault).not.toHaveBeenCalled();
  });

  it("blocks an initial trusted page's 302 to an external origin before commit", async () => {
    const created = await setup();
    const guest = fakeContents("webview", "");
    created({}, guest);
    const onRedirect = guest.on.mock.calls.find(([name]) => name === "will-redirect")?.[1];
    const event = { url: `${external}/checkout`, isMainFrame: true, preventDefault: vi.fn() };
    onRedirect(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect((mocks.popupWindows[0].options as any).webPreferences.partition)
      .toMatch(/^temp:nuwax-popup-/);
    expect(mocks.popupWindows[0].loadURL).toHaveBeenCalledWith(`${external}/checkout`);
  });

  it("places an external initial webview src in a fresh memory session", async () => {
    process.env.NUWAX_APP_IDENTIFIER = "nuwax";
    vi.resetModules();
    const { isolateUntrustedInitialWebview } = await import("./webviewPolicy");
    const preferences = { preload: "/sensitive/preload.js", session: mocks.defaultSession } as any;
    const params = { src: `${external}/docs` };
    expect(isolateUntrustedInitialWebview(preferences, params)).toBe(true);
    expect(preferences.partition).toMatch(/^temp:nuwax-webview-/);
    expect(preferences.session).toBeUndefined();
    expect(preferences.preload).toBeUndefined();
    expect((params as any).partition).toBe(preferences.partition);
    expect(mocks.partitionSessions.get(preferences.partition)?.setPermissionRequestHandler)
      .toHaveBeenCalledOnce();
    expect(isolateUntrustedInitialWebview({}, { src: `${business}/home` })).toBe(false);
  });
});

describe("download popup lifecycle", () => {
  function fire(contents: { on: ReturnType<typeof vi.fn> }, name: string, ...args: unknown[]) {
    const handler = contents.on.mock.calls.find(([event]) => event === name)?.[1];
    expect(handler).toBeTypeOf("function");
    handler(...args);
  }

  async function createPopup(target = business) {
    const handler = webviewPopupHandler(await setup(), `${business}/home`) as
      (details: unknown) => import("electron").WindowOpenHandlerResponse;
    const result = handler(popup(`${target}/file`, `${business}/home`));
    const contents = result.createWindow!(result.overrideBrowserWindowOptions!);
    return { result, contents, win: mocks.popupWindows.at(-1)! };
  }

  it("registers initial business authentication before loading a hidden popup", async () => {
    const { result, contents, win } = await createPopup();
    expect(result.overrideBrowserWindowOptions?.show).toBe(false);
    expect(mocks.trustInitialBusinessNavigation).toHaveBeenCalledWith(contents, `${business}/file`);
    expect(mocks.trustInitialBusinessNavigation.mock.invocationCallOrder[0])
      .toBeLessThan(win.loadURL.mock.invocationCallOrder[0]);
    expect(win.loadURL).toHaveBeenCalledWith(`${business}/file`, expect.objectContaining({
      httpReferrer: { url: `${business}/home`, policy: "strict-origin-when-cross-origin" },
    }));
    expect(mocks.attachHostActivityBusinessWindow).toHaveBeenCalledWith(win);
    expect(win.show).not.toHaveBeenCalled();
  });

  it("authenticates a noreferrer business file without giving it the page bridge", async () => {
    const handler = webviewPopupHandler(await setup(), `${business}/home`) as
      (details: unknown) => import("electron").WindowOpenHandlerResponse;
    const url = `${business}/api/f/s3/default/fixture.zip`;
    const result = handler(popup(url, ""));
    expect(result.action).toBe("allow");
    expect(result.overrideBrowserWindowOptions?.webPreferences?.session).toBe(mocks.defaultSession);
    expect(result.overrideBrowserWindowOptions?.webPreferences?.preload).toBeUndefined();
    expect(result.overrideBrowserWindowOptions?.webPreferences?.additionalArguments).toBeUndefined();
    const contents = result.createWindow!(result.overrideBrowserWindowOptions!);
    expect(mocks.trustInitialBusinessNavigation).toHaveBeenCalledWith(contents, url);
  });

  it("keeps an external noreferrer link in a new isolated window", async () => {
    const handler = webviewPopupHandler(await setup(), `${business}/home`) as
      (details: unknown) => import("electron").WindowOpenHandlerResponse;
    expect(handler(popup(`${external}/file.zip`, "")).action).toBe("deny");
    const win = mocks.popupWindows.at(-1)!;
    expect(win.webContents.session).not.toBe(mocks.defaultSession);
    expect((win.options as any).webPreferences.preload).toBeUndefined();
    expect(mocks.trustInitialBusinessNavigation).not.toHaveBeenCalled();
  });

  it.each([external, "null"])("does not lend noreferrer file authentication with an iframe origin of %s", async (origin) => {
    const guest = attachedWebview(await setup(), `${business}/home`);
    guest.mainFrame.framesInSubtree.push({ origin });
    const handler = guest.setWindowOpenHandler.mock.lastCall![0];
    expect(handler(popup(`${business}/api/f/s3/fixture.zip`, "")).action).toBe("deny");
    expect(mocks.trustInitialBusinessNavigation).not.toHaveBeenCalled();
    expect(mocks.popupWindows.at(-1)!.webContents.session).not.toBe(mocks.defaultSession);
  });

  it.each([
    { opener: external, referrer: "", url: `${business}/api/f/s3/fixture.zip` },
    { opener: business, referrer: external, url: `${business}/api/f/s3/fixture.zip` },
    { opener: business, referrer: "", url: `${business}/api/other` },
  ])("does not lend download authentication outside its allowed source and path: $url", async (input) => {
    const handler = webviewPopupHandler(await setup(), `${input.opener}/home`) as
      (details: unknown) => import("electron").WindowOpenHandlerResponse;
    const result = handler(popup(input.url, input.referrer));
    if (result.createWindow) result.createWindow(result.overrideBrowserWindowOptions!);
    expect(mocks.trustInitialBusinessNavigation).not.toHaveBeenCalled();
    expect(mocks.popupWindows.at(-1)!.webContents.session).not.toBe(mocks.defaultSession);
  });

  it("preserves an existing Chromium guest without loading its URL twice", async () => {
    const { result } = await createPopup();
    const existing = { session: mocks.defaultSession, getURL: vi.fn(() => ""), on: vi.fn(), once: vi.fn(), removeListener: vi.fn() };
    const options = { ...result.overrideBrowserWindowOptions, webContents: existing };
    expect(result.createWindow!(options)).toBe(existing);
    expect(mocks.popupWindows.at(-1)!.loadURL).not.toHaveBeenCalled();
  });

  it.each([
    { contentType: "application/x-www-form-urlencoded", boundary: undefined },
    { contentType: "multipart/form-data", boundary: "fixture-boundary" },
  ])("preserves POST form headers for $contentType popup navigation", async (format) => {
    const handler = webviewPopupHandler(await setup(), `${business}/home`) as
      (details: unknown) => import("electron").WindowOpenHandlerResponse;
    const data = [{ type: "rawData", bytes: Buffer.from("fixture=value") }];
    const result = handler({
      ...popup(`${business}/file`, `${business}/home`),
      postBody: { ...format, data },
    });
    result.createWindow!(result.overrideBrowserWindowOptions!);
    expect(mocks.popupWindows.at(-1)!.loadURL).toHaveBeenCalledWith(`${business}/file`, {
      httpReferrer: { url: `${business}/home`, policy: "strict-origin-when-cross-origin" },
      postData: data,
      extraHeaders: `content-type: ${format.contentType}${
        format.boundary ? `; boundary=${format.boundary}` : ""
      }`,
    });
  });

  it.each(["completed", "cancelled", "interrupted"])("closes a download-only isolated popup after %s", async (state) => {
    const { win } = await createPopup(external);
    expect(mocks.trustInitialBusinessNavigation).not.toHaveBeenCalled();
    const ses = win.webContents.session as { on: ReturnType<typeof vi.fn> };
    const item = { getFilename: () => "fixture.zip", getTotalBytes: () => 42, getSavePath: () => "/tmp/fixture.zip", on: vi.fn(), once: vi.fn() };
    fire(ses, "will-download", {}, item, win.webContents);
    fire(win.webContents, "did-fail-load", {}, -3, "ERR_ABORTED", `${external}/file`, true);
    expect(win.destroy).not.toHaveBeenCalled();
    item.once.mock.calls.find(([event]) => event === "done")![1]({}, state);
    expect(win.destroy).toHaveBeenCalledOnce();
    expect(win.show).not.toHaveBeenCalled();
  });

  it("shows committed HTML and retains it when a later download finishes", async () => {
    const { win } = await createPopup(external);
    win.webContents.getURL.mockReturnValue(`${external}/docs`);
    fire(win.webContents, "did-finish-load");
    expect(win.show).toHaveBeenCalledOnce();
    const item = { getFilename: () => "fixture.zip", getTotalBytes: () => 42, getSavePath: () => "/tmp/fixture.zip", on: vi.fn(), once: vi.fn() };
    fire(win.webContents.session as { on: ReturnType<typeof vi.fn> }, "will-download", {}, item, win.webContents);
    item.once.mock.calls.find(([event]) => event === "done")![1]({}, "completed");
    expect(win.destroy).not.toHaveBeenCalled();
  });

  it("retains committed HTML when its download finishes before slow subresources load", async () => {
    const { win } = await createPopup(external);
    fire(win.webContents, "dom-ready");
    expect(win.show).not.toHaveBeenCalled();
    win.webContents.getURL.mockReturnValue(`${external}/docs`);
    fire(win.webContents, "did-navigate", {}, `${external}/docs`);
    fire(win.webContents, "dom-ready");
    expect(win.show).toHaveBeenCalledOnce();
    const item = { getFilename: () => "fixture.zip", getTotalBytes: () => 42, getSavePath: () => "/tmp/fixture.zip", on: vi.fn(), once: vi.fn() };
    fire(win.webContents.session as { on: ReturnType<typeof vi.fn> }, "will-download", {}, item, win.webContents);
    item.once.mock.calls.find(([event]) => event === "done")![1]({}, "completed");
    expect(win.destroy).not.toHaveBeenCalled();
    fire(win.webContents, "did-finish-load");
    expect(win.show).toHaveBeenCalledOnce();
  });

  it("closes an empty failed page without creating a download", async () => {
    const { win } = await createPopup(external);
    fire(win.webContents, "did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", `${external}/file`, true);
    expect(win.destroy).toHaveBeenCalledOnce();
    expect(win.show).not.toHaveBeenCalled();
  });
});

describe("defaultSession permission origin boundary", () => {
  it("requires the top document and actual requesting frame to be current business origins", async () => {
    await setup();
    const request = mocks.defaultSession.setPermissionRequestHandler.mock.lastCall?.[0] as (
      contents: unknown, permission: string, callback: (allowed: boolean) => void,
      details: { requestingUrl: string },
    ) => void;
    const check = mocks.defaultSession.setPermissionCheckHandler.mock.lastCall?.[0] as (
      contents: unknown, permission: string, requestingOrigin: string,
      details: { isMainFrame: boolean; requestingUrl?: string; embeddingOrigin?: string },
    ) => boolean;
    const top = fakeContents("webview", `${business}/home`);
    const answer = vi.fn();
    request(top, "media", answer, { requestingUrl: `${business}/camera` });
    expect(answer).toHaveBeenLastCalledWith(true);
    request(top, "media", answer, { requestingUrl: `${external}/iframe` });
    expect(answer).toHaveBeenLastCalledWith(false);
    expect(check(top, "clipboard-read", business,
      { isMainFrame: true, requestingUrl: `${business}/home` })).toBe(true);
    expect(check(top, "clipboard-read", external,
      { isMainFrame: false, embeddingOrigin: business })).toBe(false);
    expect(check(top, "notifications", business,
      { isMainFrame: false, embeddingOrigin: external })).toBe(false);
    expect(check(fakeContents("webview", `${external}/docs`), "media", business,
      { isMainFrame: true })).toBe(false);
    expect(check(null, "media", business, { isMainFrame: true })).toBe(false);
    settings.set("step1_config", { serverHost: "https://new-business.example" });
    expect(check(top, "media", business, { isMainFrame: true })).toBe(false);
  });
});

describe("new task keyboard availability", () => {
  const input = (overrides: Record<string, unknown> = {}) => ({
    type: "keyDown", key: "n", control: true, meta: false, shift: false, alt: false,
    ...overrides,
  });
  const keyboard = (guest: ReturnType<typeof fakeContents>) =>
    guest.on.mock.calls.find(([name]) => name === "before-input-event")?.[1] as
      (event: { preventDefault: ReturnType<typeof vi.fn> }, input: unknown) => void;

  it.each([
    { control: true, meta: false, key: "n" },
    { control: false, meta: true, key: "N" },
  ])("reserves Ctrl/Cmd+N and forwards only when the guest menu is available", async (modifiers) => {
    const guest = attachedWebview(await setup(), `${business}/home`);
    const onInput = keyboard(guest);
    const event = { preventDefault: vi.fn() };
    onInput(event, input(modifiers));
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(guest.send).not.toHaveBeenCalled();
    const { setGuestNewTaskAvailable } = await import("../newTaskAvailability");
    setGuestNewTaskAvailable(guest as never, true);
    onInput(event, input(modifiers));
    expect(guest.send).toHaveBeenCalledWith("nuwax:host-command", { type: "new-task" });
    setGuestNewTaskAvailable(guest as never, false);
    onInput(event, input(modifiers));
    expect(guest.send).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledTimes(3);
  });

  it("preserves modifier filtering and DevTools shortcuts", async () => {
    const guest = attachedWebview(await setup(), `${business}/home`);
    const onInput = keyboard(guest);
    const { setGuestNewTaskAvailable } = await import("../newTaskAvailability");
    setGuestNewTaskAvailable(guest as never, true);
    const event = { preventDefault: vi.fn() };
    for (const overrides of [
      { type: "keyUp" }, { shift: true }, { alt: true },
      { control: false }, { key: "m" },
    ]) onInput(event, input(overrides));
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(guest.send).not.toHaveBeenCalled();
    setGuestNewTaskAvailable(guest as never, false);
    onInput(event, input({ key: "I", shift: true }));
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(guest.openDevTools).toHaveBeenCalledOnce();
    expect(guest.send).not.toHaveBeenCalled();
  });

  it("keeps the community shortcut enabled by default", async () => {
    const guest = attachedWebview(await setup("nuwaclaw"), `${business}/home`);
    const event = { preventDefault: vi.fn() };
    keyboard(guest)(event, input());
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(guest.send).toHaveBeenCalledWith("nuwax:host-command", { type: "new-task" });
  });
});
