import net from "node:net";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { CuaTaskController, CUA_PAUSING_LIMITS, type CuaPermit } from "./taskController";
import { classifyReply, type CuaOutcome } from "./cuaOutcome";
import { CUA_REFUSED_HINT, cuaMergeInstructions, cuaRejectionText, cuaToolDescription } from "./cuaGuidance";
import type { CuaScope } from "@shared/features/computer-use/contract";

/** Errors `transformCall` may throw that are reported to the model as-is. */
const CALL_REJECTIONS = new Set(["scopeViolation", "targetClosed", "profileAttachRequiresWindowScope"]);

/** Runs with the bundled Node runtime; stdout remains exclusively MCP NDJSON. */
export const CUA_STDIO_RELAY = `
const fs=require('node:fs'),net=require('node:net');
const s=net.connect(process.env.NUWAX_CUA_GATEWAY);
s.on('connect',()=>{s.write(JSON.stringify({token:fs.readFileSync(process.env.NUWAX_CUA_GATEWAY_TOKEN,'utf8').trim(),grant:process.env.NUWAX_CUA_SESSION_FILE?fs.readFileSync(process.env.NUWAX_CUA_SESSION_FILE,'utf8').trim():undefined})+'\\n');process.stdin.pipe(s);s.pipe(process.stdout);});
s.on('error',()=>process.exit(1));s.on('close',()=>process.exit(0));
process.stdin.on('end',()=>s.end());
`;

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string;
  params?: { name?: string; arguments?: unknown };
  result?: { isError?: boolean; structuredContent?: unknown; instructions?: unknown; content?: Array<{ type: string; text?: string }>;
    tools?: Array<{ name: string; description?: string; [key: string]: unknown }> };
  error?: unknown };
type Pending = { method?: string; permit?: CuaPermit; call?: { tool: string; args: unknown }; timer: ReturnType<typeof setTimeout> };
type Connection = { id: string; socket: net.Socket; child: ChildProcessWithoutNullStreams | null;
  grant?: unknown; owner?: string;
  initialization?: Rpc; initialized: boolean;
  warming?: { id: string; finish: (error?: Error) => void };
  pending: Map<string, Pending>; close: () => void };
const keyOf = (id: unknown) => `${typeof id}:${String(id)}`;

function stopDriver(child: ChildProcessWithoutNullStreams | null) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  const kill = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 2000);
  kill.unref(); child.once("exit", () => clearTimeout(kill));
}

/** Authenticated local transport, single-flight desktop calls, no raw payload logging. */
export class CuaMcpGateway {
  private server: net.Server | null = null;
  private clients = new Set<Connection>();
  private sockets = new Set<net.Socket>();
  private holding = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  constructor(private options: {
    controller: CuaTaskController;
    launch: () => ChildProcessWithoutNullStreams;
    allowedTools: readonly string[];
    onFailure: (reason: string) => void;
    timeoutMs?: number;
    authorize?: (grant: unknown) => string | null;
    visibleTools?: () => readonly string[];
    transformCall?: (tool: string, args: unknown) => { tool: string; args: unknown };
    /** Scope the model-facing guidance is written for; desktop when omitted. */
    scope?: () => CuaScope;
    /** Sees every finished call (after the controller), e.g. to record browser bindings. */
    onResult?: (tool: string, args: unknown, outcome: CuaOutcome, structured: unknown) => void;
  }) {}
  private scope(): CuaScope { return this.options.scope?.() ?? { kind: "desktop" }; }

