import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ session: {}, webContents: {} }));
vi.mock("./commercialTicketSession", () => ({ currentTicket: () => "business-secret" }));
import { applySessionAuthHeaders } from "./sessionAuthInjection";
import { GATEWAY_REQUEST_HEADER } from "./loopbackGateway/requestContext";

describe("本地HTML无法借用平台凭据", () => {
  const context = { businessOrigin: "https://business.example", trustedOrigins: ["https://business.example", "http://127.0.0.1:46800"], gateway: { origin: "http://127.0.0.1:46800", requestSecret: "secret" } };
  it.each(["https://business.example/page", "http://127.0.0.1:46800/api/data", "https://cdn.example/script.js", "wss://business.example/ws"])("预览后代请求 %s 不携带任何Cookie/授权/网关能力", url => {
    const headers = applySessionAuthHeaders({
      url, method: "GET", resourceType: "subFrame", webContentsId: 1,
      webContents: { isDestroyed: () => false, getURL: () => "https://business.example/home" },
      frame: { url: "about:blank", parent: { url: "nuwax-local://grant/index.html" } },
      requestHeaders: { Cookie: "ticket=business-secret; other=cookie", Authorization: "Bearer secret", Referer: "nuwax-local://grant/index.html", [GATEWAY_REQUEST_HEADER]: "forged", Accept: "*/*" },
    } as never, context);
    expect(headers).toEqual({ Accept: "*/*" });
  });
});
