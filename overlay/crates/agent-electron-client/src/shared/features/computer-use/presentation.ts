import type { CuaScope } from "./contract";

/** Initial placement is inset from the conversation area's right edge and below its toolbar. */
export const CUA_CONTROL_INITIAL_POSITION = { right: 24, top: 72 } as const;

/** Unbound tasks belong in the task center, not the window preview stack. */
export const canPreviewCuaTask = (task: { phase: string; scope?: CuaScope }) =>
  ["running", "paused"].includes(task.phase) && task.scope?.kind === "window" && task.scope.pid > 0 && task.scope.windowId > 0;

export const CUA_REASON_KEYS = ["userPaused", "screenLocked", "toolFailed", "toolTimeout", "stepLimit", "timeLimit",
  "repeatedAction", "connectionClosed", "daemonNotReady", "permissionsRequired", "policyNotActive", "helperStillRunning",
  "idleTimeout", "helperNotInstalled", "sessionEnded", "userStopped", "disabled", "cannotResume", "observationRequired", "gatewayFailed", "scopeBusy", "scopeViolation", "targetClosed", "scopeSaveFailed", "helperIdentityUnverified",
  "noProgress", "uncertainResult", "violationLimit",
  "targetRequired", "taskUnavailable", "windowBusy", "taskQueued", "handoffPending", "foregroundRequired", "userTakingControl", "taskSelectionRequired", "helperUpgradeRequired", "taskCapacity", "targetActivationFailed",
  "blacklisted", "confirmationRequired"];

export function actionKind(tool: string): string {
  if (tool.startsWith("get_") || tool.startsWith("list_") || ["zoom", "verify_state", "health_report", "check_permissions"].includes(tool)) return "observe";
  if (tool.startsWith("browser_") || tool === "page") return "browser";
  if (tool.startsWith("clipboard_")) return "clipboard";
  if (tool.includes("session")) return "session";
  if (["launch_app", "kill_app", "bring_to_front", "set_window_frame"].includes(tool)) return "application";
  if (["click", "double_click", "right_click", "drag", "move_cursor", "scroll", "hotkey", "press_key", "type_text", "set_value", "invoke_menu"].includes(tool)) return "input";
  return "other";
}
