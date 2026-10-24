import type { CuaScope } from "./contract";

/** Initial placement is inset from the conversation area's right edge and below its toolbar. */
export const CUA_CONTROL_INITIAL_POSITION = { right: 24, top: 72 } as const;

export type CuaLiveHint = { controlPending?: boolean; reason?: string | null };

/**
 * Live overlay / tray / PiP: running work, plus the emergency-stop tail.
 * Phase flips to stopped before daemon drain finishes; hide only after pending clears.
 */
export function isCuaLivePhase(phase: string, extra?: CuaLiveHint): boolean {
  if (phase === "running" || phase === "paused") return true;
  if (extra?.controlPending && (phase === "stopped" || phase === "failed")) return true;
  return phase === "failed" && extra?.reason === "helperStillRunning";
}

/** Host slim card: one desktop/window session. Multiwindow uses the PiP surface. */
export function canShowCuaOverlay(runtime: CuaLiveHint & {
  phase: string;
  taskId?: string | null;
  multiwindow?: boolean;
}): boolean {
  return !!runtime.taskId && !runtime.multiwindow && isCuaLivePhase(runtime.phase, runtime);
}

/** Unbound tasks belong in the task center, not the window preview stack. */
export const canPreviewCuaTask = (task: CuaLiveHint & { phase: string; scope?: CuaScope }) =>
  isCuaLivePhase(task.phase, task) && task.scope?.kind === "window" && task.scope.pid > 0 && task.scope.windowId > 0;

export const CUA_REASON_KEYS = ["userPaused", "screenLocked", "toolFailed", "toolTimeout", "stepLimit", "timeLimit",
  "repeatedAction", "connectionClosed", "daemonNotReady", "permissionsRequired", "policyNotActive", "helperStillRunning",
  "idleTimeout", "helperNotInstalled", "sessionEnded", "userStopped", "disabled", "cannotResume", "observationRequired", "gatewayFailed", "scopeBusy", "scopeViolation", "targetClosed", "scopeSaveFailed", "helperIdentityUnverified",
  "noProgress", "uncertainResult", "violationLimit",
  "targetRequired", "taskUnavailable", "windowBusy", "taskQueued", "handoffPending", "foregroundRequired", "userTakingControl", "taskSelectionRequired", "helperUpgradeRequired", "taskCapacity", "targetActivationFailed",
  "blacklisted", "confirmationRequired", "operationFailed", "loginRequired", "operationCancelled"];

/** Session failures the slim overlay may show; operational pauses stay in the tray. */
export const CUA_OVERLAY_NOTICE_REASONS = [
  "permissionsRequired", "daemonNotReady", "helperNotInstalled", "helperStillRunning",
  "helperIdentityUnverified", "gatewayFailed", "connectionClosed", "toolTimeout",
  "toolFailed", "uncertainResult", "policyNotActive",
] as const;

export function cuaReasonKey(reason?: string | null): string {
  return reason && CUA_REASON_KEYS.includes(reason) ? reason : "generic";
}

export function cuaOverlayNotice(reason?: string | null): string | null {
  return reason && (CUA_OVERLAY_NOTICE_REASONS as readonly string[]).includes(reason) ? reason : null;
}

export function actionKind(tool: string): string {
  if (tool.startsWith("get_") || tool.startsWith("list_") || ["zoom", "verify_state", "health_report", "check_permissions"].includes(tool)) return "observe";
  if (tool.startsWith("browser_") || tool === "page") return "browser";
  if (tool.startsWith("clipboard_")) return "clipboard";
  if (tool.includes("session")) return "session";
  if (["launch_app", "kill_app", "bring_to_front", "set_window_frame"].includes(tool)) return "application";
  if (["click", "double_click", "right_click", "drag", "move_cursor", "scroll", "hotkey", "press_key", "type_text", "set_value", "invoke_menu"].includes(tool)) return "input";
  return "other";
}
