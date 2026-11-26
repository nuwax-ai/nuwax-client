/**
 * Agent 浏览器的本地 MCP 网关。
 *
 * 与 Computer Use / Android 相同的会话凭据模型：每次会话拿到独立 grant 文件，
 * 网关只把该 grant 绑定的 owner 传给控制器。连接断开时立即放弃该会话的控制，
 * 未完成的请求按 cancelled/uncertain 结束且不自动重试。
 */
import net from "node:net";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { AgentToolOutcome } from "./controller";
import { AgentBrowserError } from "./errors";
import { AGENT_BROWSER_TOOLS } from "./tools";

export interface BrowserGrantRecord {
  /** Per-turn generation; null while no turn is active. */
  owner: string | null;
  /** Host-issued window ownership key, independent of engine session IDs. */
  sessionKey: string | null;
  conversationId: string | null;
  /** Session grants are usable only between participant start and finish. */
  active: boolean;
}

export interface BrowserGatewayOptions {
  owner(grant: string): BrowserGrantRecord | undefined;
  call(input: {
    owner: string;
    sessionKey: string | null;
    conversationId: string | null;
    tool: string;
    args: unknown;
    signal: AbortSignal;
  }): Promise<AgentToolOutcome>;
  cancel(owner: string): void;
  /** The current transport for this grant closed; end its turn. */
  disconnect(grant: string): void;
}

type Rpc = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: {
    name?: string;
    arguments?: unknown;
    requestId?: string | number;
    protocolVersion?: string;
  };
  token?: unknown;
  grant?: unknown;
};

const MAX_BUFFER = 1024 * 1024;
const MAX_PENDING = 8;

export class BrowserGateway {
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  /** One live transport per grant; a later connection supersedes the old one. */
  private readonly activeConnections = new Map<
    string,
    { id: string; socket: net.Socket }
  >();
  private readonly superseded = new Set<string>();

  constructor(private readonly options: BrowserGatewayOptions) {}

