import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FeatureAccountScope, FeatureContext, FeatureMcpServerEntry } from "../_kit/types";
import type { AgentSessionParticipant } from "../_kit/agentSessions";
import { ShellMcpGateway, SHELL_STDIO_RELAY } from "../_kit/mcpTransport";
import { WORKBENCH_MCP } from "@shared/features/workbench/contract";

export interface WorkbenchPorts {
  allowed(): boolean;
  open(conversationId: string, signal: AbortSignal): Promise<unknown>;
  command(conversationId: string, operation: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  plugins(operation: string, input: unknown, signal: AbortSignal): Promise<unknown>;
}
interface Grant {
  secret: string;
  file: string;
  conversationId: string | null;
  turn: number;
  abort: AbortController;
}

/** One transport credential per ACP session, with permission checked on every operation. */
export class WorkbenchMcp {
  private readonly grants = new Map<string, Grant>();
  private readonly cleanup: Array<() => void>;
  private directory?: string;
  private gateway?: ShellMcpGateway;
  private entry?: FeatureMcpServerEntry;
  private generation = 0;
  private scope?: FeatureAccountScope;
  private disposed = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly ctx: FeatureContext, private readonly ports: WorkbenchPorts) {
    this.cleanup = [
      ctx.agent.registerSessionParticipant(() => this.participant()),
      ctx.lifecycle.onSessionInvalidated(() => { this.revokeTurns(); void this.reconcile(false); }),
      ctx.lifecycle.onServicesStopping(() => this.reconcile(false)),
      ctx.lifecycle.onServicesStarting(() => this.reconcile(true)),
      ctx.lifecycle.onSessionEnd(() => { void this.reconcile(false); }),
    ];
    void this.reconcile(true);
  }

