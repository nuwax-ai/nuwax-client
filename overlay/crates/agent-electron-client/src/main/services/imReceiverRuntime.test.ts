import { EventEmitter } from "node:events";
import http, { type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { BrowserWindow, WebContents } from "electron";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IMNativePresentationOptions } from "./imNativePresentation";

const SELF_ID = "9223372036854775701";
const CONV_ID = "9223372036854775806";
const MSG_ID = "9223372036854775807";

const mocks = vi.hoisted(() => ({
  origin: "", ticket: "synthetic-im-ticket" as string | null, epoch: 4, online: true,
  idle: "active", settings: new Map<string, unknown>(),
  windows: [] as BrowserWindow[], contents: [] as WebContents[],
  appEvents: null as EventEmitter | null, powerEvents: null as EventEmitter | null,
  fetch: vi.fn(), writeSetting: vi.fn(), mirror: vi.fn(), mirrorUpgrade: vi.fn(),
  hostCommand: vi.fn(), info: vi.fn(), warn: vi.fn(),
  ignoreAbortPath: "",
  nativeOptions: null as IMNativePresentationOptions | null,
  native: { setUnreadCount: vi.fn(), showMessage: vi.fn(() => true), clear: vi.fn(), dispose: vi.fn() },
}));

vi.mock("electron", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  const appEvents = Object.assign(new Emitter(), { getVersion: () => "1.2.3" });
  const powerEvents = Object.assign(new Emitter(), { getSystemIdleState: () => mocks.idle });
  mocks.appEvents = appEvents;
  mocks.powerEvents = powerEvents;
  return {
    app: appEvents, powerMonitor: powerEvents,
    BrowserWindow: { getAllWindows: () => mocks.windows },
    webContents: { getAllWebContents: () => mocks.contents },
    net: {
      isOnline: () => mocks.online,
      fetch: (url: string, options: RequestInit) => {
        // 任何非本地请求都让测试立即失败，测试用凭据不能发给业务服务器。
        const target = new URL(url);
        if (target.hostname !== "127.0.0.1" || target.origin !== mocks.origin) {
          throw new Error("Unexpected nonlocal IM test request");
        }
        mocks.fetch(url, options);
        const headers = { ...(options.headers as Record<string, string>) };
        // 模拟 Electron webRequest 先消费主进程私有能力标记，再真正发 HTTP。
        delete headers["x-nuwax-native-ticket"];
        return globalThis.fetch(url, {
          ...options, headers,
          ...(target.pathname === mocks.ignoreAbortPath ? { signal: undefined } : {}),
        });
      },
    },
  };
});
vi.mock("electron-log", () => ({ default: { info: mocks.info, warn: mocks.warn } }));
vi.mock("../db", () => ({
  readSetting: (key: string) => mocks.settings.get(key) ?? null,
  writeSetting: (key: string, value: unknown) => { mocks.settings.set(key, value); mocks.writeSetting(key, value); return true; },
}));
vi.mock("./commercialSessionScope", () => ({ currentBusinessOrigin: () => mocks.origin }));
vi.mock("./commercialTicketSession", () => ({
  currentTicket: () => mocks.ticket, ticketEpoch: () => mocks.epoch,
  mirrorNativeResponseTicket: async (...args: unknown[]) => { mocks.mirror(...args); },
  mirrorGatewaySetCookies: async (...args: unknown[]) => { await mocks.mirrorUpgrade(...args); return true; },
}));
vi.mock("./system/deviceId", () => ({ getDeviceId: () => "machine-123" }));
vi.mock("./hostActivity", () => ({ sendHostCommandToMainWindowGuests: mocks.hostCommand }));
vi.mock("./imNativePresentation", () => ({
  createIMNativePresentation: (options: IMNativePresentationOptions) => {
    mocks.nativeOptions = options;
    return mocks.native;
  },
}));

type Runtime = typeof import("./imReceiverRuntime");
let runtime: Runtime | null = null;
const backends: Array<() => Promise<void>> = [];

function guest(url: () => string) {
  const contents = Object.assign(new EventEmitter(), {
    getURL: url, isDestroyed: () => false, send: vi.fn(),
  });
  return Object.assign(contents, { contents: contents as unknown as WebContents });
}

function mainWindow() {
  const window = { isDestroyed: () => false, isFocused: vi.fn(() => false) };
  return Object.assign(window, { window: window as unknown as BrowserWindow });
}

function reply(response: ServerResponse, data: unknown, code = "0000", status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ code, data }));
}