  async listen(token: string): Promise<number> {
    if (this.server) throw new Error("Browser gateway already listening");
    const server = net.createServer((socket) => this.accept(socket, token));
    this.server = server;
    try {
      return await new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          const address = server.address();
          if (!address || typeof address === "string")
            reject(new Error("Browser gateway has no port"));
          else resolve(address.port);
        });
      });
    } catch (error) {
      this.server = null;
      server.close();
      throw error;
    }
  }

  get ready(): boolean {
    return this.server?.listening === true;
  }

  close(): void {
    for (const socket of [...this.sockets]) socket.destroy();
    this.sockets.clear();
    this.activeConnections.clear();
    this.superseded.clear();
    this.server?.close();
    this.server = null;
  }

  private accept(socket: net.Socket, token: string): void {
    if (this.sockets.size >= 32) {
      socket.destroy();
      return;
    }
    const connectionId = randomUUID();
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("error", () => socket.destroy());
    let buffer = "";
    let authenticated = false;
    let grant = "";
    let closed = false;
    const pending = new Map<string, AbortController>();
    const authTimer = setTimeout(() => socket.destroy(), 5000);
    authTimer.unref();

    const send = (data: unknown) => {
      if (!socket.destroyed) socket.write(JSON.stringify(data) + "\n");
    };
    const record = () =>
      authenticated && grant ? this.options.owner(grant) : undefined;
    const abandon = () => {
      if (closed) return;
      closed = true;
      clearTimeout(authTimer);
      this.sockets.delete(socket);
      for (const controller of pending.values())
        controller.abort(new AgentBrowserError("cancelled", "The MCP connection closed."));
      pending.clear();
      // Only the current transport can end the grant's turn. A superseded
      // connection closing must not revoke the newer transport.
      const current = grant ? this.activeConnections.get(grant) : undefined;
      if (current?.id === connectionId) {
        this.activeConnections.delete(grant);
        this.options.disconnect(grant);
      }
      this.superseded.delete(connectionId);
    };
    socket.once("close", abandon);
    socket.once("end", abandon);

    const reply = (
      id: string | number,
      result: Record<string, unknown>,
    ) => send({ jsonrpc: "2.0", id, result });
    const replyError = (id: string | number, message: string) =>
      send({ jsonrpc: "2.0", id, error: { code: -32000, message } });

    const callTool = async (
      id: string | number,
      rpc: Rpc,
    ): Promise<void> => {
      const bound = record();
      // A valid session grant is still not enough: only an active turn has an
      // owner generation. Late calls after finish/cancel/disconnect are refused.
      if (!bound?.active || !bound.owner) {
        replyError(id, "notAuthorized");
        return;
      }
      const controller = new AbortController();
      const key = `${typeof id}:${String(id)}`;
      pending.set(key, controller);
      try {
        const result = await this.options.call({
          owner: bound.owner,
          sessionKey: bound.sessionKey,
          conversationId: bound.conversationId,
          tool: typeof rpc.params?.name === "string" ? rpc.params.name : "",
          args: rpc.params?.arguments,
          signal: controller.signal,
        });
        const content: Array<Record<string, unknown>> = [
          { type: "text", text: result.text },
        ];
        if (result.image)
          content.push({
            type: "image",
            data: result.image.data,
            mimeType: result.image.mimeType,
          });
        reply(id, {
          content,
          structuredContent: result.structured,
          isError: false,
        });
      } catch (error) {
        const known =
          error instanceof AgentBrowserError
            ? error
            : new AgentBrowserError(
                "uncertain",
                error instanceof Error ? error.message : "operationFailed",
                true,
              );
        reply(id, {
          isError: true,
          content: [
            { type: "text", text: `${known.code}: ${known.message}` },
          ],
          structuredContent: {
            code: known.code,
            uncertain: known.uncertain,
          },
        });
      } finally {
        pending.delete(key);
      }
    };

    const handle = async (raw: string): Promise<void> => {
      let rpc: Rpc;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("invalid");
        rpc = parsed as Rpc;
      } catch {
        socket.destroy();
        return;
      }
      if (!authenticated) {
        const supplied =
          typeof rpc.token === "string"
            ? Buffer.from(rpc.token)
            : Buffer.alloc(0);
        const expected = Buffer.from(token);
        if (
          supplied.length !== expected.length ||
          !timingSafeEqual(supplied, expected)
        ) {
          socket.destroy();
          return;
        }
        // A session-specific grant is required for actions, but the global
        // config entry may connect without one to list tools.
        if (rpc.grant !== undefined) {
          if (typeof rpc.grant !== "string" || !this.options.owner(rpc.grant)) {
            socket.destroy();
            return;
          }
          grant = rpc.grant;
          const previous = this.activeConnections.get(grant);
          // Publish the new transport before closing the old one so the old
          // close handler cannot mistake itself for the current transport.
          this.activeConnections.set(grant, { id: connectionId, socket });
          if (previous && previous.id !== connectionId) {
            this.superseded.add(previous.id);
            previous.socket.destroy();
          }
        }
        authenticated = true;
        clearTimeout(authTimer);
        return;
      }
      if (!rpc || typeof rpc !== "object") {
        socket.destroy();
        return;
      }
      if (this.superseded.has(connectionId)) {
        socket.destroy();
        return;
      }
      if (rpc.method === "notifications/cancelled") {
        const bound = record();
        const key = `${typeof rpc.params?.requestId}:${String(rpc.params?.requestId)}`;
        const controller = pending.get(key);
        if (controller) {
          controller.abort(
            new AgentBrowserError("cancelled", "The MCP request was cancelled."),
          );
        }
        if (bound?.active && bound.owner) this.options.cancel(bound.owner);
        return;
      }
      if (rpc.id === undefined) return;
      const id = rpc.id;
      if (
        (typeof id !== "string" && typeof id !== "number") ||
        rpc.jsonrpc !== "2.0"
      ) {
        socket.destroy();
        return;
      }
      const key = `${typeof id}:${String(id)}`;
      if (pending.has(key) || pending.size >= MAX_PENDING) {
        socket.destroy();
        return;
      }
      try {
        if (rpc.method === "initialize") {
          reply(id, {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "nuwax-browser", version: "1.0.0" },
          });
          return;
        }
        if (rpc.method === "ping") {
          reply(id, {});
          return;
        }
        if (rpc.method === "tools/list") {
          reply(id, { tools: [...AGENT_BROWSER_TOOLS] });
          return;
        }
        if (rpc.method === "tools/call") {
          await callTool(id, rpc);
          return;
        }
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "Method not found" },
        });
      } catch {
        replyError(id, "operationFailed");
      }
    };

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_BUFFER) {
        socket.destroy();
        return;
      }
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        void handle(line);
      }
    });
  }
}
