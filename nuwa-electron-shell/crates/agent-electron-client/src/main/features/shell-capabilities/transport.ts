import net from "node:net";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ReadBuffer } from "@modelcontextprotocol/sdk/shared/stdio.js";
type JSONRPCMessage = Parameters<NonNullable<Transport["onmessage"]>>[0];

// Only file paths are persisted in the MCP entry; the per-generation secret stays in a private file.
export const SHELL_STDIO_RELAY = `
const fs=require('node:fs'),net=require('node:net');
const s=net.connect(process.env.NUWAX_SHELL_SOCKET);
s.on('connect',()=>{s.write(JSON.stringify({token:fs.readFileSync(process.env.NUWAX_SHELL_TOKEN_FILE,'utf8').trim()})+'\\n');process.stdin.pipe(s);s.pipe(process.stdout);});
s.on('error',()=>process.exit(1));s.on('close',()=>process.exit(0));
process.stdin.on('end',()=>s.end());
`;

class SocketTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private buffer = "";
  constructor(private socket: net.Socket, initial: string) { this.buffer = initial; }
  async start() {
    this.socket.on("data", this.receive);
    this.socket.once("close", () => this.onclose?.());
    this.socket.on("error", (error) => this.onerror?.(error));
    this.receive("");
    this.socket.resume();
  }
  private receive = (data: Buffer | string) => {
    this.buffer += data.toString();
    if (Buffer.byteLength(this.buffer) > 32 * 1024 * 1024) { this.socket.destroy(); return; }
    while (this.buffer.includes("\n")) {
      const end = this.buffer.indexOf("\n"), line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      try {
        const reader = new ReadBuffer(); reader.append(Buffer.from(line + "\n"));
        const message = reader.readMessage();
        if (message) this.onmessage?.(message);
      }
      catch { this.socket.destroy(); return; }
    }
  };
  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket.destroyed) { reject(new Error("MCP connection closed")); return; }
      this.socket.write(JSON.stringify(message) + "\n", error => error ? reject(error) : resolve());
    });
  }
  async close() { this.socket.destroy(); }
}

export class ShellMcpGateway {
  private server: net.Server | null = null;
  private clients = new Set<net.Socket>();
  private protocols = new Set<McpServer>();
  constructor(private createServer: (token: string) => McpServer) {}
  get ready() { return this.server?.listening === true; }
  async listen(address: string, token: string | ((secret: string) => boolean)) {
    const server = net.createServer(socket => {
      if (this.clients.size >= 16) { socket.destroy(); return; }
      this.clients.add(socket);
      socket.setEncoding("utf8");
      socket.on("error", () => socket.destroy());
      const timeout = setTimeout(() => socket.destroy(), 3000);
      timeout.unref();
      let buffer = "";
      const authenticate = (data: Buffer | string) => {
        buffer += data.toString();
        const end = buffer.indexOf("\n");
        if (end === -1) { if (buffer.length > 2048) socket.destroy(); return; }
        if (end > 2048) { socket.destroy(); return; }
        let incoming: unknown;
        try { incoming = JSON.parse(buffer.slice(0, end)); } catch { socket.destroy(); return; }
        const secret = (incoming as { token?: unknown } | null)?.token;
        if (typeof secret !== "string") { socket.destroy(); return; }
        let accepted = false;
        try {
          accepted = typeof token === "function" ? token(secret) : Buffer.byteLength(secret) === Buffer.byteLength(token) &&
            timingSafeEqual(Buffer.from(secret), Buffer.from(token));
        } catch { /* A revoked authority rejects the transport. */ }
        if (!accepted) { socket.destroy(); return; }
        clearTimeout(timeout);
        socket.pause(); socket.removeListener("data", authenticate);
        let protocol: McpServer;
        try { protocol = this.createServer(secret); } catch { socket.destroy(); return; }
        this.protocols.add(protocol);
        socket.once("close", () => { this.protocols.delete(protocol); void protocol.close().catch(() => undefined); });
        void protocol.connect(new SocketTransport(socket, buffer.slice(end + 1))).catch(() => socket.destroy());
      };
      socket.once("close", () => { clearTimeout(timeout); this.clients.delete(socket); });
      socket.on("data", authenticate);
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(address, () => { server.removeListener("error", reject); resolve(); });
      });
      server.on("error", () => { for (const client of this.clients) client.destroy(); });
    } catch (error) { this.server = null; server.close(); throw error; }
  }
  revoke() { for (const socket of this.clients) socket.destroy(); }
  async close() {
    this.revoke();
    await Promise.allSettled([...this.protocols].map(protocol => protocol.close()));
    const server = this.server; this.server = null;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
