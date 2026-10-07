import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Cookie, OnBeforeSendHeadersListenerDetails } from "electron";
const mocks = vi.hoisted(() => ({
  install: vi.fn(), currentTicket: vi.fn<() => string | null>(() => null),
  cookiesGet: vi.fn<(filter: unknown) => Promise<Cookie[]>>(async () => []),
  cookiesOn: vi.fn(),
}));
vi.mock("electron", () => ({
  session: { defaultSession: {
    webRequest: { onBeforeSendHeaders: mocks.install },
    cookies: { get: mocks.cookiesGet, on: mocks.cookiesOn },
  } },
  webContents: { fromId: vi.fn() },
}));
vi.mock("electron-log", () => ({ default: { info: vi.fn() } }));
vi.mock("./commercialTicketSession", () => ({ currentTicket: mocks.currentTicket }));
import { applySessionAuthHeaders as applyHeaders, initSessionAuthInjection, SessionTicketProvenance, trustInitialBusinessNavigation } from "./sessionAuthInjection";
import type { SessionAuthContext } from "./sessionAuthInjection";
import { APP_NAME_IDENTIFIER } from "@shared/constants";
import { GATEWAY_REQUEST_HEADER } from "./loopbackGateway/requestContext";
import { nativeTicketHeaders } from "./nativeTicketCapability";