  async listen(socketPath: string, token: string): Promise<void> {
    if (this.server) return;
    const server = net.createServer((socket) => this.accept(socket, token));
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => { server.removeListener("error", reject); resolve(); });
      });
      server.on("error", () => this.options.onFailure("gatewayFailed"));
      this.watchdog = setInterval(() => {
        const reason = this.options.controller.checkDeadline();
        if (reason) this.options.onFailure(reason);
      }, 1000);
      this.watchdog.unref();
    } catch (error) {
      this.server = null;
      server.close();
      throw error;
    }
  }
  get ready() { return this.server?.listening === true; }

  private accept(socket: net.Socket, token: string) {
    if (this.sockets.size >= 32) { socket.destroy(); return; }
    socket.setEncoding("utf8");
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    let buffer = "";
    let connected: Connection | null = null;
    const authTimer = setTimeout(() => socket.destroy(), 3000);
    authTimer.unref();
    socket.once("close", () => clearTimeout(authTimer));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > 1024 * 1024) { socket.destroy(); return; }
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message: Rpc & { token?: unknown; grant?: unknown };
        try { message = JSON.parse(line); } catch { socket.destroy(); return; }
        if (!message || typeof message !== "object" || Array.isArray(message)) { socket.destroy(); return; }
        if (!connected) {
          if (typeof message.token !== "string" || Buffer.byteLength(message.token) !== Buffer.byteLength(token) ||
              !timingSafeEqual(Buffer.from(message.token), Buffer.from(token))) { socket.destroy(); return; }
          clearTimeout(authTimer);
          try { connected = this.connect(socket); connected.grant = message.grant; }
          catch { socket.destroy(); return; }
        } else this.forward(connected, message, line);
      }
    });
  }

  private connect(socket: net.Socket): Connection {
    const connection: Connection = { id: randomUUID(), socket, child: null, initialized: false, pending: new Map(), close: () => {} };
    let closed = false;
    connection.close = () => {
      if (closed) return;
      closed = true;
      const hadOperation = [...connection.pending.values()].some((p) => p.permit);
      const hadOwnership = this.options.controller.owns(connection.owner ?? connection.id);
      for (const p of connection.pending.values()) clearTimeout(p.timer);
      connection.pending.clear();
      connection.warming?.finish(new Error("connectionClosed"));
      this.clients.delete(connection);
      this.options.controller.disconnect(connection.owner ?? connection.id, !this.options.authorize);
      const child = connection.child;
      connection.child = null;
      stopDriver(child);
      socket.destroy();
      if (hadOperation || hadOwnership) this.options.onFailure("connectionClosed");
    };
    this.clients.add(connection);
    socket.once("close", connection.close);
    socket.on("drain", () => connection.child?.stdout.resume());
    if (!this.holding) this.attachDriver(connection);
    return connection;
  }

  private attachDriver(connection: Connection) {
    const { socket } = connection;
    const child = this.options.launch();
    connection.child = child;
    const failed = () => { if (connection.child === child) connection.close(); };
    child.on("error", failed);
    child.on("exit", failed);
    child.stdin.on("error", failed);
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdin.on("drain", () => socket.resume());
    let output = "";
    child.stdout.on("data", (chunk) => {
      if (connection.child !== child) return;
      output += chunk.toString("utf8");
      if (Buffer.byteLength(output) > 32 * 1024 * 1024) { connection.close(); return; }
      while (output.includes("\n")) {
        const end = output.indexOf("\n");
        let line = output.slice(0, end);
        output = output.slice(end + 1);
        let message: Rpc;
        try { message = JSON.parse(line); } catch { connection.close(); return; }
        if (!message || typeof message !== "object" || Array.isArray(message)) { connection.close(); return; }
        const warming = connection.warming;
        if (warming && warming.id === message.id) {
          if (message.error || !message.result) warming.finish(new Error("gatewayFailed"));
          else {
            child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
            warming.finish();
          }
          continue;
        }
        const pending = connection.pending.get(keyOf(message.id));
        if (pending) {
          clearTimeout(pending.timer);
          connection.pending.delete(keyOf(message.id));
          if (pending.method === "initialize" && !message.error) {
            connection.initialized = true;
            if (message.result) {
              message.result.instructions = cuaMergeInstructions(this.scope(), message.result.instructions);
              line = JSON.stringify(message);
            }
          }
          if (pending.method === "tools/list" && message.result?.tools) {
            const visible = this.options.visibleTools?.() ?? this.options.allowedTools;
            const scope = this.scope();
            message.result.tools = message.result.tools
              .filter((tool) => this.options.allowedTools.includes(tool.name) && visible.includes(tool.name))
              .map((tool) => ({ ...tool, description: cuaToolDescription(scope, tool.name, tool.description) }));
            line = JSON.stringify(message);
          }
          if (pending.permit) {
            const outcome = classifyReply(pending.permit.tool, message);
            const structured = message.result?.structuredContent;
            if (!this.options.controller.finish(pending.permit, outcome, structured)) {
              this.reject(socket, message.id, "operationCancelled");
              continue;
            }
            if (pending.call) this.options.onResult?.(pending.call.tool, pending.call.args, outcome, structured);
            if (outcome === "refused" && message.result) {
              message.result.content = [...(message.result.content ?? []), { type: "text", text: CUA_REFUSED_HINT }];
              line = JSON.stringify(message);
            }
            if (this.options.controller.snapshot().phase === "paused") {
              this.options.onFailure(this.options.controller.snapshot().reason ?? "uncertainResult");
            }
          }
        } else if (message.id !== undefined && !message.method) {
          continue; // discard late replies from cancelled/timed-out operations
        }
        if (!socket.write(`${line}\n`)) child.stdout.pause();
      }
    });
  }

  /** Keep the agent-facing connection while shutting down every driver-facing transport. */
  pauseTransports() {
    this.holding = true;
    this.cancelPending("operationCancelled");
    for (const connection of [...this.clients]) {
      if (!connection.initialized) { connection.close(); continue; }
      const child = connection.child;
      connection.child = null; // ignore old process events and replies before killing it
      stopDriver(child);
      connection.warming?.finish(new Error("operationCancelled"));
      connection.socket.resume();
    }
  }

  private async warmDriver(connection: Connection) {
    this.attachDriver(connection);
    await new Promise<void>((resolve, reject) => {
      const id = `reconnect-${randomUUID()}`;
      const timer = setTimeout(() => connection.warming?.finish(new Error("gatewayFailed")), 8000);
      connection.warming = { id, finish: (error) => {
        clearTimeout(timer); connection.warming = undefined;
        if (error) reject(error); else resolve();
      } };
      connection.child!.stdin.write(JSON.stringify({ ...connection.initialization, id }) + "\n");
    });
  }

  /** Drop the helper lease (cursor/recording/session resources) at prompt completion. */
  async releaseOwner(owner: string) {
    await Promise.all([...this.clients].filter((connection) => connection.owner === owner).map(async (connection) => {
      const child = connection.child; connection.child = null; connection.owner = undefined;
      stopDriver(child);
      if (!this.holding) {
        try { await this.warmDriver(connection); } catch { connection.close(); }
      }
    }));
  }

  async resumeTransports() {
    if (!this.holding) return;
    await Promise.all([...this.clients].map(async (connection) => {
      if (!connection.initialization || !connection.initialized) { connection.close(); return; }
      await this.warmDriver(connection);
    }));
    this.holding = false;
  }

  private reject(socket: net.Socket, id: Rpc["id"], reason: string, method = "tools/call") {
    if (id === undefined) return;
    if (method !== "tools/call") {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: `Computer Use: ${reason}`, data: { retryable: false } } })}\n`);
      return;
    }
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: {
      isError: true, content: [{ type: "text", text: cuaRejectionText(reason) }],
      structuredContent: { code: reason, retryable: false },
    } })}\n`);
  }
  /** A call refused before reaching the helper; the controller counts it against the task. */
  private refuse(connection: Connection, owner: string, id: Rpc["id"], reason: string) {
    this.options.controller.recordRejection(owner, reason);
    this.reject(connection.socket, id, reason);
    const state = this.options.controller.snapshot();
    // Same as a user stop: a call still in flight must not report success later.
    if (state.phase === "stopped" && state.reason === "violationLimit") this.cancelPending("violationLimit");
  }
  private forward(connection: Connection, message: Rpc, line: string) {
    let permit: CuaPermit | undefined;
    let call: { tool: string; args: unknown } | undefined;
    const id = message.id;
    if (id !== undefined && (id === null || !["string", "number"].includes(typeof id))) { connection.close(); return; }
    if (id !== undefined && connection.pending.has(keyOf(id))) { connection.close(); return; }
    if (connection.pending.size >= 32) { connection.close(); return; }
    if (connection.warming) { this.reject(connection.socket, id, "operationInProgress", message.method); return; }
    if (this.holding || !connection.child) {
      this.reject(connection.socket, id, this.options.controller.snapshot().reason ?? "paused", message.method); return;
    }
    if (message.method === "initialize") connection.initialization = structuredClone(message);
    if (message.method === "tools/call") {
      if (id === undefined) return;
      if (!connection.initialized) {
        this.reject(connection.socket, id, "notInitialized", "initialize"); return;
      }
      const owner = this.options.authorize ? this.options.authorize(connection.grant) : connection.id;
      if (!owner) { this.reject(connection.socket, id, "sessionRequired"); return; }
      connection.owner = owner;
      const tool = message.params?.name;
      if (typeof tool !== "string" || !this.options.allowedTools.includes(tool)) {
        this.refuse(connection, owner, id, "toolNotAllowed"); return;
      }
      call = { tool, args: message.params?.arguments ?? {} };
      try { if (this.options.transformCall) call = this.options.transformCall(tool, call.args); }
      catch (error) {
        const reason = error instanceof Error && CALL_REJECTIONS.has(error.message) ? error.message : "scopeViolation";
        this.refuse(connection, owner, id, reason); return;
      }
      const decision = this.options.controller.begin(owner, call.tool, call.args);
      if (decision.error) {
        this.reject(connection.socket, id, decision.error);
        if (CUA_PAUSING_LIMITS.includes(decision.error)) this.options.onFailure(decision.error);
        return;
      }
      permit = decision.permit;
      message = { ...message, params: { ...message.params, name: call.tool, arguments: call.args } };
      line = JSON.stringify(message);
    }
    if (id !== undefined && message.method) {
      const timer = setTimeout(() => {
        connection.pending.delete(keyOf(id));
        if (permit) {
          this.options.controller.pause("toolTimeout");
          this.options.onFailure("toolTimeout");
        }
        this.reject(connection.socket, id, "toolTimeout", message.method);
      }, this.options.timeoutMs ?? 120_000);
      timer.unref();
      connection.pending.set(keyOf(id), { permit, call, timer, method: message.method });
    }
    if (!connection.child.stdin.write(`${line}\n`)) connection.socket.pause();
  }

  cancelPending(reason: string) {
    for (const c of this.clients) for (const [key, pending] of c.pending) {
      if (!pending.permit) continue;
      clearTimeout(pending.timer);
      c.pending.delete(key);
      const id = key.startsWith("number:") ? Number(key.slice(7)) : key.slice(7);
      this.reject(c.socket, id, reason);
    }
  }
  async close() {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    const server = this.server;
    this.server = null;
    this.cancelPending("unavailable");
    for (const c of [...this.clients]) c.close();
    for (const socket of this.sockets) socket.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
