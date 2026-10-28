import type { CuaScope } from "@shared/features/computer-use/contract";
import type { CuaOutcome } from "./cuaOutcome";

const WINDOW_READS = ["get_window_state", "get_accessibility_tree"];
const WINDOW_ACTIONS = ["click", "set_value", "scroll"];
const BROWSER_ACTIONS = ["browser_navigate", "browser_click", "browser_type", "browser_pointer", "browser_dialog"];
const BROWSER_TOOLS = ["get_browser_state", "browser_prepare", ...BROWSER_ACTIONS];
const COMMON = ["check_permissions", "get_config", "health_report", "start_session", "end_session", "get_session", "get_session_state"];
const ELEMENT_ARGS = new Set(["session", "pid", "window_id", "element_index", "snapshot_id", "value", "direction", "by", "amount"]);

/** The native protocol accepts one target format. Collapse only provably identical window IDs. */
function desktopTargetArgs(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const args = raw as Record<string, unknown>;
  if (args.target === undefined || !["scope", "pid", "window_id"].some(key => args[key] !== undefined)) return raw;
  const target = args.target as Record<string, unknown> | null;
  if (!target || typeof target !== "object" || Array.isArray(target) || target.kind !== "window" ||
      !Number.isSafeInteger(target.pid) || Number(target.pid) <= 0 ||
      !Number.isSafeInteger(target.window_id) || Number(target.window_id) <= 0 ||
      Object.keys(target).some(key => !["kind", "pid", "window_id"].includes(key)) ||
      (args.pid !== undefined && args.pid !== target.pid) ||
      (args.window_id !== undefined && args.window_id !== target.window_id) ||
      (args.scope !== undefined && args.scope !== "window")) throw new Error("scopeViolation");
  const normalized: Record<string, unknown> = { ...args, pid: target.pid, window_id: target.window_id };
  delete normalized.target;
  delete normalized.scope;
  return normalized;
}

export function visibleCuaTools(scope: CuaScope, allowed: readonly string[]): readonly string[] {
  return scope.kind === "desktop" ? allowed
    : allowed.filter((tool) => [...COMMON, ...WINDOW_READS, ...WINDOW_ACTIONS, ...BROWSER_TOOLS, "get_desktop_state"].includes(tool));
}

/**
 * Browser tabs bound from the selected window. Tab ids appear at run time, so a static helper
 * policy cannot express them: in window mode the gateway is their only enforcer.
 */
export class CuaBrowserBindings {
  private tabs = new Set<string>();
  private targets = new Map<string, { pid: number; window_id: number }>();
  nativeTarget(args: Record<string, unknown>) { return this.targets.get(`${args.target_id}/${args.tab_id}`); }
  has(target: unknown, tab: unknown) { return typeof target === "string" && typeof tab === "string" && this.tabs.has(`${target}/${tab}`); }
  record(scope: CuaScope, tool: string, rawArgs: unknown, outcome: CuaOutcome, structured: unknown) {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const sc = (structured ?? {}) as { target_id?: unknown; tabs?: unknown };
    if (tool !== "get_browser_state" || outcome !== "ok" || args.target_id !== undefined) return;
    if (typeof sc.target_id !== "string" || !Array.isArray(sc.tabs)) return;
    if (scope.kind === "window" && (args.pid !== scope.pid || args.window_id !== scope.windowId)) return;
    for (const tab of sc.tabs) {
      const id = (tab as { tab_id?: unknown } | null)?.tab_id;
      if (typeof id === "string") {
        if (scope.kind === "window") this.tabs.add(`${sc.target_id}/${id}`);
        if (Number.isSafeInteger(args.pid) && Number.isSafeInteger(args.window_id))
          this.targets.set(`${sc.target_id}/${id}`, { pid: args.pid as number, window_id: args.window_id as number });
      }
    }
  }
  clear() { this.tabs.clear(); this.targets.clear(); }
}

