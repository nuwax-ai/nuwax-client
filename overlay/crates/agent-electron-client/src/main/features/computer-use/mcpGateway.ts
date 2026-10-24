import net from "node:net";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { CuaTaskController, CUA_FINAL_REASONS, CUA_PAUSING_LIMITS, type CuaPermit } from "./taskController";
import { classifyReply, type CuaOutcome } from "./cuaOutcome";
import { CUA_AGENT_CURSOR_ENABLE, CUA_REFUSED_HINT, cuaMergeInstructions, cuaRejectionText, cuaToolDescription } from "./cuaGuidance";
import type { CuaScope } from "@shared/features/computer-use/contract";
import type { CuaTaskRegistry } from "./taskRegistry";
import { CUA_TASK_GUIDANCE } from "./taskPolicy";

/** Errors `transformCall` may throw that are reported to the model as-is. */
const CALL_REJECTIONS = new Set(["scopeViolation", "targetClosed", "profileAttachRequiresWindowScope", "blacklisted", "confirmationRequired", "sensitiveTarget"]);

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
type Pending = { method?: string; permit?: CuaPermit; call?: { tool: string; args: unknown }; timer: ReturnType<typeof setTimeout>;
  release?: () => void; aborted?: boolean; held?: boolean };
type Connection = { id: string; socket: net.Socket; child: ChildProcessWithoutNullStreams | null;
  grant?: unknown; owner?: string;
  initialization?: Rpc; initialized: boolean;
  /** 本条 helper 租约是否已按偏好处理过 agent cursor（开或明确跳过）。 */
  cursorArmed?: boolean;
  warming?: { id: string; finish: (error?: Error) => void };
  pending: Map<string, Pending>; reservations: Set<string>; lifetime: AbortController; close: () => void };
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
    controller: CuaTaskController | CuaTaskRegistry;
    launch: () => ChildProcessWithoutNullStreams;
    allowedTools: readonly string[];
    onFailure: (reason: string, owner?: string) => void;
    timeoutMs?: number;
    authorize?: (grant: unknown) => string | null;
    visibleTools?: (owner?: string) => readonly string[];
    transformCall?: (tool: string, args: unknown, owner?: string) => { tool: string; args: unknown };
    /** Scope the model-facing guidance is written for; desktop when omitted. */
    scope?: (owner?: string) => CuaScope;
    /** 活跃桌面任务是否默认开模拟光标；缺省 true。不改变 Background 投递。 */
    agentCursor?: () => boolean;
    /** Sees every finished call (after the controller), e.g. to record browser bindings. */
    onResult?: (tool: string, args: unknown, outcome: CuaOutcome, structured: unknown, owner?: string) => void;
    /** 询问式授权：敏感写动作需用户点一次允许。 */
    requireConfirmation?: (tool: string, args: unknown, owner: string) => boolean;
    /** Spend a one-shot approval only after observation and live native guards admit dispatch. */
    confirmDispatch?: (tool: string, args: unknown, owner: string) => boolean;
    /** 黑名单命中则拒绝该窗口/应用。 */
    rejectTarget?: (tool: string, args: unknown, owner: string) => string | null | Promise<string | null>;
    prepareTarget?: (owner: string, tool: string, args: unknown) => Promise<void>;
    discoverWindows?: () => Promise<unknown[]>;
    /** 观察结果含密码框/锁屏时打码或跳过送模。 */
    sanitizeResult?: (tool: string, result: NonNullable<Rpc["result"]>) => void;
    tasks?: CuaTaskRegistry;
    beforeCall?: (owner: string, call: { tool: string; args: unknown }) => Promise<{ tool: string; args: unknown }>;
  }) {}
  private scope(owner?: string): CuaScope { return this.options.scope?.(owner) ?? { kind: "desktop" }; }
  private fail(reason: string, owner?: string) {
    if (this.options.tasks) this.options.onFailure(reason, owner);
    else this.options.onFailure(reason);
  }

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
        } else void this.forward(connected, message, line).catch(() => connected?.close());
      }
    });
  }

  private connect(socket: net.Socket): Connection {
    const connection: Connection = { id: randomUUID(), socket, child: null, initialized: false,
      pending: new Map(), reservations: new Set(), lifetime: new AbortController(), close: () => {} };
    let closed = false;
    connection.close = () => {
      if (closed) return;
      closed = true;
      connection.lifetime.abort();
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
      if (hadOperation || hadOwnership) this.fail("connectionClosed", connection.owner);
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
    connection.cursorArmed = false;
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
          pending.release?.();
          pending.release = undefined;
          if (pending.aborted) {
            if (pending.held) connection.pending.set(keyOf(message.id), pending);
            continue;
          }
          if (pending.method === "initialize" && !message.error) {
            connection.initialized = true;
            if (message.result) {
              message.result.instructions = this.options.tasks ? CUA_TASK_GUIDANCE
                : cuaMergeInstructions(this.scope(connection.owner), message.result.instructions);
              line = JSON.stringify(message);
            }
          }
          if (pending.method === "tools/list" && message.result?.tools) {
            const currentOwner = this.options.authorize?.(connection.grant) ?? connection.owner;
            const visible = this.options.visibleTools?.(currentOwner) ?? this.options.allowedTools;
            const scope = this.scope(currentOwner);
            message.result.tools = message.result.tools
              .filter((tool) => this.options.allowedTools.includes(tool.name) && visible.includes(tool.name))
              .map((tool) => ({ ...tool, description: this.options.tasks
                ? CUA_TASK_GUIDANCE + "\n\n" + (tool.description ?? "") : cuaToolDescription(scope, tool.name, tool.description) }));
            line = JSON.stringify(message);
          }
          if (pending.permit) {
            if (pending.call && message.result) this.options.sanitizeResult?.(pending.call.tool, message.result);
            const outcome = classifyReply(pending.permit.tool, message);
            const structured = message.result?.structuredContent;
            if (!this.options.controller.finish(pending.permit, outcome, structured)) {
              this.reject(socket, message.id, "operationCancelled");
              continue;
            }
            // ACP engines may consume only MCP content, dropping structuredContent.
            // Preserve the helper's exact snapshot identity in that text channel;
            // never mint a token or turn a preview/stale/refused reply into evidence.
            const snapshotId = (structured as { snapshot_id?: unknown } | undefined)?.snapshot_id;
            if (this.options.tasks && pending.call?.tool === "get_window_state" && outcome === "ok" && message.result) {
              const mode = this.options.tasks.stateForOwner(pending.permit.owner)?.mode ?? "background";
              const modeText = mode === "background"
                ? "Nuwax execution mode: background. Use set_value for text and exact elements for click/scroll. Generic keyboard, pixel and drag input are not authorized; ask the user to take over if semantic input is unavailable."
                : "Nuwax execution mode: foreground. Foreground input is explicitly authorized for this bound window only.";
              const snapshotText = typeof snapshotId === "string" && /^s[0-9a-f]{8}$/i.test(snapshotId)
                ? ` Current window observation snapshot_id="${snapshotId}". For an indexed element, copy this snapshot_id together with its element_index from this observation. Never invent a snapshot id or reuse one after observing again.` : "";
              message.result.content = [{ type: "text", text: modeText + snapshotText },
              ...(message.result.content ?? [])];
              line = JSON.stringify(message);
            }
            if (pending.call) {
              const safeStructured = message.result?.structuredContent;
              this.options.onResult?.(pending.call.tool, pending.call.args, outcome, safeStructured, pending.permit.owner);
              if (outcome === "ok" && message.result) line = JSON.stringify(message);
            }
            if (outcome === "refused" && message.result) {
              message.result.content = [...(message.result.content ?? []), { type: "text", text: CUA_REFUSED_HINT }];
              line = JSON.stringify(message);
            }
            const state = this.options.tasks?.stateForOwner(pending.permit.owner) ?? this.options.controller.snapshot();
            if (state.phase === "paused") {
              if (this.options.tasks) this.holdReply(connection, keyOf(message.id), pending);
              this.fail(state.reason ?? "uncertainResult", pending.permit.owner);
              if (this.options.tasks) continue;
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

  /** Host-issued overlay enablement; not a model step and not gated on observation. */
  private armAgentCursor(connection: Connection) {
    if (connection.cursorArmed) return;
    connection.cursorArmed = true;
    if (!this.options.agentCursor?.()) return;
    const child = connection.child;
    if (!child) return;
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: `host-cursor-${randomUUID()}`,
      method: "tools/call",
      params: { name: CUA_AGENT_CURSOR_ENABLE.name, arguments: CUA_AGENT_CURSOR_ENABLE.arguments },
    })}\n`);
  }

  /** Drop the helper lease (cursor/recording/session resources) at prompt completion. */
  async releaseOwner(owner: string) {
    await Promise.all([...this.clients].filter((connection) => connection.owner === owner).map(async (connection) => {
      const child = connection.child; connection.child = null; connection.owner = this.options.tasks ? owner : undefined;
      connection.cursorArmed = false;
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
    const state = this.options.tasks?.stateForOwner(owner) ?? this.options.controller.snapshot();
    // Same as a user stop: a call still in flight must not report success later.
    if (state.phase === "stopped" && state.reason === "violationLimit") {
      if (this.options.tasks) { this.holdOwner(owner, "violationLimit"); this.fail("violationLimit", owner); }
      else this.cancelPending("violationLimit");
    }
  }
  private async forward(connection: Connection, message: Rpc, line: string) {
    let permit: CuaPermit | undefined;
    let call: { tool: string; args: unknown } | undefined;
    const id = message.id;
    if (this.options.tasks && !["initialize", "notifications/initialized", "tools/list", "tools/call", "ping"].includes(message.method ?? "")) {
      this.reject(connection.socket, id, "toolNotAllowed", message.method);
      return;
    }
    if (id !== undefined && (id === null || !["string", "number"].includes(typeof id))) { connection.close(); return; }
    if (id !== undefined && (connection.pending.has(keyOf(id)) || connection.reservations.has(keyOf(id)))) { connection.close(); return; }
    if (connection.pending.size + connection.reservations.size >= 32) { connection.close(); return; }
    if (this.holding || !connection.child) {
      const owner = this.options.authorize ? this.options.authorize(connection.grant) : connection.id;
      const state = this.options.controller.snapshot();
      if (!this.options.tasks && this.holding && connection.initialized && message.method === "tools/call"
        && id !== undefined && owner && this.options.controller.owns(owner) && state.phase === "paused"
        && !CUA_FINAL_REASONS.includes(state.reason ?? "") && typeof message.params?.name === "string"
        && this.options.allowedTools.includes(message.params.name)) {
        // Pausing while the model thinks must also retain its next tool call.
        // Do not retain arguments or execute this stale call after human resume.
        const pending: Pending = { method: "tools/call", timer: undefined as unknown as ReturnType<typeof setTimeout> };
        this.holdReply(connection, keyOf(id), pending, owner); return;
      }
      this.reject(connection.socket, id, this.options.controller.snapshot().reason ?? "paused", message.method); return;
    }
    if (connection.warming) { this.reject(connection.socket, id, "operationInProgress", message.method); return; }
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
      if (tool === "list_windows" && this.options.discoverWindows) {
        try {
          const windows = await this.options.discoverWindows();
          if (this.options.authorize && this.options.authorize(connection.grant) !== owner) {
            this.reject(connection.socket, id, "sessionRequired"); return;
          }
          connection.socket.write(JSON.stringify({ jsonrpc: "2.0", id, result: {
            content: [{ type: "text", text: JSON.stringify({ windows }) }], structuredContent: { windows },
          } }) + "\n");
        } catch { this.refuse(connection, owner, id, "targetClosed"); }
        return;
      }
      try { await this.options.prepareTarget?.(owner, tool, message.params?.arguments ?? {}); }
      catch (error) { this.refuse(connection, owner, id, error instanceof Error ? error.message : "targetClosed"); return; }
      if (this.options.tasks) {
        connection.reservations.add(keyOf(id));
        try { await this.options.tasks.waitReady(owner, connection.lifetime.signal); }
        catch (error) {
          this.reject(connection.socket, id, error instanceof Error ? error.message : "taskStopped");
          return;
        } finally { connection.reservations.delete(keyOf(id)); }
        if (this.options.authorize && this.options.authorize(connection.grant) !== owner) {
          this.reject(connection.socket, id, "sessionRequired"); return;
        }
      }
      call = { tool, args: message.params?.arguments ?? {} };
      try { if (this.options.transformCall) call = this.options.transformCall(tool, call.args, owner); }
      catch (error) {
        const reason = error instanceof Error && (CALL_REJECTIONS.has(error.message) ||
          ["targetRequired", "foregroundRequired", "taskUnavailable"].includes(error.message)) ? error.message : "scopeViolation";
        if (this.options.tasks && reason === "foregroundRequired") {
          this.options.tasks.pauseTask(this.options.tasks.ensure(owner).id, reason);
          this.fail(reason, owner);
          connection.reservations.add(keyOf(id));
          try {
            await this.options.tasks.waitReady(owner, connection.lifetime.signal);
            this.reject(connection.socket, id, "operationPaused");
          } catch { this.reject(connection.socket, id, "taskStopped"); }
          finally { connection.reservations.delete(keyOf(id)); }
          return;
        }
        this.refuse(connection, owner, id, reason);
        return;
      }
      let blocked: string | null | undefined;
      try { blocked = await this.options.rejectTarget?.(call.tool, call.args, owner); }
      catch { blocked = "targetClosed"; }
      if (this.options.authorize && this.options.authorize(connection.grant) !== owner) {
        this.reject(connection.socket, id, "sessionRequired"); return;
      }
      if (blocked) { this.refuse(connection, owner, id, blocked); return; }
      if (this.options.requireConfirmation?.(call.tool, call.args, owner)) {
        if (!this.options.controller.owns(owner)) {
          this.refuse(connection, owner, id, "observationRequired"); return;
        }
        this.deferConfirmation(connection, id, owner); return;
      }
      const decision = this.options.controller.begin(owner, call.tool, call.args);
      if (decision.error) {
        this.reject(connection.socket, id, decision.error);
        if (CUA_PAUSING_LIMITS.includes(decision.error)) this.fail(decision.error, owner);
        return;
      }
      permit = decision.permit;
      this.armAgentCursor(connection);
      message = { ...message, params: { ...message.params, name: call.tool, arguments: call.args } };
      line = JSON.stringify(message);
    }
    if (id !== undefined && message.method) {
      const entry: Pending = { permit, call, timer: undefined as unknown as ReturnType<typeof setTimeout>, method: message.method };
      const timer = setTimeout(() => {
        entry.aborted = true;
        if (!this.options.tasks) connection.pending.delete(keyOf(id));
        if (permit) {
          if (!this.options.tasks) this.options.controller.pause("toolTimeout");
          this.fail("toolTimeout", permit.owner);
          if (this.options.tasks) return;
        }
        this.reject(connection.socket, id, "toolTimeout", message.method);
      }, this.options.timeoutMs ?? 120_000);
      timer.unref();
      entry.timer = timer;
      connection.pending.set(keyOf(id), entry);
      if (permit && call && this.options.tasks) {
        try {
          entry.release = await this.options.tasks.acquire(permit.owner);
          if (!this.options.tasks.valid(permit)) {
            entry.release(); entry.release = undefined; clearTimeout(timer);
            if (!entry.held) connection.pending.delete(keyOf(id));
            return;
          }
          const prepared = this.options.beforeCall ? await this.options.beforeCall(permit.owner, call) : call;
          if (!this.options.tasks.valid(permit)) {
            entry.release(); entry.release = undefined; clearTimeout(timer);
            if (!entry.held) connection.pending.delete(keyOf(id));
            return;
          }
          const blocked = await this.options.rejectTarget?.(prepared.tool, prepared.args, permit.owner);
          if (blocked || this.options.authorize && this.options.authorize(connection.grant) !== permit.owner) {
            clearTimeout(timer); entry.release?.(); entry.release = undefined;
            connection.pending.delete(keyOf(id));
            this.options.controller.finish(permit, "refused");
            this.refuse(connection, permit.owner, id, blocked ?? "sessionRequired"); return;
          }
          if (!this.options.tasks.valid(permit)) {
            entry.release?.(); entry.release = undefined; clearTimeout(timer);
            if (!entry.held) connection.pending.delete(keyOf(id)); return;
          }
          message = { ...message, params: { ...message.params, name: prepared.tool, arguments: prepared.args } };
          line = JSON.stringify(message);
        } catch {
          clearTimeout(timer); entry.release?.(); entry.release = undefined;
          if (!entry.aborted) {
            this.fail("targetClosed", permit.owner);
            this.holdReply(connection, keyOf(id), entry);
          }
          if (!entry.held) connection.pending.delete(keyOf(id));
          return;
        }
      }
    }
    if (permit && call && this.options.confirmDispatch?.(call.tool, call.args, permit.owner) === false) {
      const entry = connection.pending.get(keyOf(id));
      if (entry) { clearTimeout(entry.timer); entry.release?.(); entry.release = undefined; }
      connection.pending.delete(keyOf(id));
      this.options.controller.finish(permit, "refused");
      this.deferConfirmation(connection, id, permit.owner); return;
    }
    if (!connection.child.stdin.write(`${line}\n`)) connection.socket.pause();
  }

  private deferConfirmation(connection: Connection, id: Rpc["id"], owner: string) {
    if (id === undefined) return;
    // Pause/revoke first; registering the held reply afterwards keeps desktop
    // pause cleanup from completing the ACP call before the human can answer.
    this.fail("confirmationRequired", owner);
    const pending: Pending = { method: "tools/call", timer: undefined as unknown as ReturnType<typeof setTimeout> };
    this.holdReply(connection, keyOf(id), pending, owner);
  }

  private waitOwnerReady(connection: Connection, owner: string): Promise<void> {
    if (this.options.tasks) return this.options.tasks.waitReady(owner, connection.lifetime.signal);
    const controller = this.options.controller;
    return new Promise((resolve, reject) => {
      let off = () => {};
      const finish = (error?: Error) => {
        clearTimeout(timer); off(); connection.lifetime.signal.removeEventListener("abort", aborted);
        if (error) reject(error); else resolve();
      };
      const aborted = () => finish(new Error("operationCancelled"));
      const check = () => {
        const state = controller.snapshot();
        if (!controller.owns(owner) || ["completed", "stopped", "failed"].includes(state.phase)
          || CUA_FINAL_REASONS.includes(state.reason ?? "")) finish(new Error("taskStopped"));
        else if (state.phase === "running" && !this.holding) finish();
      };
      const timer = setTimeout(() => finish(new Error("timeLimit")), 15 * 60_000);
      timer.unref(); off = controller.subscribe(check);
      connection.lifetime.signal.addEventListener("abort", aborted, { once: true });
      if (connection.lifetime.signal.aborted) aborted(); else check();
    });
  }

  /** Pause the tool's response as well as its actuator, so the ACP turn survives human handoff. */
  private holdReply(connection: Connection, key: string, pending: Pending, owner = pending.permit?.owner) {
    if (!owner || pending.held) return;
    clearTimeout(pending.timer);
    pending.held = true; pending.aborted = true; pending.call = undefined;
    connection.pending.set(key, pending);
    const id = key.startsWith("number:") ? Number(key.slice(7)) : key.slice(7);
    void this.waitOwnerReady(connection, owner).then(() => {
      if (connection.pending.get(key) !== pending || !pending.held) return;
      connection.pending.delete(key);
      this.reject(connection.socket, id, "operationPaused");
    }, () => {
      if (connection.pending.get(key) !== pending || !pending.held) return;
      connection.pending.delete(key);
      this.reject(connection.socket, id, "taskStopped");
    });
  }

  /** Revoke this task at the relay immediately; release its native lease only after drain acknowledgement. */
  holdOwner(owner: string, reason: string) {
    for (const connection of this.clients) if (connection.owner === owner) {
      for (const [key, pending] of connection.pending) if (pending.permit) {
        if (!["userStopped", "sessionEnded", "violationLimit", "disabled"].includes(reason)) this.holdReply(connection, key, pending);
        else {
          clearTimeout(pending.timer); pending.aborted = true; pending.held = false;
          this.reject(connection.socket, key.startsWith("number:") ? Number(key.slice(7)) : key.slice(7), reason);
        }
      }
    }
  }
  async ownerDrained(owner: string) {
    this.options.tasks?.releaseDrained(owner);
    for (const connection of this.clients) if (connection.owner === owner) {
      for (const [key, pending] of connection.pending) if (pending.aborted) {
        clearTimeout(pending.timer); pending.release?.(); pending.release = undefined;
        if (!pending.held) connection.pending.delete(key);
      }
    }
    await this.releaseOwner(owner);
  }

  cancelPending(reason: string) {
    for (const c of this.clients) for (const [key, pending] of c.pending) {
      if (!pending.permit) continue;
      const state = this.options.tasks?.stateForOwner(pending.permit.owner) ?? this.options.controller.snapshot();
      // Keep the ACP call open during a resumable desktop handoff. The helper
      // transport is still killed below; resuming returns only operationPaused.
      if (["userPaused", "operationCancelled"].includes(reason) && state.phase === "paused"
        && !CUA_FINAL_REASONS.includes(state.reason ?? "")) {
        this.holdReply(c, key, pending); continue;
      }
      clearTimeout(pending.timer);
      pending.held = false;
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
