import * as path from "node:path";
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
import * as electron from "electron";
import type { DesktopFeature, FeatureContext } from "../_kit/types";
import { DSH_IPC, type DshAction, type DshReply } from "@shared/features/dsh-runtime/contract";

interface RuntimeController {
  catalog(includeUnsupported?: boolean): Promise<Array<{ id: string; name: string; model: string }>>;
  authorize(ids: string[]): Promise<unknown>;
  start(): Promise<string>;
  stop(): Promise<void>;
  enabled(): boolean;
  disable(): Promise<void>;
  invalidate(): void;
  current(): boolean;
  status(): { phase: string; error?: string; available: boolean };
  scopeDir(): string;
  identity(): { accountId: string; origin: string; epoch: number } | null;
  on(event: string, handler: (...args: never[]) => void): void;
}
interface Desktop { open(visible?: boolean): Promise<void>; dispose(): void; endpoint(message: unknown): Promise<string>; }
interface RuntimeModule {
  RuntimeController: new(options: Record<string, unknown>) => RuntimeController;
  scopeKey(scope: unknown): string;
}
interface BrowserRequest { id: string; botId: string; downloadRoots: string[]; }

export const dshRuntimeFeature: DesktopFeature = {
  id: "dsh-runtime", products: ["nuwax"], enabledByDefault: true,
  register(ctx: FeatureContext) {
    let controller: RuntimeController | undefined;
    let desktop: Desktop | undefined;
    let desktopPort: number | undefined;
    let loading: Promise<RuntimeController> | undefined;
    let opening: Promise<void> | undefined;
    let disposed = false;
    const runtimeDir = electron.app.isPackaged
      ? path.join(process.resourcesPath, "dsh-runtime")
      : path.resolve(electron.app.getAppPath(), "../dsh-runtime");
    const officeDir = electron.app.isPackaged
      ? path.join(process.resourcesPath, "dsh-office")
      : path.join(electron.app.getAppPath(), "resources/dsh-office");
    const destroyWindow = () => {
      desktop?.dispose(); desktop = undefined;
      const port = desktopPort; desktopPort = undefined;
      if (port) void ctx.platform?.releasePort(port).catch(() => ctx.log.warn("[DSH] Private port cleanup failed"));
    };
    const load = (): Promise<RuntimeController> => loading ??= (async () => {
      if (!ctx.platform) throw new Error("Platform integration unavailable");
      if (!fs.existsSync(path.join(runtimeDir, "host.mjs"))) throw new Error(electron.app.isPackaged ? "Plugin runtime resources are missing; repair the client installation" : "DSH resources missing; run prepare:dsh");
      const api = await import(pathToFileURL(path.join(runtimeDir, "controller.mjs")).href) as RuntimeModule;
      if (disposed) throw new Error("Plugin runtime is disposed");
      const runtime = new api.RuntimeController({
        platform: ctx.platform, settings: ctx.settings, runtimeDir, officeDir, dataDir: ctx.dataDir,
        node: () => { const node = ctx.agent.resolveNodeBinary(); if (!node) throw new Error("Bundled Node unavailable"); return node; },
        env: () => ctx.platform!.environment(), allocatePort: () => ctx.platform!.allocatePort(), releasePort: (port: number) => ctx.platform!.releasePort(port),
      });
      runtime.on("invalidated", destroyWindow);
      runtime.on("browser-endpoint", ((message: BrowserRequest, reply: (result: { url?: string; error?: string }) => void) => {
        if (!desktop) { reply({ error: "Open the DS-Bot window first" }); return; }
        void desktop.endpoint(message).then(url => reply({ url }), () => reply({ error: "Browser endpoint unavailable" }));
      }) as (...args: never[]) => void);
      controller = runtime;
      return runtime;
    })().catch(error => { loading = undefined; throw error; });
    const open = (visible = true): Promise<void> => {
      if (opening) return opening.then(() => { if (visible) return desktop?.open(); });
      opening = (async () => {
        const runtime = await load();
        const url = await runtime.start();
        if (!runtime.current()) throw new Error("Account changed");
        if (!desktop) {
          const api = await import(pathToFileURL(path.join(runtimeDir, "desktop.mjs")).href) as {
            createDesktop(options: Record<string, unknown>): Desktop;
          };
          const { scopeKey } = await import(pathToFileURL(path.join(runtimeDir, "controller.mjs")).href) as RuntimeModule;
          if (!runtime.current()) throw new Error("Account changed");
          const port = await ctx.platform!.allocatePort();
          try {
            if (!runtime.current()) throw new Error("Account changed");
            desktop = api.createDesktop({ electron, runtimeDir, scopeDir: runtime.scopeDir(),
              namespace: scopeKey(runtime.identity()), port, launchUrl: url, current: () => runtime.current() });
            desktopPort = port;
          } catch (error) { await ctx.platform!.releasePort(port); throw error; }
        }
        await desktop.open(visible);
      })().finally(() => { opening = undefined; });
      return opening;
    };
    ctx.hostIpc.handle<unknown, [DshAction, string[]?], DshReply>(DSH_IPC, async (_event, action, ids) => {
      try {
        if (!ctx.session.isAuthenticated()) throw new Error("Login required");
        const runtime = await load();
        if (action === "catalog") return { ok: true, models: await runtime.catalog(true) };
        if (action === "authorize") { await runtime.authorize(ids ?? []); return { ok: true, status: runtime.status() }; }
        if (action === "open") await open();
        else if (action === "stop") await runtime.disable();
        else if (action !== "status") throw new Error("Unknown plugin action");
        return { ok: true, status: runtime.status() };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "Plugin operation failed" };
      }
    }, { ok: false, error: "Untrusted window" });
    const stop = async () => { controller?.invalidate(); destroyWindow(); await controller?.stop(); };
    const off = [
      ctx.lifecycle.onSessionInvalidated(() => { controller?.invalidate(); destroyWindow(); }),
      ctx.lifecycle.onServicesStopping(stop), ctx.lifecycle.onSessionEnd(() => { void stop(); }),
      ctx.lifecycle.onQuit(stop),
      ctx.lifecycle.onServicesStarting(async () => {
        try {
          const runtime = await load();
          if (runtime.enabled()) await open(false);
        } catch { ctx.log.warn("[DSH] Runtime could not resume; open its settings to retry"); }
      }),
    ];
    return { async dispose() { disposed = true; off.forEach(dispose => dispose()); await stop(); ctx.hostIpc.dispose(); } };
  },
};
