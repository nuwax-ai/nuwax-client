import { EventEmitter } from "node:events";
import type { App, OnHeadersReceivedListenerDetails, Session } from "electron";
import { describe, expect, it, vi } from "vitest";
import { initFrameEmbeddingPolicy, rewriteResponseHeaders } from "./frameEmbeddingPolicy";

const embeddingOptions = { allowFrameEmbedding: true, fixDevCors: false };
const documentDetails = {
  url: "https://preview.example.com/page/",
  resourceType: "subFrame" as const,
};

function createSession() {
  const onHeadersReceived = vi.fn();
  const target = { webRequest: { onHeadersReceived } } as unknown as Session;
  const receive = (details: Partial<OnHeadersReceivedListenerDetails>) => {
    const callback = vi.fn();
    onHeadersReceived.mock.calls[0][0]({ ...documentDetails, ...details }, callback);
    return callback.mock.calls[0][0];
  };
  return { target, onHeadersReceived, receive };
}

function createApp() {
  const events = new EventEmitter();
  return { app: events as unknown as App, events };
}

describe("frame embedding response headers", () => {
  it("removes all XFO and frame-ancestors headers without changing other directives or cookie arrays", () => {
    const cookies = [
      "ticket=first; Path=/; HttpOnly; Expires=Wed, 07 Oct 2026 00:00:00 GMT",
      "lang=zh-CN; Path=/; SameSite=Lax",
    ];
    const headers = {
      "X-Frame-Options": ["DENY"],
      "x-frame-options": ["SAMEORIGIN"],
      "Content-Security-Policy": [
        "default-src 'self'; frame-ancestors 'none'; script-src 'self'",
        "FRAME-ANCESTORS https://business.example; img-src *",
      ],
      "content-security-policy": ["connect-src https://api.example; frame-ancestors 'self'"],
      "Content-Security-Policy-Report-Only": [
        "frame-ancestors 'none'; report-uri /csp; sandbox allow-scripts",
      ],
      "Set-Cookie": cookies,
      "Content-Type": ["text/html"],
    };
    const result = rewriteResponseHeaders({ ...documentDetails, responseHeaders: headers }, embeddingOptions);
    expect(result).toEqual({
      "Content-Security-Policy": [
        "default-src 'self'; script-src 'self'",
        " img-src *",
      ],
      "content-security-policy": ["connect-src https://api.example"],
      "Content-Security-Policy-Report-Only": [" report-uri /csp; sandbox allow-scripts"],
      "Set-Cookie": cookies,
      "Content-Type": ["text/html"],
    });
    expect(result?.["Set-Cookie"]).toBe(cookies);
    expect(result?.["Content-Type"]).toBe(headers["Content-Type"]);
    expect(headers["X-Frame-Options"]).toEqual(["DENY"]);
    expect(headers["Content-Security-Policy"][0]).toContain("frame-ancestors");
  });

  it("handles each comma-separated policy and repeated frame-ancestors directives", () => {
    expect(rewriteResponseHeaders({
      ...documentDetails,
      responseHeaders: {
        "Content-Security-Policy": [
          "default-src 'self'; frame-ancestors 'none', frame-ancestors 'self'; script-src 'none'; FRAME-ANCESTORS *",
          "frame-ancestors 'none', frame-ancestors 'self', img-src https://assets.example",
        ],
      },
    }, embeddingOptions)).toEqual({
      "Content-Security-Policy": [
        "default-src 'self', script-src 'none'",
        " img-src https://assets.example",
      ],
    });
  });

  it("deletes a CSP header when its policies contain only frame-ancestors", () => {
    expect(rewriteResponseHeaders({
      ...documentDetails,
      responseHeaders: {
        "CONTENT-SECURITY-POLICY": ["frame-ancestors 'none';", "FRAME-ANCESTORS *"],
        "content-security-policy-report-only": [" frame-ancestors 'self', frame-ancestors *"],
      },
    }, embeddingOptions)).toEqual({});
  });

  it("returns no rewrite for absent headers, unrelated CSP directives, or similar directive names", () => {
    expect(rewriteResponseHeaders(documentDetails, embeddingOptions)).toBeUndefined();
    expect(rewriteResponseHeaders({
      ...documentDetails,
      responseHeaders: {
        "Content-Security-Policy": ["default-src 'self'; frame-src https://preview.example; frame-ancestors-extra 'none'"],
        "Set-Cookie": ["ticket=unchanged; Path=/; HttpOnly"],
      },
    }, embeddingOptions)).toBeUndefined();
  });

  it.each(["mainFrame", "subFrame"] as const)("rewrites an HTTP %s document", (resourceType) => {
    expect(rewriteResponseHeaders({
      url: "http://127.0.0.1:30201/page/app/prod/",
      resourceType,
      responseHeaders: { "X-Frame-Options": ["DENY"] },
    }, embeddingOptions)).toEqual({});
  });

  it.each(["xhr", "script", "image", "stylesheet"] as const)("leaves %s responses unchanged", (resourceType) => {
    expect(rewriteResponseHeaders({
      ...documentDetails,
      resourceType,
      responseHeaders: { "X-Frame-Options": ["DENY"], "Content-Security-Policy": ["frame-ancestors 'none'"] },
    }, embeddingOptions)).toBeUndefined();
  });

  it.each(["file:///preview.html", "data:text/html,preview", "custom://preview/app"])("leaves the non-HTTP document unchanged: %s", (url) => {
    expect(rewriteResponseHeaders({
      ...documentDetails,
      url,
      responseHeaders: { "X-Frame-Options": ["DENY"] },
    }, embeddingOptions)).toBeUndefined();
  });

  it("merges the developer CORS fix with the embedding policy and retains all cookies", () => {
    const cookies = ["ticket=T; Path=/; HttpOnly", "lang=zh-CN; Path=/"];
    const result = rewriteResponseHeaders({
      ...documentDetails,
      responseHeaders: {
        "ACCESS-CONTROL-ALLOW-ORIGIN": ["*", "http://localhost:5173"],
        "X-Frame-Options": ["DENY"],
        "Set-Cookie": cookies,
      },
    }, { allowFrameEmbedding: true, fixDevCors: true });
    expect(result).toEqual({
      "ACCESS-CONTROL-ALLOW-ORIGIN": ["http://localhost:5173"],
      "Set-Cookie": cookies,
    });
    expect(result?.["Set-Cookie"]).toBe(cookies);
  });

  it("retains the previous CORS behavior when all duplicated origins are wildcards", () => {
    expect(rewriteResponseHeaders({
      ...documentDetails,
      responseHeaders: {
        "Access-Control-Allow-Origin": ["*", "*"],
        "X-Frame-Options": ["DENY"],
      },
    }, { allowFrameEmbedding: false, fixDevCors: true })).toEqual({
      "Access-Control-Allow-Origin": ["*"],
      "X-Frame-Options": ["DENY"],
    });
  });
});