const businessOrigin = "https://business.example";
const gatewayOrigin = "http://127.0.0.1:46800";
const context = {
  businessOrigin,
  trustedOrigins: [businessOrigin, gatewayOrigin],
  gateway: { origin: gatewayOrigin, requestSecret: "secret" },
};
function request(overrides: Record<string, unknown> = {}): OnBeforeSendHeadersListenerDetails {
  return {
    url: `${businessOrigin}/api/user/info`,
    webContentsId: 1,
    webContents: { getURL: () => `${gatewayOrigin}/home`, isDestroyed: () => false },
    frame: { url: `${gatewayOrigin}/home` },
    resourceType: "xhr",
    requestHeaders: {},
    ...overrides,
  } as never;
}
let provenance: SessionTicketProvenance;
function applySessionAuthHeaders(details: OnBeforeSendHeadersListenerDetails, activeContext = context) {
  return applyHeaders(details, activeContext, provenance);
}
beforeEach(() => {
  provenance = new SessionTicketProvenance();
  mocks.install.mockClear();
  mocks.currentTicket.mockReturnValue(null);
  mocks.cookiesGet.mockReset().mockResolvedValue([]);
  mocks.cookiesOn.mockClear();
});
describe("business cookie session boundary", () => {
  it.each([businessOrigin, gatewayOrigin])("authenticates a registered initial popup document at %s", (origin) => {
    const contents = { getURL: () => "", isDestroyed: () => false, once: vi.fn() };
    const url = `${origin}/api/f/s3/fixture.zip`;
    const initial = request({ url, resourceType: "mainFrame", webContents: contents, frame: { url: "" }, requestHeaders: { Cookie: "ticket=new" } });
    expect(applySessionAuthHeaders(initial, context).Cookie).toBeUndefined();
    trustInitialBusinessNavigation(contents as never, url);
    const headers = applySessionAuthHeaders(initial, context);
    expect(headers.Cookie).toBe("ticket=new");
    if (origin === gatewayOrigin) expect(headers[GATEWAY_REQUEST_HEADER]).toBe("secret");
    expect(applySessionAuthHeaders(request({ ...initial, url: `${origin}/api/other` }), context).Cookie).toBeUndefined();
    contents.once.mock.calls[0][1]();
    expect(applySessionAuthHeaders(initial, context).Cookie).toBeUndefined();
  });
  it("does not authorize a registered initial URL at an unrelated loopback port or external origin", () => {
    mocks.currentTicket.mockReturnValue("new");
    for (const url of ["http://127.0.0.1:46801/api/file", "https://external.example/api/file"]) {
      const contents = { getURL: () => "about:blank", isDestroyed: () => false, once: vi.fn() };
      trustInitialBusinessNavigation(contents as never, url);
      const headers = applySessionAuthHeaders(request({ url, resourceType: "mainFrame", webContents: contents, frame: { url: "" }, requestHeaders: { Cookie: "ticket=new" } }), context);
      expect(headers.Cookie).toBeUndefined();
      expect(headers[GATEWAY_REQUEST_HEADER]).toBeUndefined();
    }
  });
  it("keeps ticket on trusted business requests and removes legacy Bearer", () => {
    expect(applySessionAuthHeaders(request({ requestHeaders: {
      Cookie: "ticket=new; a=1", Authorization: "Bearer obsolete",
    } }), context)).toEqual({ Cookie: "ticket=new; a=1", "x-client-type": APP_NAME_IDENTIFIER });
  });
  it("strips ticket on public login and external iframe requests", () => {
    const headers = { Cookie: "ticket=old; a=1" };
    expect(applySessionAuthHeaders(request({ url: `${businessOrigin}/api/user/passwordLogin`, requestHeaders: headers }), context).Cookie).toBe("a=1");
    expect(applySessionAuthHeaders(request({ frame: { url: "https://external.example/embed" }, requestHeaders: headers }), context).Cookie).toBe("a=1");
  });
  it("adds gateway capability only for trusted frames", () => {
    const trusted = applySessionAuthHeaders(request({ url: `${gatewayOrigin}/api/me`, requestHeaders: { Cookie: "ticket=new" } }), context);
    expect(trusted[GATEWAY_REQUEST_HEADER]).toBe("secret");
    expect(trusted.Cookie).toBe("ticket=new");
    const foreign = applySessionAuthHeaders(request({ url: `${gatewayOrigin}/api/me`, frame: { url: "https://external.example" }, requestHeaders: { Cookie: "ticket=new", [GATEWAY_REQUEST_HEADER]: "forged" } }), context);
    expect(foreign.Cookie).toBeUndefined();
    expect(foreign[GATEWAY_REQUEST_HEADER]).toBeUndefined();
  });
  it("strips ticket from every other localhost port, including WebSocket", () => {
    mocks.currentTicket.mockReturnValue("secret");
    for (const url of ["http://127.0.0.1:61005/file", "ws://127.0.0.1:61006/ws", "http://localhost:61009/"]) {
      const result = applySessionAuthHeaders(request({ url, requestHeaders: { cookie: "a=1; ticket=secret" } }), context);
      expect(result.cookie).toBe("a=1");
    }
  });
  it("strips ticket after a redirect to a sibling or child domain", () => {
    mocks.currentTicket.mockReturnValue("shared-domain");
    for (const url of [
      "https://assets.business.example/redirected",
      "https://other.example/redirected",
      "wss://assets.business.example/socket",
    ]) {
      const result = applySessionAuthHeaders(request({
        url,
        resourceType: "mainFrame",
        requestHeaders: { Cookie: "ticket=shared-domain; theme=dark" },
      }), context);
      expect(result.Cookie).toBe("theme=dark");
    }
  });
  it("lends the current ticket to an absolute business WebSocket from a trusted loopback frame", () => {
    mocks.currentTicket.mockReturnValue("current");
    const result = applySessionAuthHeaders(request({
      url: "wss://business.example/socket/absolute", resourceType: "webSocket",
      requestHeaders: { Cookie: "preference=kept; ticket=stale", Authorization: "Bearer obsolete" },
    }), context);
    expect(result.Cookie).toBe("preference=kept; ticket=current");
    expect(result.Authorization).toBeUndefined();
  });
  it("does not lend a ticket to untrusted, unrelated or unauthenticated WebSockets", () => {
    mocks.currentTicket.mockReturnValue("current");
    const ws = { url: "wss://business.example/socket/absolute", resourceType: "webSocket" };
    expect(applySessionAuthHeaders(request({ ...ws, frame: { url: "https://external.example/embed" } }), context).Cookie).toBeUndefined();
    expect(applySessionAuthHeaders(request({ ...ws, url: "wss://other.example/socket/absolute" }), context).Cookie).toBeUndefined();
    expect(applySessionAuthHeaders(request({ ...ws, url: "ws://127.0.0.1:61006/socket/absolute" }), context).Cookie).toBeUndefined();
    mocks.currentTicket.mockReturnValue(null);
    expect(applySessionAuthHeaders(request(ws), context).Cookie).toBeUndefined();
  });
  it("does not lend a cookie to untrusted business documents", () => {
    const result = applySessionAuthHeaders(request({ webContents: { getURL: () => "https://external.example", isDestroyed: () => false }, requestHeaders: { Cookie: "ticket=new" } }), context);
    expect(result.Cookie).toBeUndefined();
  });
  it.each(["", "about:blank", "https://external.example/checkout"])("keeps ordinary business GET navigation logged in from %s", (source) => {
    const headers = applySessionAuthHeaders(request({
      url: `${businessOrigin}/repo/doc/123`, resourceType: "mainFrame", method: "GET",
      webContents: { getURL: () => source, isDestroyed: () => false },
      frame: { url: source }, requestHeaders: { Cookie: "ticket=new" },
    }), context);
    expect(headers.Cookie).toBe("ticket=new");
  });
  it.each([
    { path: "/api", method: "GET" }, { path: "/api/user/info", method: "GET" },
    { path: "/repo/doc/123", method: "POST" },
  ])("does not turn an external main-frame $method $path request into business admission", ({ path, method }) => {
    const source = "https://external.example/checkout";
    const headers = applySessionAuthHeaders(request({
      url: `${businessOrigin}${path}`, resourceType: "mainFrame", method,
      webContents: { getURL: () => source, isDestroyed: () => false },
      frame: { url: source }, requestHeaders: { Cookie: "ticket=new" },
    }), context);
    expect(headers.Cookie).toBeUndefined();
  });
  it("keeps business iframe GET login but rejects its external-frame POST and API", () => {
    const foreignFrame = { url: "https://external.example/embed" };
    const document = request({ url: `${businessOrigin}/document`, resourceType: "subFrame",
      method: "GET", frame: foreignFrame, requestHeaders: { Cookie: "ticket=new" } });
    expect(applySessionAuthHeaders(document, context).Cookie).toBe("ticket=new");
    expect(applySessionAuthHeaders(request({ ...document, method: "POST" }), context).Cookie).toBeUndefined();
    expect(applySessionAuthHeaders(request({ ...document, url: `${businessOrigin}/api/user/info` }), context).Cookie).toBeUndefined();
    expect(applySessionAuthHeaders(request({ ...document,
      webContents: { getURL: () => foreignFrame.url, isDestroyed: () => false },
    }), context).Cookie).toBeUndefined();
  });
  it.each([
    { frame: undefined },
    { frame: { url: `${gatewayOrigin}/home`, detached: true } },
    { frame: { get url() { throw new Error("frame destroyed"); } } },
    { webContents: { getURL: () => `${gatewayOrigin}/home`, isDestroyed: () => true } },
  ])("fails closed for unknown or destroyed API frames", (overrides) => {
    expect(applySessionAuthHeaders(request({ ...overrides, requestHeaders: { Cookie: "ticket=new" } }), context).Cookie).toBeUndefined();
  });
  it("recognizes a mirror business frame without requiring the top and frame to share an origin", () => {
    const mirror = "https://mirror.example";
    expect(applyHeaders(request({ frame: { url: `${mirror}/embed` }, requestHeaders: { Cookie: "ticket=new" } }),
      { ...context, trustedOrigins: [...context.trustedOrigins, mirror] }, provenance).Cookie).toBe("ticket=new");
  });
  it("keeps an independent third-party site's own ticket", () => {
    mocks.currentTicket.mockReturnValue("business-secret");
    expect(applySessionAuthHeaders(request({
      url: "https://external.example/account", requestHeaders: { Cookie: "ticket=external-own; a=1" },
    }), context).Cookie).toBe("ticket=external-own; a=1");
  });
  it("removes only known business ticket values from mixed third-party Cookies", () => {
    mocks.currentTicket.mockReturnValue("business-secret");
    expect(applySessionAuthHeaders(request({
      url: "https://external.example/account",
      requestHeaders: { cOoKiE: "ticket=external-own; ticket=business-secret; a=1" },
    }), context).cOoKiE).toBe("ticket=external-own; a=1");
  });
  it("allows main-process ticket requests but consumes their private marker", () => {
    const native = nativeTicketHeaders("new");
    const requestWithoutFrame = { webContentsId: 0, webContents: undefined, frame: undefined };
    const allowed = applySessionAuthHeaders(request({ ...requestWithoutFrame, requestHeaders: native }), context);
    expect(allowed).toEqual({ Cookie: "ticket=new", "x-client-type": APP_NAME_IDENTIFIER });
    const forged = applySessionAuthHeaders(request({ ...requestWithoutFrame, requestHeaders: {
      Cookie: "ticket=new", "x-nuwax-native-ticket": "forged",
    } }), context);
    expect(forged.Cookie).toBeUndefined();
    const redirected = applySessionAuthHeaders(request({ ...requestWithoutFrame,
      url: "https://other.example/image", requestHeaders: nativeTicketHeaders("new"),
    }), context);
    expect(redirected.Cookie).toBeUndefined();
    expect(redirected["x-nuwax-native-ticket"]).toBeUndefined();
  });
  it("installs one listener covering HTTP and WebSocket", () => {
    initSessionAuthInjection(() => context);
    expect(mocks.install.mock.calls[0][0].urls).toEqual(["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"]);
  });
});

