import * as path from "node:path";
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import * as electron from "electron";
import type { DesktopFeature, FeatureContext } from "../_kit/types";
import { WORKBENCH_IPC, WORKBENCH_OPEN_IPC, WORKBENCH_MCP, type WorkbenchReply, type WorkbenchState } from "@shared/features/workbench/contract";
import { WorkbenchMcp } from "./mcp";

interface Binding { sessionId: string; conversationId: string; cwd: string; }
interface Controller {
  start(): Promise<string>;
  stop(): Promise<void>;
  invalidate(): void;
  current(): boolean;
  scopeDir(): string;
  status(): { phase: string; error?: string };
  identity(): { accountId: string; origin: string; epoch: number } | null;
  syncLanguage(): void;
  workbench(operation: string, input: unknown, signal: AbortSignal): Promise<Binding>;
  plugins(operation: string, input: unknown, signal: AbortSignal): Promise<unknown>;
  on(event: string, listener: () => void): void;
}
interface Desktop {
  open(visible?: boolean): Promise<void>;
  dispose(): void;
  workbench(operation: string, input: unknown, signal: AbortSignal): Promise<unknown>;
  browser(input: Record<string, unknown>): Promise<unknown>;
}

/** The trusted feature owns accounts and native windows; DSH owns plugin execution. */
export class WorkbenchRuntime {
  private controller?: Controller;
  private desktop?: Desktop;
  private loading?: Promise<Controller>;
  private opening?: Promise<void>;
  private browserPort?: number;
  private generation = 0;
  private disposed = false;
  private accessWriteFailed = false;
  private readonly mcp: WorkbenchMcp;
  private readonly cleanup: Array<() => void>;
  private readonly bindings = new Map<string, Binding>();

  constructor(private readonly ctx: FeatureContext) {
    this.mcp = new WorkbenchMcp(ctx, {
      allowed: () => this.state().agentAccess,
      open: (conversationId, signal) => this.open(conversationId, signal),
      command: (conversationId, operation, input, signal) => this.command(conversationId, operation, input, signal),
      plugins: (operation, input, signal) => this.plugins(operation, input, signal),
    });
    ctx.ipc.handle(WORKBENCH_OPEN_IPC, async (event, cId: unknown): Promise<WorkbenchReply> => {
      try {
        if (!ctx.workspace?.isCurrentDocument(event)) throw new Error("Untrusted workbench document");
        await this.open(this.conversationId(cId), new AbortController().signal);
        return { ok: true };
      } catch (error) { return { ok: false, error: this.error(error) }; }
    }, { ok: false, error: "Untrusted window" });
    ctx.hostIpc.handle(WORKBENCH_IPC, async (_event, action: unknown, enabled: unknown): Promise<WorkbenchReply> => {
      try {
        if (action === "access") {
          if (typeof enabled !== "boolean") throw new Error("Invalid workbench access");
          const key = this.accessKey();
          if (!key || !ctx.session.isAuthenticated()) throw new Error("Login required");
          this.mcp.revokeTurns();
          this.accessWriteFailed = true;
          if (!ctx.settings.write(key, enabled)) throw new Error("Workbench authorization could not be saved");
          this.accessWriteFailed = false;
        } else if (action === "stop") await this.stop();
        else if (action !== "state") throw new Error("Unknown workbench action");
        return { ok: true, state: this.state() };
      } catch (error) { return { ok: false, error: this.error(error) }; }
    }, { ok: false, error: "Untrusted window" });
    this.cleanup = [
      ctx.lifecycle.onSessionInvalidated(() => this.invalidate()),
      ctx.lifecycle.onSessionEnd(() => { void this.stop(); }),
      ctx.lifecycle.onServicesStopping(() => this.stop()),
      ctx.lifecycle.onQuit(() => this.stop()),
      ctx.locale?.subscribe(() => this.controller?.syncLanguage()) ?? (() => {}),
    ];
  }

