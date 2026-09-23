import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OnBeforeSendHeadersListenerDetails } from "electron";
const mocks = vi.hoisted(() => ({ install: vi.fn() }));
vi.mock("electron", () => ({
  session: {
    defaultSession: { webRequest: { onBeforeSendHeaders: mocks.install } },
  },
  webContents: { fromId: vi.fn() },
}));
vi.mock("electron-log", () => ({ default: { info: vi.fn() } }));
import {
  applySessionAuthHeaders,
  initSessionAuthInjection,
  trustInitialBusinessNavigation,
} from "./sessionAuthInjection";
import { APP_NAME_IDENTIFIER } from "@shared/constants";
import { stripTicketCookie } from "./auth/requestPolicy";
import { GATEWAY_REQUEST_HEADER } from "./loopbackGateway/requestContext";
const businessOrigin = "https://business.example";
const gatewayOrigin = "http://127.0.0.1:46800";
const context = {
  businessOrigin,
  trustedOrigins: [businessOrigin, gatewayOrigin],
  accessToken: "fresh",
};
function request(
  overrides: Record<string, unknown> = {}
): OnBeforeSendHeadersListenerDetails {
  return {
    url: `${businessOrigin}/api/user/info`,
    webContentsId: 1,
    webContents: {
      getURL: () => `${gatewayOrigin}/home`,
      isDestroyed: () => false,
    },
    frame: { url: `${gatewayOrigin}/home` },
    resourceType: "xhr",
    requestHeaders: {},
    ...overrides,
  } as never;
}
beforeEach(() => mocks.install.mockClear());
describe("business session authentication", () => {
  it("strips every ticket while preserving other cookies and an explicit Bearer", () => {
    const result = applySessionAuthHeaders(
      request({
        requestHeaders: {
          cOoKiE: "a=1; ticket=old; b=2; ticket=older",
          aUtHoRiZaTiOn: "Bearer explicit",
        },
      }),
      context
    );
    expect(result).toEqual({
      cOoKiE: "a=1; b=2",
      aUtHoRiZaTiOn: "Bearer explicit",
      "x-client-type": APP_NAME_IDENTIFIER,
    });
    expect(stripTicketCookie("a=1; b=2")).toBe("a=1; b=2");
    expect(stripTicketCookie("ticket=x")).toBeUndefined();
  });
  it.each([
    "https://business.example/api/info",
    "wss://business.example/computer/tty/ws",
  ])("injects on trusted HTTP/WS: %s", (url) => {
    expect(
      applySessionAuthHeaders(request({ url }), context).Authorization
    ).toBe("Bearer fresh");
  });
  it.each([
    "http://business.example/api/info",
    "ws://business.example/ws",
    "https://business.example:8443/api/info",
    "https://other.example/api/info",
    "https://username:password@business.example/api/info",
  ])("does not inject across scheme, port or host: %s", (url) => {
    expect(
      applySessionAuthHeaders(request({ url }), context).Authorization
    ).toBeUndefined();
  });
  it.each(["passwordLogin", "codeLogin", "code/send"])(
    "public auth path %s strips stale ticket without injecting",
    (suffix) => {
      const result = applySessionAuthHeaders(
        request({
          url: `${businessOrigin}/api/user/${suffix}`,
          requestHeaders: { Cookie: "ticket=old" },
        }),
        context
      );
      expect(result.Cookie).toBeUndefined();
      expect(result.Authorization).toBeUndefined();
    }
  );
  it("external iframe in trusted top-level page cannot obtain ambient credentials", () => {
    expect(
      applySessionAuthHeaders(
        request({ frame: { url: "https://external.example/embed" } }),
        context
      ).Authorization
    ).toBeUndefined();
  });
  it("trusted iframe in external top-level page cannot obtain ambient credentials", () => {
    expect(
      applySessionAuthHeaders(
        request({
          webContents: {
            getURL: () => "https://external.example",
            isDestroyed: () => false,
          },
        }),
        context
      ).Authorization
    ).toBeUndefined();
  });
  it("initial iframe document may use a trusted parent, but an existing external frame may not", () => {
    const frame = {
      url: "about:blank",
      parent: { url: `${gatewayOrigin}/home` },
    };
    expect(
      applySessionAuthHeaders(
        request({ resourceType: "subFrame", frame }),
        context
      ).Authorization
    ).toBe("Bearer fresh");
    frame.url = "https://external.example";
    expect(
      applySessionAuthHeaders(
        request({ resourceType: "subFrame", frame }),
        context
      ).Authorization
    ).toBeUndefined();
  });
  it("main-process net.fetch retains its explicit registration credentials", () => {
    const result = applySessionAuthHeaders(
      request({
        webContentsId: -1,
        webContents: undefined,
        frame: undefined,
        requestHeaders: {
          Cookie: "ticket=fresh",
          Authorization: "Bearer fresh",
        },
      }),
      context
    );
    expect(result.Cookie).toBe("ticket=fresh");
    expect(result.Authorization).toBe("Bearer fresh");
  });
  it("only explicitly registered first-window navigation can authenticate before commit", () => {
    const contents = {
      getURL: () => "",
      isDestroyed: () => false,
      once: vi.fn(),
    };
    const details = request({
      webContents: contents,
      frame: null,
      resourceType: "mainFrame",
    });
    expect(
      applySessionAuthHeaders(details, context).Authorization
    ).toBeUndefined();
    trustInitialBusinessNavigation(contents as never, details.url);
    expect(applySessionAuthHeaders(details, context).Authorization).toBe(
      "Bearer fresh"
    );
  });
  it("keeps loopback header-free and installs all four protocol filters", () => {
    for (const url of [
      "http://127.0.0.1:46800/api",
      "http://[::1]:46800/api",
    ]) {
      expect(applySessionAuthHeaders(request({ url }), context)).toEqual({});
    }
    initSessionAuthInjection(() => context);
    expect(mocks.install.mock.calls[0][0].urls).toEqual([
      "http://*/*",
      "https://*/*",
      "ws://*/*",
      "wss://*/*",
    ]);
  });
});