function jarTicket(value: string, domain: string, hostOnly = true): Cookie {
  return { name: "ticket", value, domain, hostOnly, path: "/", secure: true, httpOnly: true,
    session: false, sameSite: "lax" };
}
function intercepted(details: OnBeforeSendHeadersListenerDetails) {
  const callback = vi.fn();
  const done = new Promise<Record<string, string>>((resolve) => callback.mockImplementation(
    (result: { requestHeaders: Record<string, string> }) => resolve(result.requestHeaders)));
  mocks.install.mock.calls.at(-1)![1](details, callback);
  return { callback, done };
}
function cookieChanged(cookie: Cookie, removed = false) {
  mocks.cookiesOn.mock.calls.at(-1)![1]({}, cookie, removed ? "explicit" : "overwrite", removed);
}

describe("installed session cookie provenance", () => {
  it.each([{}, { Cookie: "preference=kept" }, { cookie: "a=1; b=2" }])("does not read the jar when request cookies contain no ticket: %j", async (requestHeaders) => {
    initSessionAuthInjection(() => context);
    const pending = intercepted(request({ requestHeaders }));
    await pending.done;
    expect(mocks.cookiesGet).not.toHaveBeenCalled();
    expect(pending.callback).toHaveBeenCalledTimes(1);
  });
  it.each(["https://other.example.test/document", "https://assets.business.example.test/document", "wss://assets.business.example.test/socket"])("recognizes a restored parent-domain ticket before the first request to %s", async (url) => {
    const activeContext = { ...context, businessOrigin: "https://business.example.test",
      trustedOrigins: ["https://business.example.test", gatewayOrigin] };
    initSessionAuthInjection(() => activeContext);
    mocks.cookiesGet.mockResolvedValue([jarTicket("restored", ".example.test", false)]);
    const pending = intercepted(request({ url, requestHeaders: { cookie: "ticket=restored; theme=dark" } }));
    expect((await pending.done).cookie).toBe("theme=dark");
    expect(mocks.cookiesGet).toHaveBeenCalledWith({ url: url.replace(/^wss:/, "https:"), name: "ticket" });
    expect(pending.callback).toHaveBeenCalledTimes(1);
  });
  it("does not classify a sibling's host-only ticket as a parent-domain business cookie", async () => {
    initSessionAuthInjection(() => context);
    mocks.cookiesGet.mockResolvedValue([jarTicket("external-own", "example", true)]);
    const result = await intercepted(request({ url: "https://example/account",
      requestHeaders: { Cookie: "ticket=external-own; theme=dark" } })).done;
    expect(result.Cookie).toBe("ticket=external-own; theme=dark");
  });
  it("preserves third-party ticket after both jar selection and cookie-change events", async () => {
    initSessionAuthInjection(() => context);
    const cookie = jarTicket("external-own", "external.example");
    cookieChanged(cookie);
    mocks.cookiesGet.mockResolvedValue([cookie]);
    const result = await intercepted(request({ url: "https://external.example/account",
      requestHeaders: { Cookie: "ticket=external-own; a=1" } })).done;
    expect(result.Cookie).toBe("ticket=external-own; a=1");
  });
  it("keeps removed and rotated business values known after switching domain", async () => {
    let activeContext: SessionAuthContext = context;
    mocks.currentTicket.mockReturnValue("first");
    initSessionAuthInjection(() => activeContext);
    cookieChanged(jarTicket("rotated", "business.example"));
    cookieChanged(jarTicket("rotated", "business.example"), true);
    mocks.currentTicket.mockReturnValue(null);
    activeContext = { businessOrigin: "https://new.example", trustedOrigins: ["https://new.example"] };
    const result = await intercepted(request({ url: `${businessOrigin}/account`,
      requestHeaders: { Cookie: "ticket=first; ticket=rotated; ticket=external-own; a=1" } })).done;
    expect(result.Cookie).toBe("ticket=external-own; a=1");
  });
  it("recognizes an old domain's restored cookie even if it was not previously sent", async () => {
    let activeContext: SessionAuthContext = context;
    initSessionAuthInjection(() => activeContext);
    activeContext = { businessOrigin: "https://new.example", trustedOrigins: ["https://new.example"] };
    mocks.cookiesGet.mockResolvedValue([jarTicket("old-restored", "business.example")]);
    expect((await intercepted(request({ url: `${businessOrigin}/account`,
      requestHeaders: { Cookie: "ticket=old-restored; a=1" } })).done).Cookie).toBe("a=1");
  });
  it("registers new context before classifying the first new-domain sibling cookie", async () => {
    let activeContext: SessionAuthContext = context;
    initSessionAuthInjection(() => activeContext);
    activeContext = { businessOrigin: "https://new.test", trustedOrigins: ["https://new.test"] };
    mocks.cookiesGet.mockResolvedValue([jarTicket("new-restored", ".new.test", false)]);
    expect((await intercepted(request({ url: "https://child.new.test/account",
      requestHeaders: { Cookie: "ticket=new-restored; a=1" } })).done).Cookie).toBe("a=1");
  });
  it("uses latest context after an in-flight lookup and retains previous-domain provenance", async () => {
    let activeContext: SessionAuthContext = context;
    initSessionAuthInjection(() => activeContext);
    let resolveJar!: (cookies: Cookie[]) => void;
    mocks.cookiesGet.mockImplementation(() => new Promise(resolve => { resolveJar = resolve; }));
    const pending = intercepted(request({ url: "https://child.new.test/account",
      requestHeaders: { Cookie: "ticket=new-restored; ticket=old-restored; a=1" } }));
    activeContext = { businessOrigin: "https://new.test", trustedOrigins: ["https://new.test"] };
    resolveJar([jarTicket("new-restored", ".new.test", false), jarTicket("old-restored", "business.example")]);
    expect((await pending.done).Cookie).toBe("a=1");
  });
  it.each(["http://127.0.0.1:61005/account", "ws://127.0.0.1:61006/socket"])("blocks restored gateway-host tickets across ports at %s", async (url) => {
    initSessionAuthInjection(() => context);
    mocks.cookiesGet.mockResolvedValue([jarTicket("restored-gateway", "127.0.0.1")]);
    const result = await intercepted(request({ url, requestHeaders: { Cookie: "ticket=restored-gateway; a=1" } })).done;
    expect(result.Cookie).toBe("a=1");
    expect(result[GATEWAY_REQUEST_HEADER]).toBeUndefined();
  });
  it("does not promote unknown gateway-host cookie values into business secrets on independent domains", async () => {
    initSessionAuthInjection(() => context);
    cookieChanged(jarTicket("external-own", "127.0.0.1"));
    mocks.cookiesGet.mockResolvedValue([jarTicket("external-own", "external.example")]);
    expect((await intercepted(request({ url: "https://external.example/account",
      requestHeaders: { Cookie: "ticket=external-own" } })).done).Cookie).toBe("ticket=external-own");
  });
  it.each(["reject", "throw"])("finishes once and removes ambiguous tickets when jar lookup fails via %s", async (failure) => {
    initSessionAuthInjection(() => context);
    if (failure === "reject") mocks.cookiesGet.mockRejectedValue(new Error("jar unavailable"));
    else mocks.cookiesGet.mockImplementation(() => { throw new Error("jar unavailable"); });
    const pending = intercepted(request({ url: "https://external.example/account",
      requestHeaders: { Cookie: "ticket=unknown-restored; a=1" } }));
    expect((await pending.done).Cookie).toBe("a=1");
    expect(pending.callback).toHaveBeenCalledTimes(1);
  });
  it("preserves admitted business navigation but clears public login cookies when jar is unavailable", async () => {
    initSessionAuthInjection(() => context);
    mocks.cookiesGet.mockRejectedValue(new Error("jar unavailable"));
    expect((await intercepted(request({ url: `${businessOrigin}/document`, resourceType: "mainFrame",
      webContents: { getURL: () => "https://external.example", isDestroyed: () => false },
      requestHeaders: { Cookie: "ticket=restored" } })).done).Cookie).toBe("ticket=restored");
    expect((await intercepted(request({ url: `${businessOrigin}/api/user/passwordLogin`,
      requestHeaders: { Cookie: "ticket=restored; a=1" } })).done).Cookie).toBe("a=1");
  });
  it("does not leak cookie provenance into another installed policy", async () => {
    mocks.currentTicket.mockReturnValue("first-session");
    initSessionAuthInjection(() => context);
    mocks.currentTicket.mockReturnValue(null);
    initSessionAuthInjection(() => context);
    mocks.cookiesGet.mockResolvedValue([jarTicket("first-session", "external.example")]);
    expect((await intercepted(request({ url: "https://external.example/account",
      requestHeaders: { Cookie: "ticket=first-session" } })).done).Cookie).toBe("ticket=first-session");
  });
});