describe("session response header policy installation", () => {
  it("installs once on the default session and on every later session", () => {
    const { app, events } = createApp();
    const primary = createSession();
    const temporary = createSession();
    const persistent = createSession();
    const options = { app, defaultSession: primary.target, isCommercial: true, isDev: false };
    initFrameEmbeddingPolicy(options);
    initFrameEmbeddingPolicy(options);
    events.emit("session-created", primary.target);
    events.emit("session-created", temporary.target);
    events.emit("session-created", temporary.target);
    events.emit("session-created", persistent.target);
    expect(events.listenerCount("session-created")).toBe(1);
    for (const item of [primary, temporary, persistent]) {
      expect(item.onHeadersReceived).toHaveBeenCalledOnce();
      expect(item.receive({ responseHeaders: { "X-Frame-Options": ["DENY"] } })).toEqual({ responseHeaders: {} });
      expect(item.receive({ responseHeaders: { "Set-Cookie": ["ticket=T"] } })).toEqual({});
    }
  });

  it("runs developer CORS normalization only in the default commercial session", () => {
    const { app, events } = createApp();
    const primary = createSession();
    const temporary = createSession();
    initFrameEmbeddingPolicy({ app, defaultSession: primary.target, isCommercial: true, isDev: true });
    events.emit("session-created", temporary.target);
    const responseHeaders = { "Access-Control-Allow-Origin": ["*", "https://business.example"] };
    expect(primary.receive({ responseHeaders })).toEqual({ responseHeaders: { "Access-Control-Allow-Origin": ["https://business.example"] } });
    expect(temporary.receive({ responseHeaders })).toEqual({});
  });

  it("keeps community development limited to the existing default-session CORS behavior", () => {
    const { app, events } = createApp();
    const primary = createSession();
    const temporary = createSession();
    initFrameEmbeddingPolicy({ app, defaultSession: primary.target, isCommercial: false, isDev: true });
    events.emit("session-created", temporary.target);
    expect(events.listenerCount("session-created")).toBe(0);
    expect(temporary.onHeadersReceived).not.toHaveBeenCalled();
    expect(primary.receive({ responseHeaders: { "X-Frame-Options": ["DENY"], "Content-Security-Policy": ["frame-ancestors 'none'"] } })).toEqual({});
    expect(primary.receive({ responseHeaders: { "Access-Control-Allow-Origin": ["*", "http://localhost:5173"] } })).toEqual({ responseHeaders: { "Access-Control-Allow-Origin": ["http://localhost:5173"] } });
  });

  it("does not install any response policy in the packaged community client", () => {
    const { app, events } = createApp();
    const primary = createSession();
    initFrameEmbeddingPolicy({ app, defaultSession: primary.target, isCommercial: false, isDev: false });
    expect(primary.onHeadersReceived).not.toHaveBeenCalled();
    expect(events.listenerCount("session-created")).toBe(0);
  });
});