  private participant(): AgentSessionParticipant {
    const sessions = new Map<string, Grant>();
    const pending = new Set<Grant>();
    const remove = (sessionId: string) => { this.remove(sessions.get(sessionId)); sessions.delete(sessionId); };
    return {
      prepare: servers => {
        const index = servers.findIndex(server => server.name === WORKBENCH_MCP);
        let grant: Grant | undefined;
        if (index >= 0) {
          if (!this.entry || !this.directory || !this.gateway?.ready) servers.splice(index, 1);
          else {
            if (this.grants.size >= 256) throw new Error("Workbench session capacity reached");
            const secret = randomBytes(32).toString("hex");
            const file = path.join(this.directory, randomUUID() + ".cap");
            fs.writeFileSync(file, secret, { mode: 0o600, flag: "wx" });
            grant = { secret, file, conversationId: null, turn: 0, abort: new AbortController() };
            grant.abort.abort();
            this.grants.set(secret, grant); pending.add(grant);
            servers[index] = { name: WORKBENCH_MCP, command: this.entry.command, args: this.entry.args,
              env: Object.entries({ ...this.entry.env, NUWAX_SHELL_TOKEN_FILE: file }).map(([name, value]) => ({ name, value })) };
          }
        }
        return {
          bind: id => { if (grant && pending.delete(grant)) { remove(id); sessions.set(id, grant); } },
          cancel: () => { if (grant) { pending.delete(grant); this.remove(grant); } },
        };
      },
      start: id => {
        const grant = sessions.get(id);
        if (!grant || !this.grants.has(grant.secret)) return 0;
        grant.abort.abort(); grant.abort = new AbortController();
        grant.conversationId = this.ctx.agent.resolveConversationId?.(id) ?? null;
        return ++grant.turn;
      },
      finish: (id, turn) => { const grant = sessions.get(id); if (grant?.turn === turn) grant.abort.abort(); },
      cancel: id => sessions.get(id)?.abort.abort(),
      remove,
      destroy: () => { for (const grant of pending) this.remove(grant); for (const grant of sessions.values()) this.remove(grant); pending.clear(); sessions.clear(); },
    };
  }
  private remove(grant?: Grant) {
    if (!grant) return;
    grant.abort.abort(); this.grants.delete(grant.secret);
    try { fs.rmSync(grant.file, { force: true }); } catch { /* Memory revocation is immediate. */ }
  }
  revokeTurns() { for (const grant of this.grants.values()) grant.abort.abort(); }
  private server(secret: string, generation: number): McpServer {
    const server = new McpServer({ name: WORKBENCH_MCP, version: "0.1.0" });
    const authorize = () => {
      const grant = this.grants.get(secret);
      const scope = this.ctx.platform?.scope();
      if (this.disposed || generation !== this.generation || !this.ctx.session.isAuthenticated() || !this.ports.allowed() ||
          !scope || scope.accountId !== this.scope?.accountId || scope.origin !== this.scope?.origin || scope.epoch !== this.scope?.epoch ||
          !grant?.conversationId || grant.abort.signal.aborted) throw new Error("Workbench access requires an authorized active conversation");
      return grant;
    };
    const register = server.registerTool.bind(server) as unknown as (name: string,
      config: { description: string; inputSchema: z.AnyZodObject; annotations: { readOnlyHint: boolean } },
      callback: (args: unknown, extra: { signal: AbortSignal }) => Promise<{ isError?: boolean; content: Array<{ type: "text"; text: string }> }>) => void;
    const tool = (name: string, description: string, schema: z.ZodRawShape, operation: string) => {
      register(name, { description, inputSchema: z.object(schema).strict(), annotations: { readOnlyHint: operation === "state" || operation === "plugins" } }, async (input, extra) => {
        try {
          const grant = authorize();
          const signal = AbortSignal.any([extra.signal, grant.abort.signal]);
          const args = z.object(schema).strict().parse(input);
          if (operation === "preset" && args.action !== "list" &&
              (typeof args.name !== "string" || args.expectedRevision === undefined || typeof args.expectedVersion !== "string"))
            throw new Error("Layout name, catalog revision and current layout version are required");
          let value: unknown;
          if (operation === "bind") value = await this.ports.open(grant.conversationId!, signal);
          else if (operation === "plugins") value = await this.ports.plugins("list", {}, signal);
          else if (operation === "plugin-configure") value = await this.ports.plugins("configure", args, signal);
          else value = await this.ports.command(grant.conversationId!, operation, args, signal);
          signal.throwIfAborted();
          authorize();
          return { content: [{ type: "text", text: JSON.stringify(value) }] };
        } catch (error) {
          return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Workbench operation failed" }] };
        }
      });
    };
    tool("workbench_open", "Open the DSH plugin workbench for this ACP conversation's local workspace. The host determines session and directory ownership.", {}, "bind");
    tool("workbench_state", "Read the actual mounted session and open plugin panels. Open this conversation's workbench first.", {}, "state");
    tool("workbench_plugins", "List the native DSH bundles and their actual installed and enabled state in the workbench profile.", {}, "plugins");
    tool("workbench_plugin_configure", "Update an installed workbench plugin's public settings using its namespace and revision from workbench_plugins. Private settings and core runtime configuration are protected.", {
      target: z.string().min(1).max(200), expectedRevision: z.number().int().nonnegative(), patch: z.record(z.unknown()),
    }, "plugin-configure");
    tool("workbench_layout_preset", "Save, list, restore or delete named layouts for this conversation. List returns the saved-layout revision; save, apply and remove require expectedRevision (null only before the first state write) and expectedVersion from workbench_state. Restore preserves existing resources and reopens closed panels. User layout locks take precedence.", {
      action: z.enum(["list", "save", "apply", "remove"]), name: z.string().trim().min(1).max(80).optional(),
      expectedRevision: z.string().uuid().nullable().optional(), expectedVersion: z.string().uuid().optional(),
    }, "preset");
    tool("workbench_open_panel", "Open a registered DSH panel in this conversation. Files and terminal are supplied by DSH; browser uses the Nuwax desktop provider.", {
      expectedVersion: z.string().uuid(), kind: z.string().min(1).max(160), params: z.object({ url: z.string().url().max(4096).optional() }).strict().optional(),
    }, "open");
    tool("workbench_open_file", "Preview a workspace-relative file through the registered DSH file viewer.", { expectedVersion: z.string().uuid(), path: z.string().min(1).max(4096) }, "open-file");
    tool("workbench_close_panel", "Close a tab owned by this conversation, using its tabId from workbench_state.", { expectedVersion: z.string().uuid(), tabId: z.string().min(1).max(200) }, "close");
    tool("workbench_set_visible", "Expand or collapse this conversation's plugin sidebar. Hiding preserves the underlying resource lifetime.", { expectedVersion: z.string().uuid(), visible: z.boolean() }, "visibility");
    tool("workbench_layout", "Move, float, resize, dock or split native DSH panels and undo/redo layout changes. Read the actual layout and layoutVersion first. User layout locks take precedence.", {
      expectedVersion: z.string().uuid(), action: z.enum(["float", "dock", "move", "resize", "resize-split", "split", "undo", "redo"]),
      tabId: z.string().min(1).max(200).optional(), paneId: z.string().min(1).max(200).optional(),
      splitId: z.string().min(1).max(200).optional(), sizes: z.array(z.number().min(0.2).max(0.8)).length(2).optional(),
      zone: z.enum(["center", "left", "right"]).optional(),
      rect: z.object({ x: z.number().min(0).max(10000), y: z.number().min(0).max(10000), width: z.number().min(200).max(10000), height: z.number().min(120).max(10000) }).strict().optional(),
    }, "layout");
    tool("workbench_browser", "Read or operate this conversation's actual browser page. Use state to discover tab IDs. User takeover blocks Agent actions until the user releases control.", {
      action: z.enum(["state", "read", "navigate", "click"]), tabId: z.string().min(1).max(200).optional(),
      url: z.string().url().max(4096).optional(), selector: z.string().min(1).max(2000).optional(),
    }, "browser");
    tool("workbench_terminal", "Inspect or send input to this conversation's existing DSH terminal tab. A write acknowledges queued input; inspect the terminal for its command result.", {
      action: z.enum(["state", "write"]), tabId: z.string().min(1).max(200), data: z.string().min(1).max(16384).optional(),
    }, "terminal");
    return server;
  }
  private reconcile(start: boolean): Promise<void> {
    const generation = ++this.generation;
    this.revokeTurns(); this.gateway?.revoke(); this.entry = undefined;
    const work = this.queue.catch(() => {}).then(async () => {
      await this.gateway?.close(); this.gateway = undefined;
      for (const grant of [...this.grants.values()]) this.remove(grant);
      if (this.directory) { fs.rmSync(this.directory, { recursive: true, force: true }); this.directory = undefined; }
      await this.ctx.agent.setLocalMcpServer(WORKBENCH_MCP, null);
      if (!start || this.disposed || generation !== this.generation || !this.ctx.session.isAuthenticated()) return;
      const scope = this.ctx.platform?.scope();
      if (!scope) return;
      this.scope = { ...scope };
      const node = this.ctx.agent.resolveNodeBinary();
      if (!node) throw new Error("Bundled Node unavailable");
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), this.ctx.product + "-workbench-"));
      fs.chmodSync(directory, 0o700); this.directory = directory;
      const socket = process.platform === "win32" ? `\\\\.\\pipe\\${this.ctx.product}-workbench-${randomUUID()}` : path.join(directory, "mcp.sock");
      const discovery = randomBytes(32).toString("hex"), tokenFile = path.join(directory, "discovery.cap");
      fs.writeFileSync(tokenFile, discovery, { mode: 0o600, flag: "wx" });
      const gateway = new ShellMcpGateway(secret => this.server(secret, generation));
      this.gateway = gateway;
      await gateway.listen(socket, secret => generation === this.generation && (secret === discovery || this.grants.has(secret)));
      if (generation !== this.generation || this.disposed) { await gateway.close(); return; }
      const entry: FeatureMcpServerEntry = { command: node, args: ["-e", SHELL_STDIO_RELAY], enabled: true,
        env: { NUWAX_SHELL_SOCKET: socket, NUWAX_SHELL_TOKEN_FILE: tokenFile } };
      this.entry = entry;
      await this.ctx.agent.setLocalMcpServer(WORKBENCH_MCP, entry);
      if (generation !== this.generation) this.entry = undefined;
    }).catch(async () => {
      if (generation !== this.generation) return;
      this.entry = undefined;
      await this.gateway?.close(); this.gateway = undefined;
      this.ctx.log.warn("[Workbench] MCP unavailable");
    });
    this.queue = work;
    return work;
  }
  async dispose() {
    this.disposed = true;
    this.cleanup.forEach(off => off());
    await this.reconcile(false);
  }
}
