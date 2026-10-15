export const CUA_REASON_KEYS = ["userPaused", "screenLocked", "toolFailed", "toolTimeout", "stepLimit", "timeLimit",
  "repeatedAction", "connectionClosed", "daemonNotReady", "permissionsRequired", "policyNotActive", "helperStillRunning",
  "idleTimeout", "helperNotInstalled", "sessionEnded", "userStopped", "disabled", "cannotResume", "observationRequired", "gatewayFailed", "scopeBusy", "scopeViolation", "targetClosed", "scopeSaveFailed",
  "noProgress", "uncertainResult", "violationLimit"];

export function actionKind(tool: string): string {
  if (tool.startsWith("get_") || tool.startsWith("list_") || ["zoom", "verify_state", "health_report", "check_permissions"].includes(tool)) return "observe";
  if (tool.startsWith("browser_") || tool === "page") return "browser";
  if (tool.startsWith("clipboard_")) return "clipboard";
  if (tool.includes("session")) return "session";
  if (["launch_app", "kill_app", "bring_to_front", "set_window_frame"].includes(tool)) return "application";
  if (["click", "double_click", "right_click", "drag", "move_cursor", "scroll", "hotkey", "press_key", "type_text", "set_value", "invoke_menu"].includes(tool)) return "input";
  return "other";
}
