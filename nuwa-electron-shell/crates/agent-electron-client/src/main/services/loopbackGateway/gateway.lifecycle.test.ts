import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import log from "electron-log";

vi.mock("electron-log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { startLoopbackGateway, type LoopbackGatewayHandle } from "./gateway";
import { GATEWAY_REQUEST_HEADER } from "./requestContext";

const servers: http.Server[] = [];
const sockets = new Set<net.Socket>();
const gateways: LoopbackGatewayHandle[] = [];

function track(socket: net.Socket): void {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  socket.on("error", () => undefined);
  // 临时 WS 端点也在传输层 FIN 时收尾，模拟真实 WS 实现的连接清理。
  socket.on("end", () => socket.destroy());
}

async function upstream(onUpgrade?: (socket: net.Socket) => void) {
  const server = http.createServer((_req, res) => res.end("OK"));
  servers.push(server);
  server.on("connection", track);
  server.on("upgrade", (_req, socket) => {
    const connection = socket as net.Socket;
    onUpgrade?.(connection);
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n",
    );
    socket.on("data", (chunk) => socket.write(chunk));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
}

async function gateway(targetOrigin: string) {
  const handle = await startLoopbackGateway({ targetOrigin, fixedPort: 0, getTicket: () => null });
  gateways.push(handle);
  return handle;
}

async function websocket(port: number) {
  const socket = net.connect(port, "127.0.0.1");
  track(socket);
  socket.write(
    `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
  );
  const [head] = await once(socket, "data");
  expect(String(head)).toContain("101 Switching Protocols");
  return socket;
}

async function finishesWithin(promise: Promise<unknown>, ms = 500): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

afterEach(async () => {
  // 失败回归也先回收测试自己的 socket，避免旧实现的 close 卡住测试清理。
  for (const socket of sockets) socket.destroy();
  for (const handle of gateways.splice(0)) await handle.close();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("gateway instance shutdown", () => {
  it("关闭持续 WS 时客户端和上游均结束，重复 close 共用同一收尾", async () => {
    let upstreamSocket!: net.Socket;
    const origin = await upstream((socket) => { upstreamSocket = socket; });
    const handle = await gateway(origin);
    const client = await websocket(handle.port);
    const clientClosed = once(client, "close");
    const upstreamClosed = once(upstreamSocket, "close");
    const closing = handle.close();
    expect(handle.close()).toBe(closing);
    expect(await finishesWithin(Promise.all([closing, clientClosed, upstreamClosed]))).toBe(true);
    expect(client.destroyed).toBe(true);
    expect(upstreamSocket.destroyed).toBe(true);
  });

  it("一实例关闭不影响另一实例的 WS 和正常透传", async () => {
    const origin = await upstream();
    const first = await gateway(origin);
    const second = await gateway(origin);
    await websocket(first.port);
    const survivor = await websocket(second.port);
    expect(await finishesWithin(first.close())).toBe(true);
    const echoed = once(survivor, "data");
    survivor.write("still-running");
    expect(String((await echoed)[0])).toBe("still-running");
    expect(survivor.destroyed).toBe(false);
    expect(await (await fetch(second.origin)).text()).toBe("OK");
  });

  it("101 前停止也回收尚未完成的升级请求", async () => {
    let connected!: () => void;
    const received = new Promise<void>((resolve) => { connected = resolve; });
    let upstreamSocket!: net.Socket;
    const server = http.createServer();
    servers.push(server);
    server.on("connection", track);
    server.on("upgrade", (_req, socket) => {
      upstreamSocket = socket as net.Socket;
      connected(); // 上游一直不返回 101。
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const handle = await gateway(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`);
    const client = net.connect(handle.port, "127.0.0.1");
    track(client);
    client.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${handle.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
    await received;
    const closed = Promise.all([once(client, "close"), once(upstreamSocket, "close")]);
    expect(await finishesWithin(Promise.all([handle.close(), closed]))).toBe(true);
  });

  it("101 已到但 cookie 镜像仍在等待时停止，两端回收且迟到镜像不复活连接", async () => {
    let entered!: () => void;
    const mirroring = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const mirror = new Promise<void>((resolve) => { release = resolve; });
    let remote!: net.Socket;
    const server = http.createServer();
    servers.push(server);
    server.on("connection", track);
    server.on("upgrade", (_req, socket) => {
      remote = socket as net.Socket;
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Set-Cookie: ticket=test; Path=/; HttpOnly\r\n\r\n",
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const handle = await startLoopbackGateway({
      targetOrigin: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
      fixedPort: 0,
      getTicket: () => null,
      trustedRequestSecret: "test-mirror-capability",
      onSetCookie: () => { entered(); return mirror; },
    });
    gateways.push(handle);
    const client = net.connect(handle.port, "127.0.0.1");
    track(client);
    client.write(
      `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${handle.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `${GATEWAY_REQUEST_HEADER}: test-mirror-capability\r\n\r\n`,
    );
    await mirroring;
    try {
      const closed = Promise.all([once(client, "close"), once(remote, "close")]);
      expect(await finishesWithin(Promise.all([handle.close(), closed]))).toBe(true);
    } finally {
      release();
    }
    await Promise.resolve();
    expect(client.destroyed).toBe(true);
    expect(remote.destroyed).toBe(true);
  });

  it("close 回调缺失时实际 deadline 结束等待，生命周期队列可继续", async () => {
    const handle = await gateway(await upstream());
    const nativeClose = http.Server.prototype.close;
    // 真实监听先关闭，只抑制完成通知，验证 deadline 覆盖 close 回调的等待本身。
    const suppressCallback = vi.spyOn(http.Server.prototype, "close").mockImplementationOnce(
      function (this: http.Server) { return nativeClose.call(this); },
    );
    try {
      expect(await finishesWithin(handle.close(), 2000)).toBe(true);
      expect(log.warn).toHaveBeenCalledWith(
        "[LoopbackGateway] close deadline reached; destroying owned connections",
      );
    } finally {
      suppressCallback.mockRestore();
    }
  });
});
