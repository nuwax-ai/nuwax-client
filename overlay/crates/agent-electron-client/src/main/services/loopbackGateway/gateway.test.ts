/**
 * 单元测试: Loopback Gateway（全站透明反代核心）
 *
 * 覆盖（断言口径移植自 nuwax-desktop 原型的离线验证）:
 * 1. 透明透传：方法/路径/请求体/SSE 流式
 * 2. Bearer 代注：缺失补、已有不覆盖
 * 3. x-client-type 注入与关闭
 * 4. Set-Cookie 规整：剥 Domain/Secure、SameSite=None→Lax
 * 5. WS 101 透传 + close 级联销毁；上游拒绝升级回写状态码
 * 6. host/origin/referer 改写指向目标
 * 7. 固定端口被占用回退随机端口
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("electron-log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { startLoopbackGateway } from "./gateway";
import { APP_NAME_IDENTIFIER } from "@shared/constants";
import { GATEWAY_REQUEST_HEADER } from "./requestContext";

const openServers: (http.Server | net.Server)[] = [];

/** 起一个回显上游：记录收到的请求，按 route 回应；跟踪底层连接防 close 挂起。 */
function startUpstream(
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    captured: Record<string, unknown>,
  ) => void,
): Promise<{
  server: http.Server;
  origin: string;
  captured: Record<string, unknown>;
}> {
  const captured: Record<string, unknown> = {};
  const server = http.createServer((req, res) => handler(req, res, captured));
  const conns = new Set<net.Socket>();
  server.on("connection", (sock: net.Socket) => {
    conns.add(sock);
    sock.on("close", () => conns.delete(sock));
  });
  (server as unknown as { __conns: Set<net.Socket> }).__conns = conns;
  openServers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, origin: `http://127.0.0.1:${addr.port}`, captured });
    });
  });
}

/** 简易 WS 客户端：完成握手并收发原始帧。 */
function wsHandshake(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ sock: net.Socket; statusLine: string; responseHeaders: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    const key = "dGhlIHNhbXBsZSBub25jZQ==";
    sock.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
        Object.entries(headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n") +
        "\r\n\r\n",
    );
    let buf = "";
    const timer = setTimeout(
      () => reject(new Error("ws handshake timeout")),
      3000,
    );
    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString("latin1");
      const idx = buf.indexOf("\r\n\r\n");
      if (idx === -1) return;
      clearTimeout(timer);
      resolve({
        sock,
        statusLine: buf.slice(0, buf.indexOf("\r\n")),
        responseHeaders: buf.slice(0, idx),
      });
    });
    sock.on("error", reject);
  });
}

