import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CUA_STDIO_RELAY } from "./stdioRelay";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
describe("CUA stdio relay recovery", () => {
  it("keeps stdio alive, reinitializes the replacement gateway, and never replays a lost write", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cua-relay-"));
    cleanups.push(() => fs.rmSync(root, { force: true, recursive: true }));
    const socketPath = process.platform === "win32" ? "\\\\.\\pipe\\relay-" + randomUUID() : path.join(root, "s");
    const tokenFile = path.join(root, "token");
    fs.writeFileSync(tokenFile, "test-token");
    const sockets = new Set<net.Socket>();
    let writes = 0, initializations = 0;
    const server = net.createServer(socket => {
      sockets.add(socket); socket.once("close", () => sockets.delete(socket));
      let buffer = "", admitted = false;
      socket.on("data", data => {
        buffer += data;
        while (buffer.includes("\n")) {
          const end = buffer.indexOf("\n"), message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          if (!admitted) { admitted = message.token === "test-token"; if (!admitted) socket.destroy(); continue; }
          if (message.method === "initialize") initializations++;
          if (message.method === "tools/call" && message.params.name === "click") { writes++; socket.destroy(); continue; }
          if (message.id !== undefined) socket.write(JSON.stringify({ jsonrpc: "2.0", id: message.id,
            result: message.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: {} }
              : { content: [{ type: "text", text: "ready" }] } }) + "\n");
        }
      });
    });
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const relay = spawn(process.execPath, ["-e", CUA_STDIO_RELAY], { env: { ...process.env,
      NUWAX_CUA_GATEWAY: socketPath, NUWAX_CUA_GATEWAY_TOKEN: tokenFile, NUWAX_CUA_SESSION_FILE: "" }, stdio: ["pipe", "pipe", "pipe"] });
    cleanups.push(() => { relay.kill(); });
    let counter = 0, buffer = "";
    const pending = new Map<number, (reply: any) => void>();
    relay.stdout.on("data", data => {
      buffer += data;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"), message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        pending.get(message.id)?.(message); pending.delete(message.id);
      }
    });
    function request(method: string, params?: unknown): Promise<any> {
      const id = ++counter;
      return new Promise(resolve => {
        pending.set(id, resolve);
        relay.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    }
    expect((await request("initialize", { protocolVersion: "2024-11-05" })).result.protocolVersion).toBe("2024-11-05");
    const lost = await request("tools/call", { name: "click", arguments: { x: 1, y: 1 } });
    expect(lost.result.structuredContent.code).toBe("serviceRecovering");
    await vi.waitFor(() => expect(initializations).toBe(2), { timeout: 4000 });
    expect((await request("tools/call", { name: "get_desktop_state" })).result.content[0].text).toBe("ready");
    expect(writes).toBe(1);
    expect(relay.exitCode).toBeNull();
    relay.stdin.end();
    await new Promise<void>(resolve => relay.once("exit", () => resolve()));
  });
});
