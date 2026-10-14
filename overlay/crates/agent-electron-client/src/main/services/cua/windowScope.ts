import type { CuaScope } from "@shared/types/cuaRuntime";

const WINDOW_READS = ["get_window_state", "get_accessibility_tree"];
const WINDOW_ACTIONS = ["click", "set_value", "scroll"];
const COMMON = ["check_permissions", "get_config", "health_report", "start_session", "end_session", "get_session", "get_session_state"];
const ELEMENT_ARGS = new Set(["session", "pid", "window_id", "element_index", "snapshot_id", "value", "direction", "by", "amount"]);

export function visibleCuaTools(scope: CuaScope, allowed: readonly string[]): readonly string[] {
  return scope.kind === "desktop" ? allowed : allowed.filter((tool) => [...COMMON, ...WINDOW_READS, ...WINDOW_ACTIONS, "get_desktop_state"].includes(tool));
}

/** Window mode intentionally excludes pixel/global input and browser/process escape hatches. */
export function scopeCuaCall(scope: CuaScope, tool: string, raw: unknown): { tool: string; args: unknown } {
  if (scope.kind === "desktop") return { tool, args: raw };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("scopeViolation");
  const args = { ...raw } as Record<string, unknown>;
  if (COMMON.includes(tool)) return { tool, args };
  if (scope.pid <= 0 || scope.windowId <= 0) throw new Error("targetClosed");
  if (tool === "get_desktop_state") { tool = "get_window_state"; delete args.scope; }
  if (![...WINDOW_READS, ...WINDOW_ACTIONS].includes(tool)) throw new Error("scopeViolation");
  if ((args.pid !== undefined && args.pid !== scope.pid) ||
      (args.window_id !== undefined && args.window_id !== scope.windowId) || args.target !== undefined || args.scope === "desktop") throw new Error("scopeViolation");
  delete args.scope;
  if (WINDOW_ACTIONS.includes(tool) && (!Number.isSafeInteger(args.element_index) || Number(args.element_index) < 0 ||
      Object.keys(args).some((key) => !ELEMENT_ARGS.has(key)))) throw new Error("scopeViolation");
  return { tool, args: { ...args, pid: scope.pid, window_id: scope.windowId } };
}

/** JSON is valid YAML. The helper itself enforces the selected native target as a second gate. */
export function cuaPolicy(scope: CuaScope, allowed: readonly string[], denied: readonly string[]): string {
  if (scope.kind === "desktop") return JSON.stringify({ allow: { tools: allowed }, deny: { tools: denied } }, null, 2) + "\n";
  return JSON.stringify({ allow: {
    tools: [...COMMON, "list_windows"], // only the trusted host uses discovery to change the target
    rules: [...WINDOW_READS, ...WINDOW_ACTIONS].map((tool) => ({ tool, constraints: {
      pid: { allowed: [scope.pid] }, window_id: { allowed: [scope.windowId] },
      ...(WINDOW_ACTIONS.includes(tool) ? { element_index: { min: 0, max: 100000 } } : {}),
    } })),
  }, deny: { tools: denied } }, null, 2) + "\n";
}