const gateways: { close(): Promise<void> }[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const g of gateways.splice(0)) await g.close();
  for (const s of openServers.splice(0)) {
    // WS 升级产生的裸 socket 不归 http server close 管：显式销毁防挂起
    const conns = (s as unknown as { __conns?: Set<net.Socket> }).__conns;
    conns?.forEach((sock) => sock.destroy());
    await new Promise<void>((d) => s.close(() => d()));
  }
  for (const directory of temporaryDirectories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("loopback gateway（透明反代）", () => {
  it("permits opaque CORS only with the private namespace capability and never sends it upstream", async () => {
    const up = await startUpstream((req, res, cap) => {
      cap.privateHeader = req.headers[GATEWAY_REQUEST_HEADER];
      res.setHeader(
        "access-control-allow-origin",
        req.headers.origin ?? "https://other.example",
      );
      res.end("OK");
    });
    const secret = "test-instance-capability";
    const gw = await startLoopbackGateway({
      targetOrigin: up.origin,
      getAccessToken: () => null,
      trustedRequestSecret: secret,
      fixedPort: 0,
    });
    gateways.push(gw);
    const namespace = `/__backend/${new URL(up.origin).host}/files/a`;
    for (const supplied of [undefined, "forged", secret]) {
      const response = await fetch(gw.origin + namespace, {
        headers: {
          origin: "null",
          ...(supplied ? { [GATEWAY_REQUEST_HEADER]: supplied } : {}),
        },
      });
      expect(response.headers.get("access-control-allow-origin")).toBe(
        supplied === secret ? "null" : up.origin,
      );
      expect(response.headers.get(GATEWAY_REQUEST_HEADER)).toBeNull();
      expect(up.captured.privateHeader).toBeUndefined();
      if (supplied === secret) {
        expect(response.headers.get("access-control-allow-credentials")).toBe(
          "true",
        );
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
    }
    for (const [route, origin] of [
      ["/api/me", "null"],
      [namespace, "https://foreign.example"],
    ]) {
      const response = await fetch(gw.origin + route, {
        headers: { origin, [GATEWAY_REQUEST_HEADER]: secret },
      });
      expect(response.headers.get("access-control-allow-origin")).toBe(
        up.origin,
      );
      expect(up.captured.privateHeader).toBeUndefined();
    }
  });

  it("translates backend CORS only for the gateway's exact bound Origin", async () => {
    const up = await startUpstream((req, res) => {
      res.setHeader(
        "access-control-allow-origin",
        req.headers.origin ?? "https://other.example",
      );
      res.setHeader("access-control-allow-credentials", "true");
      res.setHeader("vary", "Accept-Encoding");
      res.end("OK");
    });
    const gw = await startLoopbackGateway({
      targetOrigin: up.origin,
      getAccessToken: () => null,
      fixedPort: 0,
    });
    gateways.push(gw);
    const url = `${gw.origin}/__backend/${new URL(up.origin).host}/files/a`;
    const trusted = await fetch(url, { headers: { origin: gw.origin } });
    expect(trusted.headers.get("access-control-allow-origin")).toBe(gw.origin);
    expect(trusted.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );
    expect(trusted.headers.get("vary")).toBe("Accept-Encoding, Origin");
    const foreign = await fetch(url, {
      headers: { origin: "https://foreign.example" },
    });
    expect(foreign.headers.get("access-control-allow-origin")).toBe(up.origin);
    expect(foreign.headers.get("vary")).toBe("Accept-Encoding");
  });

  it("strips only ticket with or without explicit Authorization and exempts public auth routes", async () => {
    const up = await startUpstream((req, res, cap) => {
      cap.cookie = req.headers.cookie;
      cap.auth = req.headers.authorization;
      res.writeHead(204).end();
    });
    const gw = await startLoopbackGateway({
      targetOrigin: up.origin,
      getAccessToken: () => "CURRENT",
      fixedPort: 0,
    });
    gateways.push(gw);
    for (const authorization of [undefined, "Bearer EXPLICIT"]) {
      await fetch(`${gw.origin}/api/me`, {
        headers: {
          cookie: "a=1; ticket=OLD; b=2",
          ...(authorization ? { authorization } : {}),
        },
      });
      expect(up.captured.cookie).toBe("a=1; b=2");
      expect(up.captured.auth).toBe(authorization ?? "Bearer CURRENT");
    }
    for (const route of [
      "/api/user/passwordLogin",
      "/api/user/codeLogin",
      "/api/user/code/send",
    ]) {
      for (const prefix of ["", `/__backend/${new URL(up.origin).host}`]) {
        await fetch(`${gw.origin}${prefix}${route}?x=1`, {
          headers: { cookie: "ticket=OLD" },
        });
        expect(up.captured.cookie).toBeUndefined();
        expect(up.captured.auth).toBeUndefined();
      }
    }
  });

  it("routes namespace before local assets/SPA, preserves query and restores upstream referer", async () => {
    const up = await startUpstream((req, res, cap) => {
      cap.path = req.url;
      cap.referer = req.headers.referer;
      res.end("BACKEND");
    });
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-ns-"));
    temporaryDirectories.push(distDir);
    fs.writeFileSync(path.join(distDir, "index.html"), "LOCAL SPA");
    const gw = await startLoopbackGateway({
      targetOrigin: up.origin,
      distDir,
      getAccessToken: () => "CURRENT",
      fixedPort: 0,
    });
    gateways.push(gw);
    const namespace = `/__backend/${new URL(up.origin).host}`;
    for (const path of ["/asset.png", "/new-api/record?q=%2F&x=2"]) {
      const response = await fetch(`${gw.origin}${namespace}${path}`, {
        headers: { referer: `${gw.origin}${namespace}/repo/doc/7?x=1` },
      });
      expect(await response.text()).toBe("BACKEND");
      expect(up.captured.path).toBe(path);
      expect(up.captured.referer).toBe(`${up.origin}/repo/doc/7?x=1`);
    }
    for (const route of [
      "/__backend",
      "/__backend/evil.example/a",
      "/__backend/127.0.0.1%3A123/a",
      "/__backend/127.0.0.1@evil.example/a",
    ]) {
      expect((await fetch(gw.origin + route)).status).toBe(403);
    }
    expect(await (await fetch(`${gw.origin}/home/chat/7`)).text()).toBe(
      "LOCAL SPA",
    );
  });

  it("keeps namespaced resource redirects in the gateway and leaves external locations intact", async () => {
    const up = await startUpstream((req, res) => {
      if (req.url === "/assets/start")
        res.writeHead(302, { location: "/final?q=%2F" }).end();
      else if (req.url === "/external")
        res.writeHead(302, { location: "https://cdn.example/a" }).end();
      else res.end(req.url);
    });
    const gw = await startLoopbackGateway({
      targetOrigin: up.origin,
      getAccessToken: () => null,
      fixedPort: 0,
    });
    gateways.push(gw);
    const namespace = `/__backend/${new URL(up.origin).host}`;
    const first = await fetch(`${gw.origin}${namespace}/assets/start`, {
      redirect: "manual",
    });
    expect(first.headers.get("location")).toBe(`${namespace}/final?q=%2F`);
    expect(
      await (await fetch(`${gw.origin}${namespace}/assets/start`)).text(),
    ).toBe("/final?q=%2F");
    const external = await fetch(`${gw.origin}${namespace}/external`, {
      redirect: "manual",
    });
    expect(external.headers.get("location")).toBe("https://cdn.example/a");
  });

  it("uses the same namespace whitelist, path and cookie rules for WS upgrade", async () => {
    const up = await startUpstream((_req, res) => res.writeHead(404).end());
    up.server.on("upgrade", (req, socket) => {
      up.captured.path = req.url;
      up.captured.cookie = req.headers.cookie;
      up.captured.auth = req.headers.authorization;
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
    });
    const gw = await startLoopbackGateway({
      targetOrigin: up.origin,
      getAccessToken: () => "CURRENT",
      fixedPort: 0,
    });
    gateways.push(gw);
    const handshake = await wsHandshake(
      gw.port,
      `/__backend/${new URL(up.origin).host}/socket?q=%2F`,
      { Cookie: "ticket=OLD; a=1", Authorization: "Bearer EXPLICIT" },
    );
    expect(handshake.statusLine).toContain("401");
    handshake.sock.destroy();
    expect(up.captured).toMatchObject({
      path: "/socket?q=%2F",
      cookie: "a=1",
      auth: "Bearer EXPLICIT",
    });
    const blocked = await wsHandshake(
      gw.port,
      "/__backend/evil.example/socket",
    );
    expect(blocked.statusLine).toContain("403");
    blocked.sock.destroy();
  });

  it("全站透传：方法/路径/请求体原样到达上游", async () => {
    const up = await startUpstream((req, res, cap) => {
      cap.method = req.method;
      cap.url = req.url;
      cap.host = req.headers.host;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        cap.body = Buffer.concat(chunks).toString();
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("pong");
      });
    });
    const gw = await startLoopbackGateway({
      targetOrigin: up.origin,
      getAccessToken: () => null,
      clientTypeHeader: "",
    });
    gateways.push(gw);
    const resp = await fetch(`${gw.origin}/api/ping?q=1`, {
      method: "POST",
      body: "ping",
    });
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("pong");
    expect(up.captured.method).toBe("POST");
    expect(up.captured.url).toBe("/api/ping?q=1");
    expect(up.captured.body).toBe("ping");
  });

  it("host/origin/referer 改写指向目标", async () => {
    const up = await startUpstream((req, res, cap) => {
      cap.origin = req.headers.origin;
      cap.referer = req.headers.referer;
      res.writeHead(204).end();
    });
    const gw = await startLoopbackGateway({
      targetOrigin: up.origin,
      getAccessToken: () => null,
      clientTypeHeader: "",
    });
    gateways.push(gw);
    await fetch(`${gw.origin}/x`, {
      headers: { origin: gw.origin, referer: `${gw.origin}/y` },
    });
    expect(up.captured.origin).toBe(up.origin);
    expect(up.captured.referer).toBe(`${up.origin}/y`);
  });

  it("Bearer 代注：缺失补、已有不覆盖", async () => {
    const up = await startUpstream((req, res, cap) => {
      cap.auth = req.headers.authorization;
      res.writeHead(204).end();
    });
    const gw = await startLoopbackGateway({
      targetOrigin: up.origin,
      getAccessToken: () => "TOKEN-A",
      clientTypeHeader: "",
    });
    gateways.push(gw);
    await fetch(`${gw.origin}/a`);
    expect(up.captured.auth).toBe("Bearer TOKEN-A");
    await fetch(`${gw.origin}/b`, {
      headers: { authorization: "Bearer SELF" },
    });
    expect(up.captured.auth).toBe("Bearer SELF");
  });

  it("x-client-type：缺省随产品标识 APP_NAME_IDENTIFIER，空串关闭", async () => {
    // ubuntu CI 两次在无 body 的 204 往返中出现 UND_ERR_SOCKET（响应读到一半
    // socket 被毁，34676294850 / 34678353803）。归因：fetch 默认 keep-alive 池化
    // 与刚 listen 完成的新网关在慢 runner 上的拆除竞态。处置：本用例请求显式
    // connection: close（响应头断言不受影响——该头本就是 hop-by-hop），并对
    // 网络瞬断重试一次；确定性回归不受重试掩护。
    const fetchNoKeepAlive = async (url: string) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await fetch(url, { headers: { connection: "close" } });
        } catch (e) {
          if (attempt === 0 && (e as Error)?.name === "TypeError") continue;
          throw e;
        }
      }
    };
    const up = await startUpstream((req, res, cap) => {
      cap.xct = req.headers["x-client-type"];
      res.writeHead(204).end();
    });
    const gw1 = await startLoopbackGateway({
      targetOrigin: up.origin,
      getAccessToken: () => null,
    });
    gateways.push(gw1);
    await fetchNoKeepAlive(`${gw1.origin}/a`);
    // 测试环境未注入 NUWAX_APP_IDENTIFIER → 社区版缺省 nuwaclaw；
    // 商业版构建（identifier=nuwax）时该头值随 define 联动，无需改本测试
    expect(up.captured.xct).toBe(APP_NAME_IDENTIFIER);

    const gw2 = await startLoopbackGateway({
      targetOrigin: up.origin,
      getAccessToken: () => null,
      clientTypeHeader: "",
    });
    gateways.push(gw2);
    await fetchNoKeepAlive(`${gw2.origin}/b`);
    expect(up.captured.xct).toBeUndefined();
  });

  it("Set-Cookie 规整：剥 Domain/Secure、SameSite=None→Lax", async () => {
    const up = await startUpstream((_req, res) => {
      res.writeHead(200, {
        "set-cookie": [
          "a=1; Domain=agent.nuwax.com; Secure; SameSite=None; Path=/",
          "b=2; HttpOnly; Path=/",
        ],
      });
      res.end();
    });
    const gw = await startLoopbackGateway({
      targetOrigin: up.origin,
      getAccessToken: () => null,
      clientTypeHeader: "",
    });
    gateways.push(gw);
    const resp = await fetch(`${gw.origin}/c`);
    const cookies = resp.headers.getSetCookie();
    expect(cookies[0]).toBe("a=1; SameSite=Lax; Path=/");
    expect(cookies[1]).toBe("b=2; HttpOnly; Path=/");
  });

  it("SSE 流式直通（分块到即转发，不缓冲）", async () => {
    const up = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: 1\n\n");
      setTimeout(() => {
        res.write("data: 2\n\n");
        res.end();
      }, 60);
    });
    const gw = await startLoopbackGateway({
      targetOrigin: up.origin,
      getAccessToken: () => null,
      clientTypeHeader: "",
    });
    gateways.push(gw);
    const resp = await fetch(`${gw.origin}/sse`);
    expect(resp.headers.get("content-type")).toBe("text/event-stream");
    const first = await resp.body!.getReader().read();
    expect(new TextDecoder().decode(first.value)).toContain("data: 1");
  });

  it("WS 101 透传 + close 级联：客户端断开后上游连接随之关闭", async () => {
    let upstreamClosed = false;
    const up = await startUpstream(() => undefined);
    up.server.on("upgrade", (_req, socket) => {
      // 客户端断开 → 网关级联 destroy 上游连接：表现为 end（优雅 FIN）或 close（RST）
      socket.on("close", () => {
        upstreamClosed = true;
      });
      socket.on("end", () => {
        upstreamClosed = true;
      });
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n",
      );
      socket.on("data", () => socket.write("echo"));
    });
    const gw = await startLoopbackGateway({
      targetOrigin: up.origin,
      getAccessToken: () => null,
      clientTypeHeader: "",
    });
    gateways.push(gw);
    const { sock, statusLine } = await wsHandshake(gw.port, "/ws");
    expect(statusLine).toContain("101");
    // 模拟浏览器中断查看器（abortive close，非优雅 end）：级联销毁上游
    sock.destroy();
    await new Promise((r) => setTimeout(r, 150));
    expect(upstreamClosed).toBe(true);
  });

  it("上游拒绝升级：回写真实状态码", async () => {
    const up = await startUpstream(() => undefined);
    up.server.on("upgrade", (_req, socket) => {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    });
    const gw = await startLoopbackGateway({
      targetOrigin: up.origin,
      getAccessToken: () => null,
      clientTypeHeader: "",
    });
    gateways.push(gw);
    const { statusLine } = await wsHandshake(gw.port, "/ws-denied");
    expect(statusLine).toContain("401");
  });

  it("固定端口被占用：回退随机端口", async () => {
    const up = await startUpstream((_req, res) => {
      res.writeHead(204).end();
    });
    const gw1 = await startLoopbackGateway({
      targetOrigin: up.origin,
      fixedPort: 0, // 让系统随机分配一个作为「被占用」的固定口
      getAccessToken: () => null,
      clientTypeHeader: "",
    });
    gateways.push(gw1);
    const gw2 = await startLoopbackGateway({
      targetOrigin: up.origin,
      fixedPort: gw1.port,
      getAccessToken: () => null,
      clientTypeHeader: "",
    });
    gateways.push(gw2);
    expect(gw2.port).not.toBe(gw1.port);
    expect(gw2.port).toBeGreaterThan(0);
  });

  it("dist 模式：本地静态托管 + SPA 回退 + 后端前缀反代", async () => {
    const up = await startUpstream((req, res, cap) => {
      cap.apiPath = req.url;
      cap.auth = req.headers.authorization;
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"code":0}');
    });
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-dist-"));
    fs.writeFileSync(path.join(distDir, "index.html"), "<html>HOME</html>");
    fs.mkdirSync(path.join(distDir, "static"));
    fs.writeFileSync(
      path.join(distDir, "static", "a.880437de.js"),
      "console.log(1)",
    );
    const gw = await startLoopbackGateway({
      targetOrigin: up.origin,
      distDir,
      getAccessToken: () => "TK",
      clientTypeHeader: "nuwaclaw",
    });
    gateways.push(gw);
    expect(gw.mode).toBe("dist");
    // 静态：首页 no-cache；带 hash 资源长缓存
    const home = await fetch(`${gw.origin}/`);
    expect(await home.text()).toContain("HOME");
    expect(home.headers.get("cache-control")).toBe("no-cache");
    const asset = await fetch(`${gw.origin}/static/a.880437de.js`);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    // SPA 深链回 index.html；带扩展名未命中 404
    const deep = await fetch(`${gw.origin}/home/chat/1/2`);
    expect(await deep.text()).toContain("HOME");
    const missing = await fetch(`${gw.origin}/nope.xyz`);
    expect(missing.status).toBe(404);
    // 后端前缀反代：/api 与 /computer 走上游并注入 Bearer
    const api = await fetch(`${gw.origin}/api/user/info`);
    expect(await api.json()).toEqual({ code: 0 });
    expect(up.captured.apiPath).toBe("/api/user/info");
    expect(up.captured.auth).toBe("Bearer TK");
    await fetch(`${gw.origin}/computer/terminal/x/ws`);
    expect(up.captured.apiPath).toBe("/computer/terminal/x/ws");
    // 路径穿越拒绝
    const escape = await fetch(`${gw.origin}/..%2f..%2fetc%2fpasswd`);
    expect([403, 404]).toContain(escape.status);
    fs.rmSync(distDir, { recursive: true, force: true });
  });

  it("dist 模式自定义 backendPrefixes：外链菜单微应用前缀反代，前缀按段匹配", async () => {
    const up = await startUpstream((req, res, cap) => {
      cap.microPath = req.url;
      cap.auth = req.headers.authorization;
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>REPO-WEB</html>");
    });
    const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-dist-"));
    fs.writeFileSync(path.join(distDir, "index.html"), "<html>HOME</html>");
    const gw = await startLoopbackGateway({
      targetOrigin: up.origin,
      distDir,
      // 传入即整体替换：编排层（index.ts）负责把缺省三前缀一并带上
      backendPrefixes: ["/api", "/computer", "/devcomputer", "/repo"],
      getAccessToken: () => "TK",
      clientTypeHeader: "",
    });
    gateways.push(gw);
    // 外链菜单微应用：/repo 深链与带点资源一律反代业务域（而非本地 dist 兜底）
    const doc = await fetch(`${gw.origin}/repo/doc/abc`);
    expect(await doc.text()).toContain("REPO-WEB");
    expect(up.captured.microPath).toBe("/repo/doc/abc");
    const asset = await fetch(`${gw.origin}/repo/static/app.js`);
    expect(await asset.text()).toContain("REPO-WEB");
    expect(up.captured.microPath).toBe("/repo/static/app.js");
    expect(up.captured.auth).toBe("Bearer TK");
    // 前缀按段匹配：/repository 不命中 /repo，回落本地 dist SPA
    const notPrefix = await fetch(`${gw.origin}/repository/x`);
    expect(await notPrefix.text()).toContain("HOME");
    fs.rmSync(distDir, { recursive: true, force: true });
  });

  it("WS 早退级联：客户端在 101 到达前断开，upstream 请求立即中止", async () => {
    // 上游刻意延迟 101（拉开早退窗口）；客户端发出握手后立刻 destroy——
    // 若 abort 监听晚挂（在 upgrade 回调内），此窗口的断开事件永久丢失。
    let upstreamSocketClosed = false;
    const up = await startUpstream(() => undefined);
    up.server.on("upgrade", (_req, socket) => {
      socket.on("close", () => {
        upstreamSocketClosed = true;
      });
      socket.on("end", () => {
        upstreamSocketClosed = true;
      });
      setTimeout(() => {
        try {
          socket.write(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: x\r\n\r\n",
          );
        } catch {
          /* 已被级联销毁 */
        }
      }, 120);
    });
    const gw = await startLoopbackGateway({
      targetOrigin: up.origin,
      getAccessToken: () => null,
      clientTypeHeader: "",
    });
    gateways.push(gw);
    // 裸 socket 发出握手，30ms 后 destroy（确保握手已转发、上游已建连，
    // 但仍早于上游 120ms 延迟的 101——早退窗口内）
    const sock = net.connect(gw.port, "127.0.0.1");
    sock.write(
      `GET /ws-early-exit HTTP/1.1\r\nHost: 127.0.0.1:${gw.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: k\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    await new Promise((r) => setTimeout(r, 30));
    sock.destroy();
    await new Promise((r) => setTimeout(r, 500));
    expect(upstreamSocketClosed).toBe(true);
  });
});
