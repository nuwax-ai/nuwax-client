import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSpaDocumentUrl, SPA_RESTORE_ARGUMENT } from "@shared/utils/spaDocumentRoute";

const expose = vi.hoisted(() => vi.fn());
const invoke = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: expose },
  ipcRenderer: { on: vi.fn(), send: vi.fn(), invoke },
}));

const addedArgs: string[] = [];
afterEach(() => {
  for (const arg of addedArgs) {
    const index = process.argv.indexOf(arg);
    if (index >= 0) process.argv.splice(index, 1);
  }
  addedArgs.length = 0;
  vi.unstubAllGlobals();
  expose.mockClear();
  invoke.mockReset();
});

async function loadAt(href: string, allowlist: string | null = encodeURIComponent(JSON.stringify(["https://business.example"])), mainGuest = false) {
  vi.resetModules();
  const product = "--nuwax-host-product=nuwax";
  const args = [product, ...(allowlist === null ? [] : [`--nuwax-trusted-origins=${allowlist}`]), ...(mainGuest ? [SPA_RESTORE_ARGUMENT] : [])];
  process.argv.push(...args);
  addedArgs.push(...args);
  const page = { location: { href, origin: new URL(href).origin }, addEventListener: vi.fn(), history: { state: null, replaceState: vi.fn() }, top: null as unknown };
  page.top = page;
  vi.stubGlobal("window", page);
  await import("./webviewPerfBridge");
  return page;
}

describe("commercial guest preload origin guard", () => {
  it.each([true, false])("私有深链恢复仅在主窗口 guest 标记存在时运行：%s", async (mainGuest) => {
    const page = await loadAt(buildSpaDocumentUrl(new URL("https://business.example/repo/doc/a?q=%25#anchor")), undefined, mainGuest);
    if (mainGuest) expect(page.history.replaceState).toHaveBeenCalledWith(null, "", "/repo/doc/a?q=%25#anchor");
    else expect(page.history.replaceState).not.toHaveBeenCalled();
  });
  it.each(["direct", "gateway"])("NUW-49：%s 企业切域先读取当前文档上下文", async (loadMode) => {
    await loadAt("https://business.example/login");
    const bridge = expose.mock.calls.at(-1)![1];
    const result = { success: true, serverHost: "https://next.example" };
    invoke.mockResolvedValueOnce({ businessOrigin: "https://business.example", loadMode })
      .mockResolvedValueOnce(result);
    expect(await bridge.auth.configureServerHost("https://next.example")).toEqual(result);
    expect(invoke.mock.calls).toEqual([
      ["auth:getContext"], ["auth:configureServerHost", "https://next.example"],
    ]);
  });

  it("当前文档已不可信时不发起企业切域", async () => {
    await loadAt("https://business.example/login");
    const bridge = expose.mock.calls.at(-1)![1];
    invoke.mockResolvedValueOnce(null);
    expect(await bridge.auth.configureServerHost("https://next.example"))
      .toEqual({ success: false, error: "Stale document" });
    expect(invoke.mock.calls).toEqual([["auth:getContext"]]);
  });

  it("exposes the bridge on the admitted business origin", async () => {
    await loadAt("https://business.example");
    expect(expose).toHaveBeenCalledWith("NuwaClawBridge", expect.any(Object));
  });

  it("does not expose any bridge after cross-origin navigation", async () => {
    await loadAt("https://external.example");
    expect(expose).not.toHaveBeenCalled();
  });

  it.each(["https://business.example", "http://127.0.0.1:46800", "https://mirror.example"])("exposes only the actual admitted business or mirror origin %s", async (origin) => {
    await loadAt(`${origin}/document`, encodeURIComponent(JSON.stringify([
      "https://business.example", "http://127.0.0.1:46800", "https://mirror.example",
    ])));
    expect(expose).toHaveBeenCalledWith("NuwaClawBridge", expect.any(Object));
  });

  it.each([
    "https://user@business.example/document", "https://user:password@business.example/document",
  ])("does not expose the bridge on credential-bearing document %s", async (href) => {
    await loadAt(href);
    expect(expose).not.toHaveBeenCalled();
  });

  it.each(["about:blank", "data:text/html,fixture", "file:///tmp/fixture.html"])("does not expose the bridge on non-web document %s even if null origin is listed", async (href) => {
    await loadAt(href, encodeURIComponent(JSON.stringify(["null"])));
    expect(expose).not.toHaveBeenCalled();
  });

  it.each([
    null, "", "%", encodeURIComponent("broken-json"),
    encodeURIComponent(JSON.stringify({ origin: "https://business.example" })),
    encodeURIComponent(JSON.stringify([])),
    encodeURIComponent(JSON.stringify(["https://business.example/path"])),
  ])("fails closed on missing, malformed, or mismatched origin allowlist %j", async (allowlist) => {
    await loadAt("https://business.example/document", allowlist);
    expect(expose).not.toHaveBeenCalled();
  });

  it.each(["https://child.business.example/document", "http://business.example/document", "https://business.example:8443/document"])("does not widen the trusted origin to %s", async (href) => {
    await loadAt(href);
    expect(expose).not.toHaveBeenCalled();
  });
});
