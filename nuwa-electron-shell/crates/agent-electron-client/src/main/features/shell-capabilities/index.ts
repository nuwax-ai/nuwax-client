import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { DesktopFeature, FeatureContext, FeatureMcpServerEntry } from "../_kit/types";
import type { ThemeService } from "../themes/service";
import { themeError } from "../themes/service";
import { SHELL_ACCESS_SETTING, SHELL_CAPABILITIES_IPC, SHELL_MCP_SERVER, type ShellAccess, type ShellCapabilitiesState, type ShellDomain, type ShellChange } from "@shared/features/shell-capabilities/contract";
import { ShellMcpGateway, SHELL_STDIO_RELAY } from "./transport";
import { createShellMcpServer, type ShellToolPorts } from "./tools";

const accessSchema = z.object({ themes: z.boolean(), settings: z.boolean(), extensions: z.boolean() }).strict();
const noAccess = (): ShellAccess => ({ themes: false, settings: false, extensions: false });
const changesSchema = z.array(z.object({ id: z.string().uuid(), at: z.string(), domain: z.enum(["themes", "settings", "extensions"]), operation: z.string().max(100), status: z.enum(["applied", "saved", "failed", "canceled"]) })).max(50);
const listeners = new Set<() => void>();
let currentEntry: FeatureMcpServerEntry | null = null;
export const getShellMcpEntry = () => currentEntry ? structuredClone(currentEntry) : null;
export function subscribeShellMcp(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function publish(entry: FeatureMcpServerEntry | null) {
  currentEntry = entry;
  for (const listener of listeners) { try { listener(); } catch { /* isolate runtime consumers */ } }
}
export interface ShellCapabilityPorts {
  themes(): ThemeService | null;
  plugins?: ShellToolPorts["plugins"];
}

export class ShellCapabilitiesRuntime {
  private access: ShellAccess;
  private generation = 0;
  private active = false;
  private disposed = false;
  private permissionWriteFailed = false;
  private error?: string;
  private gateway?: ShellMcpGateway;
  private queue: Promise<unknown> = Promise.resolve();
  private cleanup: Array<() => void> = [];
  constructor(private ctx: FeatureContext, private ports: ShellCapabilityPorts) {
    this.access = this.readAccess();
    ctx.hostIpc.handle(SHELL_CAPABILITIES_IPC, async (_event, action: unknown, input?: unknown) => {
      if (action === "state") return this.state();
      if (action === "access") return this.setAccess(accessSchema.parse(input));
      if (action === "restore") {
        const { historyId, expectedRevision } = z.object({ historyId: z.string().uuid(), expectedRevision: z.number().int().positive() }).strict().parse(input);
        const service = this.ports.themes();
        if (!service) throw new Error("Themes unavailable");
        const item = service.history().find(row => row.id === historyId);
        if (!item) throw new Error("Theme history unavailable");
        const files = await service.readForEdit(item.themeId);
        await service.restore({ historyId, expectedRevision, expectedVersion: files.version });
        return;
      }
      throw new Error("Unknown shell capability action");
    }, null);
    this.cleanup = [
      ctx.lifecycle.onSessionInvalidated(() => { this.revoke(); void this.reconcile(false); }),
      ctx.lifecycle.onSessionEnd(() => { this.revoke(); void this.reconcile(false); }),
      ctx.lifecycle.onServicesStopping(() => { this.revoke(); return this.reconcile(false); }),
      ctx.lifecycle.onServicesStarting(() => this.reconcile(true)),
      ctx.lifecycle.onQuit(() => this.dispose()),
    ];
    void this.reconcile(true);
  }
  state(): ShellCapabilitiesState {
    return { access: this.permissionWriteFailed ? noAccess() : this.readAccess(), ready: this.active && this.gateway?.ready === true,
      ...(this.error ? { error: this.error } : {}), history: this.ports.themes()?.history() ?? [], changes: this.changes(this.scopeKey()) };
  }
  private scopeKey() {
    const scope = this.ctx.platform?.scope();
    return scope ? createHash("sha256").update(scope.origin + "\n" + scope.accountId).digest("hex") : null;
  }
  private readAccess(): ShellAccess {
    const key = this.scopeKey();
    const saved = key ? accessSchema.safeParse(this.ctx.settings.read(`${SHELL_ACCESS_SETTING}.${key}`)) : null;
    return saved?.success ? saved.data : noAccess();
  }
  private changes(key: string | null): ShellChange[] {
    const saved = key ? changesSchema.safeParse(this.ctx.settings.read(`shellCapabilities.changes.${key}`)) : null;
    return saved?.success ? saved.data : [];
  }
  private record(key: string, change: Pick<ShellChange, "domain" | "operation" | "status">) {
    const changes = [{ ...change, id: randomUUID(), at: new Date().toISOString() }, ...this.changes(key)].slice(0, 50);
    try {
      if (!this.ctx.settings.write(`shellCapabilities.changes.${key}`, changes)) this.error = "Shell change history could not be saved";
    } catch { this.error = "Shell change history could not be saved"; }
  }
  setAccess(access: ShellAccess) {
    if (this.disposed) return Promise.reject(new Error("Shell capabilities disposed"));
    const parsed = accessSchema.parse(access);
    const key = this.scopeKey();
    if (!key || !this.ctx.session.isAuthenticated()) return Promise.reject(new Error("Sign in before authorizing Agent access"));
    this.revoke();
    if (!this.ctx.settings.write(`${SHELL_ACCESS_SETTING}.${key}`, parsed)) {
      this.permissionWriteFailed = true;
      this.access = noAccess();
      void this.reconcile(false);
      return Promise.reject(new Error("Shell capability permissions could not be saved"));
    }
    this.permissionWriteFailed = false;
    this.access = parsed;
    return this.reconcile(true).then(() => this.state());
  }
  private revoke() {
    this.generation++;
    this.active = false;
    this.gateway?.revoke();
    publish(null);
  }
  private reconcile(allowStart: boolean): Promise<void> {
    this.revoke();
    if (allowStart) this.access = this.readAccess();
    const generation = this.generation;
    const work = this.queue.catch(() => undefined).then(async () => {
      await this.gateway?.close().catch(() => undefined); this.gateway = undefined;
      await this.ctx.agent.setLocalMcpServer(SHELL_MCP_SERVER, null);
      if (this.disposed || this.permissionWriteFailed || !allowStart || generation !== this.generation || !this.ctx.session.isAuthenticated() || !Object.values(this.access).some(Boolean)) return;
      const node = this.ctx.agent.resolveNodeBinary();
      if (!node) throw new Error("Bundled Node unavailable");
      const scope = this.ctx.platform?.scope();
      if (!scope) throw new Error("A current account is required for shell capabilities");
      const current = (domain?: ShellDomain) => {
        const identity = this.ctx.platform?.scope();
        if (this.disposed || !this.active || generation !== this.generation || !this.ctx.session.isAuthenticated() ||
            !identity || identity.accountId !== scope.accountId || identity.origin !== scope.origin || identity.epoch !== scope.epoch ||
            (domain && !this.access[domain])) throw new Error("Shell capability authorization expired");
      };
      const access = { ...this.access };
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), `${this.ctx.product}-shell-`));
      await fs.chmod(directory, 0o700);
      const socket = process.platform === "win32" ? `\\\\.\\pipe\\${this.ctx.product}-shell-${randomUUID()}` : path.join(directory, "mcp.sock");
      const tokenFile = path.join(directory, "token");
      const token = randomBytes(32).toString("hex");
      await fs.writeFile(tokenFile, token, { mode: 0o600, flag: "wx" });
      const key = this.scopeKey()!;
      const gateway = new ShellMcpGateway(() => createShellMcpServer(access, { ...this.ports, settings: this.ctx.settings, check: current,
        record: change => this.record(key, change) }));
      const originalClose = gateway.close.bind(gateway);
      gateway.close = async () => { await originalClose(); await fs.rm(directory, { recursive: true, force: true }); };
      this.gateway = gateway;
      await gateway.listen(socket, token);
      if (generation !== this.generation || this.disposed) { await gateway.close(); return; }
      this.active = true; current();
      const entry: FeatureMcpServerEntry = { command: node, args: ["-e", SHELL_STDIO_RELAY], enabled: true,
        env: { NUWAX_SHELL_SOCKET: socket, NUWAX_SHELL_TOKEN_FILE: tokenFile } };
      await this.ctx.agent.setLocalMcpServer(SHELL_MCP_SERVER, entry);
      current();
      this.error = undefined;
      publish(entry);
    }).catch(async error => {
      if (generation !== this.generation) return;
      this.revoke();
      await this.gateway?.close().catch(() => undefined); this.gateway = undefined;
      this.error = themeError(error);
      this.ctx.log.warn("[Shell capabilities] MCP unavailable");
    });
    this.queue = work;
    return work;
  }
  async dispose() {
    if (this.disposed) return;
    this.disposed = true; this.revoke();
    for (const off of this.cleanup.splice(0)) off();
    await this.reconcile(false);
    this.ctx.hostIpc.dispose();
  }
}

export function createShellCapabilitiesFeature(ports: ShellCapabilityPorts): DesktopFeature {
  return { id: "shell-capabilities", products: ["nuwax"], enabledByDefault: true, agentServers: [SHELL_MCP_SERVER],
    register: ctx => new ShellCapabilitiesRuntime(ctx, ports) };
}
