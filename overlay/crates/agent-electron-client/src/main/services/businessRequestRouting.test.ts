import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ onBeforeRequest: vi.fn(), contents: new Map(), appOn: vi.fn() }));
vi.mock("electron", () => ({
  app: { on: mocks.appOn },
  session: { defaultSession: { webRequest: { onBeforeRequest: mocks.onBeforeRequest } } },
  webContents: { fromId: (id: number) => mocks.contents.get(id) },
}));
const origin = "https://business.example:8443";
const mainHost = { isDestroyed: () => false };
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); mocks.contents.clear(); });

function guest(id: number, type = "webview", hostWebContents: unknown = mainHost) {
  const contents = Object.assign(new EventEmitter(), {
    id, getURL: vi.fn(() => `${origin}/home`), getType: () => type,
    isDestroyed: () => false, hostWebContents,
  });
  mocks.contents.set(id, contents);
  return contents;
}
function request(overrides = {}) {
  return { url: `${origin}/repo/doc/a?q=%252F`, method: "GET", resourceType: "mainFrame", webContentsId: 1, ...overrides };
}
function dispatch(details = request()) {
  const callback = vi.fn();
  mocks.onBeforeRequest.mock.calls[0][1](details, callback);
  expect(callback).toHaveBeenCalledTimes(1);
  return callback.mock.calls[0][0];
}

describe("商业文档请求分发", () => {
  it("拦截 direct GET，缺失窗口和宿主 renderer 不接管", async () => {
    const mod = await import("./businessRequestRouting");
    mod.initBusinessRequestRouting(() => origin, () => mainHost as never);
    expect(dispatch()).toEqual({});
    guest(1, "window");
    expect(dispatch()).toEqual({});
    guest(1);
    expect(dispatch().redirectURL).toBe(`${origin}/home#__nuwax_spa_restore=%2Frepo%2Fdoc%2Fa%3Fq%3D%25252F`);
    guest(2, "window");
    expect(dispatch(request({ webContentsId: 2 }))).toEqual({});
    guest(3, "webview", { isDestroyed: () => false });
    expect(dispatch(request({ webContentsId: 3 }))).toEqual({});
    guest(4, "webview", null);
    expect(dispatch(request({ webContentsId: 4 }))).toEqual({});
  });
  it.each([
    { method: "POST" }, { method: "HEAD" }, { resourceType: "subFrame" },
    { resourceType: "xhr" }, { url: `${origin}/repo/internal/session` },
    { url: `${origin}/repo/ws` }, { url: `${origin}/instant-message/assets/a.js` },
    { url: "https://other.example/repo/doc/a" }, { url: `${origin}/login` },
    { url: `${origin}/repo/assets/missing` },
  ])("排除非页面请求 %j", async (changes) => {
    const mod = await import("./businessRequestRouting");
    mod.initBusinessRequestRouting(() => origin, () => mainHost as never); guest(1);
    expect(dispatch(request(changes))).toEqual({});
  });
  it("同一监听器切换 gateway/direct，不互相注销或覆盖", async () => {
    const mod = await import("./businessRequestRouting");
    mod.initBusinessRequestRouting(() => origin, () => mainHost as never); guest(1);
    mod.setGatewayRequestRouting({ gatewayOrigin: "http://127.0.0.1:46800", backendOrigin: origin, backendPrefixes: ["/api", "/repo"] });
    expect(dispatch()).toEqual({});
    const contents = mocks.contents.get(1);
    contents.getURL.mockReturnValue("http://127.0.0.1:46800/home");
    expect(dispatch(request({ frame: { url: "http://127.0.0.1:46800/home" } })).redirectURL).toBe("http://127.0.0.1:46800/repo/doc/a?q=%252F");
    mod.setGatewayRequestRouting(null);
    expect(dispatch().redirectURL).toContain("/home#__nuwax_spa_restore=");
    expect(mocks.onBeforeRequest).toHaveBeenCalledTimes(1);
  });
  it("导航 hash 按窗口和当前请求绑定；失败后清除旧目标", async () => {
    const mod = await import("./businessRequestRouting");
    mod.initBusinessRequestRouting(() => origin, () => mainHost as never);
    const { session } = await import("electron");
    const one = guest(1); const two = guest(2);
    Object.assign(one, { session: session.defaultSession });
    Object.assign(two, { session: session.defaultSession });
    const created = mocks.appOn.mock.calls.find(([event]) => event === "web-contents-created")![1];
    created({}, one); created({}, two);
    one.emit("did-start-navigation", { url: `${request().url}#one`, isMainFrame: true, isSameDocument: false });
    two.emit("did-start-navigation", {}, `${request().url}#two`, false, true);
    expect(decodeURIComponent(dispatch().redirectURL.split("=")[1])).toBe("/repo/doc/a?q=%252F#one");
    expect(decodeURIComponent(dispatch(request({ webContentsId: 2 })).redirectURL.split("=")[1])).toBe("/repo/doc/a?q=%252F#two");
    expect(dispatch(request({ url: `${origin}/repo/doc/b` })).redirectURL).not.toContain("one");
    one.emit("did-fail-load", {}, -3, "ERR_ABORTED", request().url, true);
    expect(decodeURIComponent(dispatch().redirectURL.split("=")[1])).toContain("#one");
    one.emit("did-fail-load", {}, -102, "late old failure", `${origin}/repo/doc/old`, true);
    expect(decodeURIComponent(dispatch().redirectURL.split("=")[1])).toContain("#one");
    one.emit("did-fail-load", {}, -102, "fail", request().url, true);
    expect(dispatch().redirectURL).not.toContain("one");
  });
  it("禁用 direct/换业务域即时生效", async () => {
    const mod = await import("./businessRequestRouting");
    let current: string | null = null;
    mod.initBusinessRequestRouting(() => current, () => mainHost as never); guest(1);
    expect(dispatch()).toEqual({});
    current = origin; expect(dispatch().redirectURL).toBeTruthy();
    current = "https://new.example"; expect(dispatch()).toEqual({});
  });
  it("主窗口未创建、已销毁或重建时，只处理当前主窗口的 guest", async () => {
    const mod = await import("./businessRequestRouting");
    let currentHost: unknown = null;
    mod.initBusinessRequestRouting(() => origin, () => currentHost as never);
    const contents = guest(1);
    expect(dispatch()).toEqual({});
    currentHost = mainHost; expect(dispatch().redirectURL).toBeTruthy();
    const nextHost = { isDestroyed: () => false };
    currentHost = nextHost; expect(dispatch()).toEqual({});
    contents.hostWebContents = nextHost; expect(dispatch().redirectURL).toBeTruthy();
    currentHost = { isDestroyed: () => true };
    contents.hostWebContents = currentHost; expect(dispatch()).toEqual({});
  });
});