async function localBackend() {
  const requests: Array<{ path: string; method: string; headers: IncomingHttpHeaders; body: unknown }> = [];
  const connections: IncomingHttpHeaders[] = [];
  const packets: Array<{ op: number; body?: Record<string, unknown> }> = [];
  const sockets: WebSocket[] = [];
  const transports = new Set<Socket>();
  const state = {
    unread: { total: 9, dndTotal: 2 },
    conversation: { dnd: false, convType: 4, name: "Team" },
    registerReject: null as { code: string; status: number; rawBody?: string } | null,
    upgradeCookie: null as string | null,
    connectReject: null as string | null,
    unreadHandler: null as ((response: ServerResponse) => void) | null,
    conversationHandler: null as ((response: ServerResponse) => void) | null,
  };
  const server = http.createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += String(chunk);
    const path = new URL(request.url!, "http://127.0.0.1").pathname;
    requests.push({ path, method: request.method!, headers: request.headers, body: text ? JSON.parse(text) : undefined });
    if (path === "/api/instant-message/devices") {
      if (state.registerReject?.rawBody) {
        response.writeHead(state.registerReject.status, { "content-type": "text/html" });
        response.end(state.registerReject.rawBody);
      } else if (state.registerReject) reply(response, null, state.registerReject.code, state.registerReject.status);
      else reply(response, { deviceId: "machine-123#im-native" });
    } else if (path === "/api/instant-message/unread-total") {
      if (state.unreadHandler) state.unreadHandler(response); else reply(response, state.unread);
    } else if (path.startsWith("/api/instant-message/conversations/")) {
      if (state.conversationHandler) state.conversationHandler(response); else reply(response, state.conversation);
    } else reply(response, null, "unexpected_test_route", 404);
  });
  server.on("connection", (socket) => {
    transports.add(socket);
    socket.on("close", () => transports.delete(socket));
  });
  const ws = new WebSocketServer({
    server, path: "/instant-message/ws",
    handleProtocols: (protocols) => protocols.has("im-v1") ? "im-v1" : false,
  });
  ws.on("headers", headers => { if (state.upgradeCookie) headers.push(`Set-Cookie: ${state.upgradeCookie}`); });
  ws.on("connection", (socket, request) => {
    sockets.push(socket);
    connections.push(request.headers);
    socket.on("message", (buffer) => {
      const packet = JSON.parse(buffer.toString());
      packets.push(packet);
      if (packet.op === 1000) {
        socket.send(state.connectReject
          ? JSON.stringify({ v: 1, op: 1002, code: state.connectReject })
          : `{"v":1,"op":1001,"body":{"heartbeatInterval":30,"userId":${SELF_ID}}}`);
      } else if (packet.op === 2000) socket.send('{"v":1,"op":2001}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const close = async () => {
    for (const socket of sockets) socket.terminate();
    for (const socket of transports) socket.destroy();
    await new Promise<void>((resolve) => ws.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  backends.push(close);
  return {
    state, requests, connections, packets, sockets, origin: `http://127.0.0.1:${port}`,
    send(packet: string | object) {
      const socket = [...sockets].reverse().find((item) => item.readyState === WebSocket.OPEN);
      if (!socket) throw new Error("No connected local IM test socket");
      socket.send(typeof packet === "string" ? packet : JSON.stringify(packet));
    },
    sendMessage(msgId = MSG_ID, extra = "", senderId = "9223372036854775804") {
      this.send(`{"v":1,"op":3002,"body":{"convId":${CONV_ID},"msgId":${msgId},"senderId":${senderId},"senderName":"Alice","digest":"<b>Hello</b>\\nteam"${extra}}}`);
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NUWAX_APP_IDENTIFIER", "nuwax");
  vi.clearAllMocks();
  mocks.settings.clear();
  mocks.contents = [];
  mocks.windows = [];
  mocks.ticket = "synthetic-im-ticket";
  mocks.epoch = 4;
  mocks.online = true;
  mocks.idle = "active";
  mocks.ignoreAbortPath = "";
  mocks.nativeOptions = null;
  mocks.appEvents?.removeAllListeners();
  mocks.powerEvents?.removeAllListeners();
});

afterEach(async () => {
  runtime?.disposeIMReceiver();
  runtime = null;
  for (const close of backends.splice(0)) await close();
  vi.unstubAllEnvs();
});

async function start(backend: Awaited<ReturnType<typeof localBackend>>) {
  mocks.origin = backend.origin;
  const business = guest(() => `${backend.origin}/home`);
  const external = guest(() => "https://preview.example/page");
  const main = mainWindow();
  mocks.contents = [business.contents, external.contents];
  mocks.windows = [main.window];
  runtime = await import("./imReceiverRuntime");
  runtime.initIMReceiver(() => main.window);
  runtime.startIMReceiver("account-1");
  return { business, external, main, api: runtime };
}

async function settled(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
}

describe("IM receiver local HTTP/WebSocket integration", () => {
  it("does not start IM transports, notifications or lifecycle listeners for the community product", async () => {
    vi.stubEnv("NUWAX_APP_IDENTIFIER", "nuwaclaw");
    const backend = await localBackend();
    const { api } = await start(backend);
    await settled();
    expect(api.getIMUnreadSnapshot()).toBeNull();
    expect(backend.requests).toHaveLength(0);
    expect(backend.connections).toHaveLength(0);
    expect(mocks.nativeOptions).toBeNull();
    expect(mocks.appEvents?.listenerCount("browser-window-focus")).toBe(0);
    expect(mocks.powerEvents?.listenerCount("lock-screen")).toBe(0);
  });

  it("registers a separate device, authenticates im-v1 with Cookie, and pushes long-ID events into unread HTTP and badges", async () => {
    const backend = await localBackend();
    const { business, external, api } = await start(backend);
    const unread = vi.fn();
    const offUnread = api.onIMUnreadChanged(unread);
    await vi.waitFor(() => expect(mocks.native.setUnreadCount).toHaveBeenCalledWith(11), { timeout: 2500 });
    expect(unread).toHaveBeenLastCalledWith(expect.objectContaining({total: 9, dndTotal: 2}));
    expect(backend.requests.find((request) => request.path.endsWith("/devices"))?.body).toEqual({
      deviceId: "machine-123#im-native", platform: "desktop", pushEnabled: false, appVersion: "1.2.3",
    });
    expect(backend.connections).toHaveLength(1);
    expect(backend.connections[0]["sec-websocket-protocol"]).toBe("im-v1");
    expect(backend.connections[0].cookie).toBe("ticket=synthetic-im-ticket");
    expect(backend.connections[0]["x-client-type"]).toBe("nuwax");
    expect(backend.connections[0]["x-nuwax-native-ticket"]).toBeUndefined();
    expect(backend.requests.every((request) => request.headers.cookie === "ticket=synthetic-im-ticket"
      && request.headers["x-nuwax-native-ticket"] === undefined)).toBe(true);
    expect(mocks.fetch.mock.calls[0][1]).toMatchObject({ credentials: "omit", redirect: "error", method: "POST" });
    expect(mocks.fetch.mock.calls[0][1].headers["x-nuwax-native-ticket"]).toEqual(expect.any(String));
    expect(backend.packets[0]).toMatchObject({ op: 1000, body: { deviceId: "machine-123#im-native", lastAckSeq: 0 } });
    expect(business.send).not.toHaveBeenCalled();
    expect(external.send).not.toHaveBeenCalled();
    const previous = api.getIMUnreadSnapshot()!;
    backend.state.unread = { total: 2, dndTotal: 1 };
    backend.sendMessage();
    await vi.waitFor(() => expect(mocks.native.showMessage).toHaveBeenCalledWith(expect.objectContaining({
      convId: CONV_ID, msgId: MSG_ID, title: "Team", body: "Hello team",
    })), { timeout: 2500 });
    await vi.waitFor(() => expect(api.getIMUnreadSnapshot()?.total).toBe(2), { timeout: 2500 });
    expect(api.getIMUnreadSnapshot()!.revision).toBeGreaterThan(previous.revision);
    expect(mocks.native.setUnreadCount).toHaveBeenLastCalledWith(3);
    expect(unread).toHaveBeenLastCalledWith(api.getIMUnreadSnapshot());
    expect(backend.requests.some((request) => request.path === `/api/instant-message/conversations/${CONV_ID}`)).toBe(true);
    expect(backend.packets.every((packet) => [1000, 2000].includes(packet.op))).toBe(true);
    expect(backend.requests.some((request) => /\/(ack|read|messages)$/.test(request.path))).toBe(false);
    api.stopIMReceiver();
    expect(unread).toHaveBeenLastCalledWith(expect.objectContaining({total: 0, dndTotal: 0}));
    offUnread();
    unread.mockClear();
    api.stopIMReceiver();
    expect(unread).not.toHaveBeenCalled();
  });

  it("rechecks DND from conversation details, lets @self/@all through, and ignores own long-ID messages", async () => {
    const backend = await localBackend();
    backend.state.conversation.dnd = true;
    await start(backend);
    await vi.waitFor(() => expect(mocks.native.setUnreadCount).toHaveBeenCalledWith(11));
    backend.sendMessage("9223372036854775800");
    await vi.waitFor(() => expect(backend.requests.filter((request) => request.path.includes("/conversations/"))).toHaveLength(1));
    await settled();
    expect(mocks.native.showMessage).not.toHaveBeenCalled();
    backend.sendMessage("9223372036854775801", `,"mentionUserIds":[${SELF_ID}]`);
    await vi.waitFor(() => expect(mocks.native.showMessage).toHaveBeenCalledTimes(1));
    backend.sendMessage("9223372036854775802", ',"mentionAll":true');
    await vi.waitFor(() => expect(mocks.native.showMessage).toHaveBeenCalledTimes(2));
    backend.sendMessage("9223372036854775803", ',"mentionAll":true', SELF_ID);
    await settled();
    expect(backend.requests.filter((request) => request.path.includes("/conversations/"))).toHaveLength(3);
    expect(mocks.native.showMessage).toHaveBeenCalledTimes(2);
    runtime!.setIMNotificationEnabled(false);
    backend.sendMessage("9223372036854775804", ',"mentionAll":true');
    await settled();
    expect(mocks.writeSetting).toHaveBeenCalledWith("nuwax.im.notifications.enabled", false);
    expect(backend.requests.filter((request) => request.path.includes("/conversations/"))).toHaveLength(3);
  });

  it("keeps unread in foreground, cancels pending notifications on lock/suspend, and reconnects without replay", async () => {
    const backend = await localBackend();
    const { main, api } = await start(backend);
    main.isFocused.mockReturnValue(true);
    await vi.waitFor(() => expect(mocks.native.setUnreadCount).toHaveBeenCalledWith(11));
    backend.sendMessage();
    await settled();
    expect(mocks.native.showMessage).not.toHaveBeenCalled();
    expect(backend.requests.filter((request) => request.path.includes("/conversations/"))).toHaveLength(0);
    main.isFocused.mockReturnValue(false);
    for (const [pause, resume, msgId] of [
      ["lock-screen", "unlock-screen", "9223372036854775800"],
      ["suspend", "resume", "9223372036854775801"],
    ]) {
      let held: ServerResponse | null = null;
      backend.state.conversationHandler = (response) => { held = response; };
      backend.sendMessage(msgId);
      await vi.waitFor(() => expect(held).not.toBeNull());
      const previousConnections = backend.connections.length;
      mocks.powerEvents!.emit(pause);
      await vi.waitFor(() => expect(backend.sockets.filter((socket) => socket.readyState === WebSocket.OPEN)).toHaveLength(0));
      const countBefore = mocks.fetch.mock.calls.length;
      reply(held!, { dnd: false, convType: 2, name: "Paused message" });
      await settled();
      expect(mocks.native.showMessage).not.toHaveBeenCalled();
      expect(mocks.fetch).toHaveBeenCalledTimes(countBefore);
      expect(api.getIMUnreadSnapshot()?.total).toBe(9);
      backend.state.conversationHandler = null;
      mocks.powerEvents!.emit(resume);
      await vi.waitFor(() => expect(backend.connections).toHaveLength(previousConnections + 1));
      await vi.waitFor(() => expect(mocks.info).toHaveBeenLastCalledWith("[IMReceiver] state", { state: "connected" }));
    }
    expect(backend.requests.filter((request) => request.path.endsWith("/devices"))).toHaveLength(1);
    backend.sendMessage("9223372036854775805");
    await vi.waitFor(() => expect(mocks.native.showMessage).toHaveBeenCalledTimes(1));
  });

  it("ignores a real late unread response after stop even when the transport cannot abort", async () => {
    const backend = await localBackend();
    let held: ServerResponse | null = null;
    backend.state.unreadHandler = (response) => { held = response; };
    mocks.ignoreAbortPath = "/api/instant-message/unread-total";
    const { api } = await start(backend);
    await vi.waitFor(() => expect(held).not.toBeNull());
    const generation = api.getIMUnreadSnapshot()!.sessionGeneration;
    api.stopIMReceiver();
    const stopped = api.getIMUnreadSnapshot();
    expect(stopped).toMatchObject({ total: 0, dndTotal: 0 });
    expect(stopped!.sessionGeneration).toBeGreaterThan(generation);
    const request = mocks.fetch.mock.calls.find(([url]) => url.endsWith("/unread-total"))!;
    expect(request[1].signal.aborted).toBe(true);
    reply(held!, { total: 77, dndTotal: 1 });
    await settled();
    expect(api.getIMUnreadSnapshot()).toEqual(stopped);
    expect(mocks.native.setUnreadCount).toHaveBeenLastCalledWith(0);
    expect(mocks.native.setUnreadCount).not.toHaveBeenCalledWith(78);
  });

  it.each(["auth", "quota"])("halts automatic reconnection for %s rejection and allows explicit retry", async (reason) => {
    const backend = await localBackend();
    if (reason === "auth") backend.state.registerReject = { code: "IM_10401", status: 401 };
    else backend.state.connectReject = "IM_10429";
    const { api } = await start(backend);
    await vi.waitFor(() => expect(mocks.warn).toHaveBeenCalledWith("[IMReceiver] connection blocked", { reason: reason === "auth" ? "IM_10401" : "IM_10429" }));
    const requests = backend.requests.length;
    const connections = backend.connections.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 1100));
    expect(backend.requests).toHaveLength(requests);
    expect(backend.connections).toHaveLength(connections);
    backend.state.registerReject = null;
    backend.state.connectReject = null;
    api.retryIMReceiver();
    await vi.waitFor(() => expect(mocks.native.setUnreadCount).toHaveBeenCalledWith(11));
    expect(backend.connections).toHaveLength(connections + 1);
  });

  it.each([401, 403])("blocks an upstream non-JSON HTTP %s auth failure", async status => {
    const backend = await localBackend();
    backend.state.registerReject = { code: "", status, rawBody: "<html>Login required</html>" };
    const { api } = await start(backend);
    await vi.waitFor(() => expect(mocks.warn).toHaveBeenCalledWith("[IMReceiver] connection blocked", {
      reason: status === 401 ? "IM_10401" : "IM_10403",
    }));
    expect(backend.connections).toHaveLength(0);
    expect(api.getIMUnreadSnapshot()).toMatchObject({ total: 0, dndTotal: 0 });
  });

  it("does not stop a new account when an older WS Cookie mirror rejects late", async () => {
    const backend = await localBackend();
    backend.state.upgradeCookie = "ticket=synthetic-upgrade-ticket; Path=/";
    let rejectOld!: (error: Error) => void;
    const oldMirror = new Promise<void>((_resolve, reject) => { rejectOld = reject; });
    mocks.mirrorUpgrade.mockImplementationOnce(() => oldMirror);
    const { api } = await start(backend);
    await vi.waitFor(() => expect(mocks.native.setUnreadCount).toHaveBeenCalledWith(11));
    expect(mocks.mirrorUpgrade).toHaveBeenCalledTimes(1);
    api.stopIMReceiver();
    mocks.epoch++;
    mocks.ticket = "synthetic-account-two-ticket";
    backend.state.unread = { total: 12, dndTotal: 1 };
    api.startIMReceiver("account-2");
    await vi.waitFor(() => expect(mocks.native.setUnreadCount).toHaveBeenLastCalledWith(13));
    const next = api.getIMUnreadSnapshot();
    rejectOld(new Error("Old Cookie write rejected"));
    await settled();
    expect(api.getIMUnreadSnapshot()).toEqual(next);
    expect(mocks.native.setUnreadCount).toHaveBeenLastCalledWith(13);
    expect(backend.sockets.filter(socket => socket.readyState === WebSocket.OPEN)).toHaveLength(1);
  });

  it("invalidates notification callbacks at account boundaries and removes all runtime listeners on quit", async () => {
    const backend = await localBackend();
    const { business, api } = await start(backend);
    await vi.waitFor(() => expect(mocks.native.setUnreadCount).toHaveBeenCalledWith(11));
    const generation = api.getIMUnreadSnapshot()!.sessionGeneration;
    expect(mocks.nativeOptions!.isSessionCurrent(generation)).toBe(true);
    api.stopIMReceiver();
    business.emit("did-finish-load");
    expect(mocks.hostCommand).not.toHaveBeenCalled();
    expect(mocks.nativeOptions!.isSessionCurrent(generation)).toBe(false);
    api.startIMReceiver("account-2");
    business.emit("did-finish-load");
    expect(mocks.hostCommand).not.toHaveBeenCalled();
    api.disposeIMReceiver();
    expect(business.listenerCount("did-finish-load")).toBe(0);
    expect(mocks.powerEvents!.eventNames()).toEqual([]);
    expect(mocks.appEvents!.eventNames()).toEqual([]);
  });
});