/** Window mode intentionally excludes pixel/global input and browser/process escape hatches. */
export function scopeCuaCall(scope: CuaScope, tool: string, raw: unknown, bindings?: CuaBrowserBindings): { tool: string; args: unknown } {
  if (scope.kind === "desktop") {
    const strategy = (raw as { strategy?: { kind?: unknown } } | null)?.strategy;
    // Attaching to the user's own profile needs the user to point at that window first.
    if (tool === "browser_prepare" && strategy?.kind === "existing_profile") throw new Error("profileAttachRequiresWindowScope");
    return { tool, args: desktopTargetArgs(raw) };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("scopeViolation");
  const args = { ...raw } as Record<string, unknown>;
  if (COMMON.includes(tool)) return { tool, args };
  if (scope.pid <= 0 || scope.windowId <= 0) throw new Error("targetClosed");
  const ownWindow = (args.pid === undefined || args.pid === scope.pid) && (args.window_id === undefined || args.window_id === scope.windowId);
  if (tool === "get_browser_state") {
    if (args.target_id !== undefined || args.tab_id !== undefined) {
      if (!bindings?.has(args.target_id, args.tab_id)) throw new Error("scopeViolation");
      return { tool, args };
    }
    if (!ownWindow) throw new Error("scopeViolation");
    return { tool, args: { ...args, pid: scope.pid, window_id: scope.windowId } };
  }
  if (tool === "browser_prepare") {
    const strategy = (args.strategy as { kind?: unknown } | undefined)?.kind;
    if (!ownWindow || args.allow_launch || args.profile !== undefined || (strategy !== undefined && strategy !== "existing_profile")) throw new Error("scopeViolation");
    return { tool, args: { ...args, pid: scope.pid, window_id: scope.windowId } };
  }
  if (BROWSER_ACTIONS.includes(tool)) {
    if (!bindings?.has(args.target_id, args.tab_id)) throw new Error("scopeViolation");
    return { tool, args };
  }
  if (tool === "get_desktop_state") { tool = "get_window_state"; delete args.scope; }
  if (![...WINDOW_READS, ...WINDOW_ACTIONS].includes(tool)) throw new Error("scopeViolation");
  if (!ownWindow || args.target !== undefined || args.scope === "desktop") throw new Error("scopeViolation");
  delete args.scope;
  if (WINDOW_ACTIONS.includes(tool) && (!Number.isSafeInteger(args.element_index) || Number(args.element_index) < 0 ||
      Object.keys(args).some((key) => !ELEMENT_ARGS.has(key)))) throw new Error("scopeViolation");
  return { tool, args: { ...args, pid: scope.pid, window_id: scope.windowId } };
}

/** JSON is valid YAML. The helper itself enforces the selected native target as a second gate. */
export function cuaPolicy(scope: CuaScope, allowed: readonly string[], denied: readonly string[]): string {
  if (scope.kind === "desktop") return JSON.stringify({ allow: { tools: allowed }, deny: { tools: denied } }, null, 2) + "\n";
  const native = { pid: { allowed: [scope.pid] }, window_id: { allowed: [scope.windowId] } };
  const browser = BROWSER_TOOLS.filter((tool) => allowed.includes(tool));
  return JSON.stringify({ allow: {
    // Only the trusted host uses discovery to change the target. Bound browser tabs are checked by the gateway.
    tools: [...COMMON, "list_windows", "set_agent_cursor_enabled", ...browser.filter((tool) => tool !== "browser_prepare")],
    rules: [
      ...[...WINDOW_READS, ...WINDOW_ACTIONS].map((tool) => ({ tool, constraints: {
        ...native, ...(WINDOW_ACTIONS.includes(tool) ? { element_index: { min: 0, max: 100000 } } : {}),
      } })),
      ...(browser.includes("browser_prepare") ? [{ tool: "browser_prepare", constraints: native }] : []),
    ],
  }, deny: { tools: denied } }, null, 2) + "\n";
}
