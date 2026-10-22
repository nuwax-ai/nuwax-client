import type { CuaScope, CuaExecutionMode } from "@shared/features/computer-use/contract";

const READS = ["get_window_state", "get_accessibility_tree", "verify_state", "zoom", "get_desktop_state"];
const COMMON = ["check_permissions", "health_report", "get_config"];
const WRITES = ["click", "double_click", "right_click", "set_value", "scroll", "type_text", "press_key", "hotkey", "drag"];
export const CUA_WINDOW_TASK_TOOLS = [...READS, ...COMMON, ...WRITES];
const FOREGROUND_ONLY = new Set(["drag"]);

/** Window scope and input ownership are independent. An AX target must never authorize global input. */
export function taskCuaCall(scope: CuaScope, mode: CuaExecutionMode, tool: string, raw: unknown) {
  if (!CUA_WINDOW_TASK_TOOLS.includes(tool) || !raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("scopeViolation");
  if (scope.kind !== "window" || scope.pid <= 0 || scope.windowId <= 0) throw new Error("targetRequired");
  const args = { ...raw } as Record<string, unknown>;
  if ((args.pid !== undefined && args.pid !== scope.pid) || (args.window_id !== undefined && args.window_id !== scope.windowId) ||
    args.target !== undefined || args.scope === "desktop" || args.screenshot_out_file !== undefined || args.debug_image_out !== undefined)
    throw new Error("scopeViolation");
  if (mode === "background" && (args.delivery_mode === "foreground" || FOREGROUND_ONLY.has(tool))) throw new Error("foregroundRequired");
  // The model cannot impersonate another task or change native session ownership.
  delete args._nuwax_task; delete args._session_id; delete args.session;
  if (COMMON.includes(tool)) return { tool, args };
  if (tool === "get_accessibility_tree") { tool = "get_window_state"; args.capture_mode = "ax"; }
  if (tool === "get_desktop_state") tool = "get_window_state";
  delete args.scope;
  return { tool, args: { ...args, pid: scope.pid, window_id: scope.windowId,
    ...(WRITES.includes(tool) && tool !== "set_value" ? { delivery_mode: mode } : {}) } };
}

export const CUA_TASK_GUIDANCE = [
  "[Nuwax window task] The host binds this session to one user-selected application window.",
  "Operate only that window. Every write needs a fresh get_window_state observation.",
  "Prefer the exact snapshot_id together with element_index from the latest observation. Use element_token only if that complete token was explicitly returned; never construct one. A bare index is invalid. Never guess snapshot IDs; a new observation invalidates old references.",
  "In background mode prefer click on an exact element and set_value for editable controls. Generic keyboard, pixel and drag input require the user's explicit foreground switch.",
  "Background delivery is enforced by both the host and helper. Never request foreground delivery, global input, clipboard access, browser tools or another window.",
  "If the target is missing, ask the user to select it in the Computer Use task panel.",
  "If background input is unavailable, stop and ask the user to switch this task to foreground in the panel. You cannot authorize that switch.",
  "Never replay an uncertain action. After the user resumes, observe and check its result first.",
].join("\n");
