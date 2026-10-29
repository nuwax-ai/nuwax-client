import { describe, expect, it } from "vitest";
import {
  backendNamespaceUrl,
  normalizeGatewayRequestUrl,
  resolveBackendNamespace,
  namespaceRedirectLocation,
  type GatewayRoutingConfig,
} from "./routingPolicy";

const backendOrigin = "https://business.example:8443";
const gatewayOrigin = "http://127.0.0.1:46800";
const config = {
  backendOrigin,
  gatewayOrigin,
  backendPrefixes: ["/api", "/repo", "/instant-message", "/computer", "/page"],
};
const namespace = `${gatewayOrigin}/__backend/business.example:8443`;
const main = {
  resourceType: "xhr",
  webContentsUrl: `${gatewayOrigin}/home`,
  frameUrl: `${gatewayOrigin}/home`,
};

describe("backend URL routing", () => {
  it("keeps top-level IdP and identity state on the callback's business origin", () => {
    for (const pathname of ["/api/auth/idp/authorize", "/api/auth/idp/callback/3", "/api/user/identity/bind/3", "/auth/bind"]) {
      const request = {...main, resourceType: "mainFrame", url: `${backendOrigin}${pathname}?state=fixture`};
      expect(normalizeGatewayRequestUrl(request, config)).toBeNull();
      // This exception grants no credential capability to iframe/XHR paths.
      expect(normalizeGatewayRequestUrl({...request, resourceType: "subFrame"}, config)).toBe(`${gatewayOrigin}${pathname}?state=fixture`);
      expect(normalizeGatewayRequestUrl({...request, resourceType: "xhr"}, config)).toBe(`${namespace}${pathname}?state=fixture`);
    }
  });
  const devFrontendOrigin = "http://localhost:3099";
  const devConfig: GatewayRoutingConfig = { ...config, devFrontendOrigin };
  const devPage = {
    resourceType: "xhr",
    webContentsUrl: `${devFrontendOrigin}/home`,
    frameUrl: `${devFrontendOrigin}/home`,
  };

  it("routes absolute business XHR from the explicitly configured development frontend", () => {
    expect(
      normalizeGatewayRequestUrl(
        { ...devPage, url: `${backendOrigin}/api/user/login?mode=password` },
        devConfig,
      ),
    ).toBe(`${namespace}/api/user/login?mode=password`);
    expect(
      normalizeGatewayRequestUrl(
        { ...devPage, url: `${backendOrigin}/api/user/me` },
        config,
      ),
    ).toBeNull();
  });

  it("requires the exact development page and frame origins", () => {
    for (const page of [
      "http://localhost:3000/home",
      "http://127.0.0.1:3099/home",
      "https://localhost:3099/home",
      "https://foreign.example/home",
    ]) {
      expect(
        normalizeGatewayRequestUrl(
          { ...devPage, webContentsUrl: page, frameUrl: page, url: `${backendOrigin}/api/user/me` },
          devConfig,
        ),
      ).toBeNull();
    }
    for (const frameUrl of [
      undefined,
      `${gatewayOrigin}/home`,
      "http://localhost:3000/home",
      "https://foreign.example/frame",
    ]) {
      expect(
        normalizeGatewayRequestUrl(
          { ...devPage, frameUrl, parentFrameUrl: devPage.webContentsUrl, url: `${backendOrigin}/api/user/me` },
          devConfig,
        ),
      ).toBeNull();
    }
  });

  it("preserves development navigation, frontend assets, HMR and foreign requests", () => {
    for (const resourceType of ["mainFrame", "subFrame", "script", "stylesheet", "image"]) {
      expect(
        normalizeGatewayRequestUrl(
          { ...devPage, resourceType, url: `${backendOrigin}/repo/page` },
          devConfig,
        ),
      ).toBeNull();
    }
    for (const url of [
      `${devFrontendOrigin}/api/local`,
      `${devFrontendOrigin}/assets/main.js`,
      `${devFrontendOrigin}/@vite/client`,
      "ws://localhost:3099/?token=hmr",
      `${gatewayOrigin}/assets/main.js`,
      "https://cdn.example/api/user/me",
      "http://business.example:8443/api/user/me",
      "https://business.example/api/user/me",
      `${namespace}/api/user/me`,
    ]) {
      expect(normalizeGatewayRequestUrl({ ...devPage, url }, devConfig)).toBeNull();
    }
  });

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
          { ...main, frameUrl: `${gatewayOrigin}/repo/doc/7`, parentFrameUrl: main.webContentsUrl, url },
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

  it("keeps the main SPA's assets local on microapp routes", () => {
    for (const route of ["/repo", "/repo/doc/7", "/instant-message"]) {
      const page = `${gatewayOrigin}${route}`;
      for (const asset of ["/p__MicroAppEntry__index.63c12b11.async.js", "/umi.css", "/favicon.ico"]) {
        expect(
          normalizeGatewayRequestUrl(
            { ...main, webContentsUrl: page, frameUrl: page, url: `${gatewayOrigin}${asset}` },
            config,
          ),
        ).toBeNull();
      }
    }
  });

  it("keeps published app documents at /page for both top-level and iframe navigation", () => {
    for (const resourceType of ["mainFrame", "subFrame"]) {
      expect(
        normalizeGatewayRequestUrl(
          { ...main, resourceType, url: `${backendOrigin}/page/app-7/prod/?mode=preview#section` },
          config,
        ),
      ).toBe(`${gatewayOrigin}/page/app-7/prod/?mode=preview#section`);
    }
  });

  it("routes published app root-relative assets for both top-level and trusted iframe documents", () => {
    const appPage = `${gatewayOrigin}/page/app-7/prod/`;
    for (const embedded of [false, true]) {
      for (const [resourceType, path] of [
        ["script", "/assets/app.js?q=%2F"],
        ["script", "/sdk/client.js"],
        ["stylesheet", "/assets/style.css"],
        ["image", "/logo.svg"],
        ["xhr", "/data/config.json"],
      ]) {
        expect(
          normalizeGatewayRequestUrl(
            {
              ...main,
              webContentsUrl: embedded ? main.webContentsUrl : appPage,
              frameUrl: appPage,
              ...(embedded ? { parentFrameUrl: main.webContentsUrl } : {}),
              resourceType,
              url: gatewayOrigin + path,
            },
            config,
          ),
        ).toBe(namespace + path);
      }
    }
  });

  it("does not infer published app ownership from another origin, pathname or missing frame", () => {
    const appPage = `${gatewayOrigin}/page/app-7/prod/`;
    for (const context of [
      { webContentsUrl: `${gatewayOrigin}/pages/app-7/prod/`, frameUrl: `${gatewayOrigin}/pages/app-7/prod/` },
      { webContentsUrl: `${gatewayOrigin}/page-builder`, frameUrl: `${gatewayOrigin}/page-builder` },
      { webContentsUrl: appPage, frameUrl: undefined },
      { webContentsUrl: appPage, frameUrl: "https://foreign.example/page/app-7/prod/" },
      { webContentsUrl: appPage, frameUrl: appPage, parentFrameUrl: "https://foreign.example/home" },
      { webContentsUrl: main.webContentsUrl, frameUrl: appPage },
    ]) {
      expect(
        normalizeGatewayRequestUrl({ ...main, ...context, url: `${gatewayOrigin}/assets/app.js` }, config),
      ).toBeNull();
    }
    expect(
      normalizeGatewayRequestUrl(
        { ...main, webContentsUrl: appPage, frameUrl: appPage, url: "https://cdn.example/sdk/client.js" },
        config,
      ),
    ).toBeNull();
    expect(
      normalizeGatewayRequestUrl(
        { ...main, webContentsUrl: appPage, frameUrl: appPage, url: `${gatewayOrigin}/assets/app.js` },
        { ...config, backendPrefixes: config.backendPrefixes.filter((prefix) => prefix !== "/page") },
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
    for (const [resourceType, source, target] of [
      ["font", "/assets/style.css", "/fonts/app.woff2"],
      ["script", "/assets/main.js", "/sdk/module.js"],
    ]) {
      const appPage = `${gatewayOrigin}/page/app-7/prod/`;
      expect(
        normalizeGatewayRequestUrl(
          {
            ...main,
            webContentsUrl: appPage,
            frameUrl: appPage,
            resourceType,
            url: gatewayOrigin + target,
            referrer: namespace + source,
          },
          config,
        ),
      ).toBe(namespace + target);
      expect(
        normalizeGatewayRequestUrl(
          {
            ...main,
            webContentsUrl: appPage,
            frameUrl: appPage,
            resourceType,
            url: namespace + target,
            referrer: namespace + source,
          },
          config,
        ),
      ).toBeNull();
    }
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
