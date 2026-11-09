import { DSH_LAUNCHER_OPEN, DSH_LAUNCHER_STATE, DSH_PLUGINS_IPC, type DshPluginOperation, type DshPluginReply } from "@shared/features/dsh-runtime/contract";
import type { FeatureContext } from "../_kit/types";

/** 业务页仅有状态和唤起入口，不能通过快捷入口授权模型或启用运行时。 */
export function registerDshLauncher(ctx: FeatureContext, ports: {
  load(): Promise<{ enabled(): boolean }>;
  open(): Promise<void>;
}) {
  const scopeKey = () => {
    const scope = ctx.platform?.scope();
    return ctx.session.isAuthenticated() && scope
      ? JSON.stringify([scope.origin, scope.accountId, scope.epoch]) : null;
  };
  ctx.ipc.handle(DSH_LAUNCHER_STATE, async () => {
    const scope = scopeKey();
    if (!scope) return null;
    try {
      const runtime = await ports.load();
      return scopeKey() === scope ? { enabled: runtime.enabled() } : null;
    } catch { return null; }
  }, null);
  ctx.ipc.handle(DSH_LAUNCHER_OPEN, async () => {
    const scope = scopeKey();
    if (!scope) return { ok: false };
    try {
      const runtime = await ports.load();
      if (scopeKey() !== scope || !runtime.enabled()) return { ok: false };
      await ports.open();
      return { ok: scopeKey() === scope };
    } catch { return { ok: false }; }
  }, { ok: false });
}

export function registerDshPluginSettings(ctx: FeatureContext, runtime: () => {
  current(): boolean;
  plugins(operation: string, input: unknown, signal: AbortSignal): Promise<unknown>;
} | undefined) {
  ctx.hostIpc.handle<unknown, [DshPluginOperation, unknown?], DshPluginReply>(DSH_PLUGINS_IPC, async (_event, operation, input) => {
    try {
      const controller = runtime();
      if (!ctx.session.isAuthenticated() || !controller?.current()) throw new Error("Open DS Bot before managing plugins");
      if (!["list", "install", "enable", "disable", "remove", "configure"].includes(operation)) throw new Error("Unsupported plugin operation");
      const value = await controller.plugins(operation, input ?? {}, new AbortController().signal);
      return { ok: true, value: value as NonNullable<DshPluginReply["value"]> };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Plugin operation failed" }; }
  }, { ok: false, error: "Untrusted window" });
}
