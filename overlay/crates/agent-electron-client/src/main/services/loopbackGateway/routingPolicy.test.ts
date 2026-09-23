import { describe, expect, it } from "vitest";
import {
  backendNamespaceUrl,
  normalizeGatewayRequestUrl,
  resolveBackendNamespace,
  namespaceRedirectLocation,
} from "./routingPolicy";

const backendOrigin = "https://business.example:8443";
const gatewayOrigin = "http://127.0.0.1:46800";
const config = {
  backendOrigin,
  gatewayOrigin,
  backendPrefixes: ["/api", "/repo", "/instant-message", "/computer"],
};
const namespace = `${gatewayOrigin}/__backend/business.example:8443`;
const main = {
  resourceType: "xhr",
  webContentsUrl: `${gatewayOrigin}/home`,
  frameUrl: `${gatewayOrigin}/home`,
};

describe("backend URL routing", () => {
  it("preserves document pathname and redirects absolute subresources", () => {
    for (const resourceType of ["mainFrame", "subFrame"]) {
      expect(
        normalizeGatewayRequestUrl(
          {
            ...main,
            resourceType,
            url: `${backendOrigin}/repo/doc/7?q=1#part`,
          },
          config,
        ),
      ).toBe(`${gatewayOrigin}/repo/doc/7?q=1#part`);
    }
    expect(
      normalizeGatewayRequestUrl(
        { ...main, url: `${backendOrigin}/files/x.png?q=%2F` },
        config,
      ),
    ).toBe(`${namespace}/files/x.png?q=%2F`);
  });

  it("routes root/relative resources only for a registered backend frame", () => {
    for (const path of [
      "/assets/a.js",
      "/repo-api/items",
      "/nested/resource.json",
    ]) {
      const url = `${gatewayOrigin}${path}`;
      expect(normalizeGatewayRequestUrl({ ...main, url }, config)).toBeNull();
      expect(
        normalizeGatewayRequestUrl(
          { ...main, frameUrl: `${gatewayOrigin}/repo/doc/7`, url },
          config,
        ),
      ).toBe(namespace + path);
    }
    expect(
      normalizeGatewayRequestUrl(
        {
          ...main,
          frameUrl: `${gatewayOrigin}/repository/x`,
          url: `${gatewayOrigin}/assets/a.js`,
        },
        config,
      ),
    ).toBeNull();
    expect(
      normalizeGatewayRequestUrl(
        {
          ...main,
          frameUrl: `${gatewayOrigin}/repo/doc/7`,
          url: `${gatewayOrigin}/api/items`,
        },
        config,
      ),
    ).toBeNull();
  });

  it("uses namespaced CSS/module referrers for root-relative dependencies without redirect loops", () => {
    expect(
      normalizeGatewayRequestUrl(
        {
          ...main,
          resourceType: "font",
          url: `${gatewayOrigin}/font.woff2`,
          referrer: `${namespace}/assets/style.css`,
        },
        config,
      ),
    ).toBe(`${namespace}/font.woff2`);
    expect(
      normalizeGatewayRequestUrl(
        {
          ...main,
          resourceType: "script",
          url: `${namespace}/module.js`,
          referrer: `${namespace}/assets/main.js`,
        },
        config,
      ),
    ).toBeNull();
  });

  it("does not capture shell, foreign iframe, different scheme/port or unknown frame resources", () => {
    expect(
      normalizeGatewayRequestUrl(
        {
          ...main,
          webContentsUrl: "http://localhost:5173",
          url: `${backendOrigin}/x`,
        },
        config,
      ),
    ).toBeNull();
    expect(
      normalizeGatewayRequestUrl(
        {
          ...main,
          webContentsUrl: "http://127.0.0.1:468001",
          url: `${backendOrigin}/x`,
        },
        config,
      ),
    ).toBeNull();
    expect(
      normalizeGatewayRequestUrl(
        {
          ...main,
          frameUrl: "https://external.example",
          url: `${backendOrigin}/x`,
        },
        config,
      ),
    ).toBeNull();
    expect(
      normalizeGatewayRequestUrl(
        { ...main, url: "http://business.example:8443/x" },
        config,
      ),
    ).toBeNull();
    expect(
      normalizeGatewayRequestUrl(
        { ...main, url: "https://business.example/x" },
        config,
      ),
    ).toBeNull();
    expect(
      normalizeGatewayRequestUrl(
        { ...main, frameUrl: undefined, url: `${gatewayOrigin}/assets/a.js` },
        config,
      ),
    ).toBeNull();
    expect(
      normalizeGatewayRequestUrl(
        { ...main, frameUrl: undefined, url: `${backendOrigin}/api/me` },
        config,
      ),
    ).toBeNull();
    expect(
      normalizeGatewayRequestUrl(
        {
          ...main,
          frameUrl: "https://external.example",
          parentFrameUrl: `${gatewayOrigin}/home`,
          resourceType: "subFrame",
          url: `${backendOrigin}/repo`,
        },
        config,
      ),
    ).toBeNull();
    expect(
      normalizeGatewayRequestUrl(
        {
          ...main,
          frameUrl: "about:blank",
          parentFrameUrl: `${gatewayOrigin}/home`,
          resourceType: "subFrame",
          url: `${backendOrigin}/repo`,
        },
        config,
      ),
    ).toBe(`${gatewayOrigin}/repo`);
  });

  it("inherits a verified parent for an existing empty initial frame, never for an absent frame", () => {
    const navigation = {
      ...main,
      resourceType: "subFrame",
      url: `${backendOrigin}/repo/page`,
      parentFrameUrl: `${gatewayOrigin}/home`,
    };
    expect(
      normalizeGatewayRequestUrl({ ...navigation, frameUrl: "" }, config),
    ).toBe(`${gatewayOrigin}/repo/page`);
    expect(
      normalizeGatewayRequestUrl(
        { ...navigation, frameUrl: undefined },
        config,
      ),
    ).toBeNull();
    expect(
      normalizeGatewayRequestUrl(
        {
          ...navigation,
          frameUrl: "",
          parentFrameUrl: "https://foreign.example/page",
        },
        config,
      ),
    ).toBeNull();
    expect(
      normalizeGatewayRequestUrl(
        { ...navigation, frameUrl: "", parentFrameUrl: undefined },
        config,
      ),
    ).toBeNull();
  });

  it("leaves WebSocket URLs alone because Electron cannot redirect handshakes", () => {
    expect(
      normalizeGatewayRequestUrl(
        {
          ...main,
          resourceType: "webSocket",
          url: "wss://business.example:8443/socket?q=1",
        },
        config,
      ),
    ).toBeNull();
    expect(
      normalizeGatewayRequestUrl(
        {
          ...main,
          frameUrl: `${gatewayOrigin}/repo/doc/7`,
          resourceType: "webSocket",
          url: "ws://127.0.0.1:46800/socket",
        },
        config,
      ),
    ).toBeNull();
  });

  it("requires the exact raw backend authority and never lets paths change the upstream origin", () => {
    for (const authority of [
      "evil.example",
      "business.example:8443@evil.example",
      "business.example%3A8443",
      "business.example:443",
      "business.example:8443\\evil.example",
    ]) {
      expect(
        resolveBackendNamespace(`/__backend/${authority}/x`, backendOrigin),
      ).toEqual({ kind: "forbidden" });
    }
    expect(
      resolveBackendNamespace(
        "/__backend/business.example:8443/assets/../file?q=%2f&x=1",
        backendOrigin,
      ),
    ).toEqual({ kind: "backend", path: "/file?q=%2f&x=1" });
    expect(
      resolveBackendNamespace(
        "/__backend/business.example:8443//evil.example/x",
        backendOrigin,
      ),
    ).toEqual({ kind: "backend", path: "//evil.example/x" });
    expect(resolveBackendNamespace("/local/file", backendOrigin)).toEqual({
      kind: "none",
    });
    expect(
      backendNamespaceUrl(
        "https://business.example:8443@evil.example/x",
        backendOrigin,
        gatewayOrigin,
      ),
    ).toBeNull();
  });

  it("keeps relative, root and same-origin absolute resource redirects inside the namespace", () => {
    for (const location of [
      "../final?q=1",
      "/final?q=1",
      `${backendOrigin}/final?q=1`,
    ]) {
      expect(
        namespaceRedirectLocation(location, "/assets/start", backendOrigin),
      ).toBe("/__backend/business.example:8443/final?q=1");
    }
    expect(
      namespaceRedirectLocation(
        "https://cdn.example/file",
        "/assets/start",
        backendOrigin,
      ),
    ).toBe("https://cdn.example/file");
  });
});
