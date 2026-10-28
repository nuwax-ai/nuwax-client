import { createHash } from "node:crypto";

/**
 * How a helper reply affects the task. Only `status`, `effect`, `refusal` and `code` are read;
 * nothing from the reply is retained.
 *  - ok:        executed (or, for reads, observed).
 *  - refused:   provably not executed; safe to hand back to the model.
 *  - uncertain: a write may or may not have taken effect; never replay it automatically.
 */
export type CuaOutcome = "ok" | "refused" | "uncertain";

export const CUA_OBSERVATIONS = new Set([
  "get_window_state", "get_desktop_state", "get_browser_state", "zoom", "verify_state",
]);
export const CUA_READS = new Set([
  ...CUA_OBSERVATIONS, "check_permissions", "get_agent_cursor_state", "get_config", "get_cursor_position",
  "get_recording_state", "get_screen_size", "get_session", "get_session_state", "health_report",
  "list_apps", "list_sessions", "list_windows", "get_accessibility_tree",
]);
export const CUA_LIFECYCLE = new Set(["start_session", "end_session"]);
/** Writes that do not act on a UI the model must have looked at first. */
const UNTARGETED_WRITES = new Set([
  "launch_app", "set_agent_cursor_enabled", "set_agent_cursor_motion", "set_agent_cursor_theme",
  "start_recording", "stop_recording", "set_config", "escalate_session",
]);

type Reply = { error?: unknown; result?: { isError?: boolean; structuredContent?: unknown } };
type Args = Record<string, unknown>;
const record = (value: unknown): Args | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Args : null;

export function isRefusal(structured: unknown): boolean {
  const sc = record(structured);
  return !!sc && (sc.status === "refused" || sc.effect === "refused" || !!record(sc.refusal));
}

export function classifyReply(tool: string, reply: Reply): CuaOutcome {
  const read = CUA_READS.has(tool);
  if (reply.error) return read ? "refused" : "uncertain";
  const sc = record(reply.result?.structuredContent);
  if (isRefusal(sc)) return "refused";
  if (reply.result?.isError) {
    // Argument validation happens before the driver touches anything.
    if (read || sc?.code === "tool_invocation_failed") return "refused";
    return "uncertain";
  }
  return "ok";
}

const id = (value: unknown) => typeof value === "number" || typeof value === "string" ? String(value) : null;

/** Targets a successful observation refreshes, or null when the tool is not an observation. */
export function observedTargets(tool: string, rawArgs: unknown, structured: unknown): string[] | null {
  if (!CUA_OBSERVATIONS.has(tool)) return null;
  const args = record(rawArgs) ?? {};
  const sc = record(structured) ?? {};
  if (tool === "get_desktop_state") return ["desktop"];
  if (tool === "get_browser_state") {
    if (id(args.target_id) && id(args.tab_id)) return [`b:${args.target_id}/${args.tab_id}`];
    const targets = windowTargets(args);
    const target = id(sc.target_id);
    const tabs = Array.isArray(sc.tabs) ? sc.tabs : [];
    if (target) for (const tab of tabs) { const tabId = id(record(tab)?.tab_id); if (tabId) targets.push(`b:${target}/${tabId}`); }
    return targets;
  }
  return windowTargets(args);
}

function windowTargets(args: Args): string[] {
  const out: string[] = [];
  if (id(args.window_id)) out.push(`w:${args.window_id}`);
  if (id(args.pid)) out.push(`p:${args.pid}`);
  return out;
}

export const CUA_EXEMPT = "exempt";
export const CUA_ANY = "any";

/** The UI a write acts on: a target key, CUA_EXEMPT, or CUA_ANY when it cannot be resolved. */
export function writeTarget(tool: string, rawArgs: unknown): string {
  const args = record(rawArgs) ?? {};
  if (UNTARGETED_WRITES.has(tool)) return CUA_EXEMPT;
  if (tool === "browser_prepare" && !id(args.pid)) return CUA_EXEMPT; // launches its own isolated browser
  if (id(args.target_id) && id(args.tab_id)) return `b:${args.target_id}/${args.tab_id}`;
  const target = record(args.target);
  if (target?.kind === "window" && id(target.window_id)) return `w:${target.window_id}`;
  if (id(args.window_id)) return `w:${args.window_id}`;
  if (id(args.pid)) return `p:${args.pid}`;
  if (args.scope === "desktop" || target?.display_id !== undefined || tool === "move_cursor" || tool === "drag") return "desktop";
  return CUA_ANY;
}

/** Fields that change on every snapshot without the UI changing. */
const VOLATILE = new Set(["snapshot_id", "snapshot", "element_token", "ref", "target_id", "tab_id",
  "continuation", "session", "_note", "screenshot_out_file", "captured_at", "timestamp"]);

/** Content-free fingerprint of what an observation saw; equal digests mean "nothing changed". */
export function observationDigest(structured: unknown): string {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    const obj = record(value);
    if (!obj) return value;
    const out: Args = {};
    for (const key of Object.keys(obj).sort()) if (!VOLATILE.has(key)) out[key] = strip(obj[key]);
    return out;
  };
  return createHash("sha256").update(JSON.stringify(strip(structured ?? null))).digest("hex");
}