  private error(error: unknown) { return error instanceof Error ? error.message : "Workbench operation failed"; }
  private conversationId(value: unknown): string {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new Error("Invalid conversation identity");
    return value;
  }
  private accessKey(): string | null {
    const scope = this.ctx.platform?.scope();
    return scope ? "workbench.agentAccess." + createHash("sha256").update(scope.origin + "\n" + scope.accountId).digest("hex") : null;
  }
  state(): WorkbenchState {
    const key = this.accessKey();
    return { available: !!this.ctx.platform, agentAccess: !this.accessWriteFailed && !!key && this.ctx.settings.read(key) === true,
      phase: this.controller?.status().phase ?? "stopped", error: this.controller?.status().error };
  }
  private assertCurrent(generation: number, signal: AbortSignal) {
    if (this.disposed || signal.aborted || generation !== this.generation || !this.ctx.session.isAuthenticated()) throw new Error("Workbench authorization expired");
  }
  private load(): Promise<Controller> {
    return this.loading ??= (async () => {
      if (!this.ctx.platform) throw new Error("Platform integration unavailable");
      const runtimeDir = electron.app.isPackaged ? path.join(process.resourcesPath, "dsh-runtime") : path.join(electron.app.getAppPath(), "resources/dsh-runtime");
      if (!fs.existsSync(path.join(runtimeDir, "workbench-host.mjs"))) throw new Error("Workbench resources unavailable; run prepare:dsh");
      const api = await import(pathToFileURL(path.join(runtimeDir, "controller.mjs")).href);
      if (this.disposed) throw new Error("Workbench is disposed");
      const controller: Controller = new api.RuntimeController({
        mode: "workbench", runtimeDir, dataDir: this.ctx.dataDir, platform: this.ctx.platform, settings: this.ctx.settings,
        language: () => this.ctx.locale?.current() ?? "zh-CN",
        node: () => { const node = this.ctx.agent.resolveNodeBinary(); if (!node) throw new Error("Bundled Node unavailable"); return node; },
        env: () => this.ctx.platform!.environment(),
        allocatePort: () => this.ctx.platform!.allocatePort(),
        releasePort: (port: number) => this.ctx.platform!.releasePort(port),
      });
      controller.on("invalidated", () => this.destroyWindow());
      this.controller = controller;
      return controller;
    })().catch(error => { this.loading = undefined; throw error; });
  }
  private ensureWindow(): Promise<void> {
    const generation = this.generation;
    return this.opening ??= (async () => {
      const controller = await this.load();
      if (generation !== this.generation || this.disposed) throw new Error("Workbench start canceled");
      const url = await controller.start();
      if (generation !== this.generation || !controller.current() || this.disposed) throw new Error("Account changed");
      if (!this.desktop) {
        const runtimeDir = electron.app.isPackaged ? path.join(process.resourcesPath, "dsh-runtime") : path.join(electron.app.getAppPath(), "resources/dsh-runtime");
        const api = await import(pathToFileURL(path.join(runtimeDir, "desktop.mjs")).href);
        const port = await this.ctx.platform!.allocatePort();
        try {
          if (generation !== this.generation || !controller.current() || this.disposed) throw new Error("Account changed");
          const scope = controller.identity()!;
          const namespace = createHash("sha256").update(JSON.stringify([scope.origin, scope.accountId, "workbench"])).digest("hex");
          this.desktop = api.createDesktop({ electron, mode: "workbench", runtimeDir, scopeDir: controller.scopeDir(), namespace,
            port, launchUrl: url, current: () => controller.current(), language: () => this.ctx.locale?.current() ?? "zh-CN" });
          this.browserPort = port;
        } catch (error) { await this.ctx.platform!.releasePort(port); throw error; }
      }
      await this.desktop!.open(false);
    })().finally(() => { this.opening = undefined; });
  }
  async open(conversationId: string, signal: AbortSignal): Promise<Binding> {
    const generation = this.generation;
    this.assertCurrent(generation, signal);
    this.conversationId(conversationId);
    if (!this.ctx.workspace?.getIdentity()) throw new Error("Local workspace service is not ready; retry when ready");
    const cwd = await this.ctx.workspace.resolveRoot({ cId: conversationId });
    this.assertCurrent(generation, signal);
    if (!cwd) throw new Error("Local workspace could not be resolved; retry when ready");
    const controller = await this.load();
    this.assertCurrent(generation, signal);
    await controller.start();
    this.assertCurrent(generation, signal);
    const binding = await controller.workbench("bind", { conversationId, cwd }, signal);
    this.assertCurrent(generation, signal);
    await this.ensureWindow();
    this.assertCurrent(generation, signal);
    await this.desktop!.workbench("bind", binding, signal);
    this.assertCurrent(generation, signal);
    await this.desktop!.open();
    this.bindings.set(conversationId, binding);
    return binding;
  }
  async command(conversationId: string, operation: string, input: Record<string, unknown>, signal: AbortSignal) {
    const generation = this.generation;
    this.assertCurrent(generation, signal);
    const binding = this.bindings.get(conversationId);
    if (!binding || !this.controller?.current() || !this.desktop) throw new Error("Open this conversation's workbench first");
    const request = { ...input, sessionId: binding.sessionId, actor: "agent" };
    const value = operation === "browser" ? await this.desktop.browser(request) : await this.desktop.workbench(operation, request, signal);
    this.assertCurrent(generation, signal);
    return value;
  }
  private async plugins(operation: string, input: unknown, signal: AbortSignal) {
    if (!this.controller?.current()) throw new Error("Open the workbench first");
    return this.controller.plugins(operation, input, signal);
  }
  private destroyWindow() {
    this.desktop?.dispose(); this.desktop = undefined;
    this.bindings.clear();
    const port = this.browserPort; this.browserPort = undefined;
    if (port) void this.ctx.platform?.releasePort(port).catch(() => this.ctx.log.warn("[Workbench] Port cleanup failed"));
  }
  private invalidate() { this.generation++; this.mcp.revokeTurns(); this.controller?.invalidate(); this.destroyWindow(); }
  private async stop() { this.invalidate(); await this.controller?.stop(); }
  async dispose() {
    this.disposed = true;
    this.cleanup.forEach(off => off());
    await this.stop(); await this.mcp.dispose();
    this.ctx.ipc.dispose(); this.ctx.hostIpc.dispose();
  }
}

export const workbenchFeature: DesktopFeature = {
  id: "workbench", products: ["nuwax"], enabledByDefault: true,
  bridge: { namespaces: ["workbench"] }, agentServers: [WORKBENCH_MCP],
  register: ctx => new WorkbenchRuntime(ctx),
};