describe("trusted gateway request capability", () => {
  const gatewayContext = {
    ...context,
    gateway: { origin: gatewayOrigin, requestSecret: "test-only-capability" },
  };
  const namespaceUrl = `${gatewayOrigin}/__backend/business.example/files/icon.png`;

  it("grants a fresh capability to trusted frames even when the redirected Origin is null", () => {
    const result = applySessionAuthHeaders(
      request({
        url: namespaceUrl,
        requestHeaders: {
          Origin: "null",
          "X-Nuwax-Gateway-Request": "renderer-forgery",
        },
      }),
      gatewayContext
    );
    expect(result[GATEWAY_REQUEST_HEADER]).toBe("test-only-capability");
    expect(result["X-Nuwax-Gateway-Request"]).toBeUndefined();
    expect(result.Origin).toBe("null");
    expect(result.Authorization).toBeUndefined();
  });

  it("grants the same capability to ordinary gateway API requests", () => {
    const result = applySessionAuthHeaders(
      request({ url: `${gatewayOrigin}/api/info` }),
      gatewayContext
    );
    expect(result[GATEWAY_REQUEST_HEADER]).toBe("test-only-capability");
  });

  it("grants the capability to the matching gateway WebSocket handshake", () => {
    const result = applySessionAuthHeaders(
      request({ url: `${gatewayOrigin.replace("http:", "ws:")}/computer/ws` }),
      gatewayContext
    );
    expect(result[GATEWAY_REQUEST_HEADER]).toBe("test-only-capability");
  });

  it.each([
    { frame: { url: "https://external.example/frame" } },
    {
      webContents: {
        getURL: () => "https://external.example",
        isDestroyed: () => false,
      },
    },
    { frame: null },
    { webContentsId: -1, webContents: undefined, frame: undefined },
  ])("strips forged capabilities from untrusted requests: %j", (overrides) => {
    const result = applySessionAuthHeaders(
      request({
        url: namespaceUrl,
        requestHeaders: {
          [GATEWAY_REQUEST_HEADER]: "test-only-capability",
          Origin: "null",
        },
        ...overrides,
      }),
      gatewayContext
    );
    expect(result[GATEWAY_REQUEST_HEADER]).toBeUndefined();
  });

  it.each([
    `${businessOrigin}/api/info`,
    "https://external.example/__backend/business.example/files/icon.png",
    "http://127.0.0.1:46801/__backend/business.example/files/icon.png",
    "http://user@127.0.0.1:46800/__backend/business.example/files/icon.png",
  ])(
    "never leaks the capability outside the exact gateway origin: %s",
    (url) => {
      const result = applySessionAuthHeaders(
        request({
          url,
          requestHeaders: { [GATEWAY_REQUEST_HEADER]: "renderer-forgery" },
        }),
        gatewayContext
      );
      expect(result[GATEWAY_REQUEST_HEADER]).toBeUndefined();
    }
  );

  it("revoked gateway context removes any previous capability", () => {
    const result = applySessionAuthHeaders(
      request({
        url: namespaceUrl,
        requestHeaders: { [GATEWAY_REQUEST_HEADER]: "test-only-capability" },
      }),
      { ...context, gateway: null }
    );
    expect(result[GATEWAY_REQUEST_HEADER]).toBeUndefined();
  });
});
