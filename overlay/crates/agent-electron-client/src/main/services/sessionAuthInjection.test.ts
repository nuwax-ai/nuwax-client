import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OnBeforeSendHeadersListenerDetails } from "electron";
const mocks = vi.hoisted(() => ({ install: vi.fn() }));
vi.mock("electron", () => ({
  session: { defaultSession: { webRequest: { onBeforeSendHeaders: mocks.install } } },
  webContents: { fromId: vi.fn() },
}));
vi.mock("electron-log", () => ({ default: { info: vi.fn() } }));
import { applySessionAuthHeaders, initSessionAuthInjection } from "./sessionAuthInjection";
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
beforeEach(() => mocks.install.mockClear());
describe("business cookie session boundary", () => {
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
    for (const url of ["http://127.0.0.1:61005/file", "ws://127.0.0.1:61006/ws", "http://localhost:61009/"]) {
      const result = applySessionAuthHeaders(request({ url, requestHeaders: { cookie: "a=1; ticket=secret" } }), context);
      expect(result.cookie).toBe("a=1");
    }
  });
  it("strips ticket after a redirect to a sibling or child domain", () => {
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
  it("does not lend a cookie to untrusted business documents", () => {
    const result = applySessionAuthHeaders(request({ webContents: { getURL: () => "https://external.example", isDestroyed: () => false }, requestHeaders: { Cookie: "ticket=new" } }), context);
    expect(result.Cookie).toBeUndefined();
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
