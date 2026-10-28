import type { CuaScope } from "@shared/features/computer-use/contract";
import { CUA_WRITES_PER_OBSERVATION as N } from "./taskController";

/** Model-facing text. Kept in one place so tool descriptions, instructions and refusals agree. */
const MARK = "[Nuwax]";

const COMMON = [
  "Nuwax Computer Use operates this computer for the user.",
  "Follow this recipe in order:",
  "1. Observe first. Call get_window_state (app window; request a screenshot) before any click, type, scroll or set_value. Use get_desktop_state for the whole screen, get_browser_state for a web page. Never act on a stale snapshot.",
  `2. Prefer element_index (or element_token) from that latest observation. Each observation allows up to ${N} writes on what it showed; then observe again.`,
  "3. Pixel coordinates (x/y) are a last resort, only on canvas-like surfaces with no element. When the latest observation has an element covering that point, the host rewrites the click to that element_index. In window mode leftover coordinates, keyboard, clipboard and other apps are scopeViolation — that is not a miss. Pick an element_index from a fresh observation; the host supplies pid/window_id.",
  "4. After every write burst, observe again and verify the result before the next action. Never assume a click landed.",
  "5. Agent cursor: the host enables a simulated overlay cursor for an active desktop task so the user can see where you aim. The overlay is independent of Background delivery — do not pass foreground:true or move the user's real mouse. The host manages cursor controls; the user can disable the overlay in settings. Do not call host-only cursor tools.",
  "6. You choose the operating window. Do not ask the user to pick desktop vs window. Skip any app or window the host marks as blacklisted; a blacklist skip is not a targeting miss.",
  "7. If the host replies sensitiveTarget, that control is a password field, payment field, or privilege-granting system dialog. Do not retry it. Ask the user to complete it themselves.",
  "8. If the host replies confirmationRequired, stop and wait. The user must allow that sensitive action once; do not retry it unchanged until they do. Unrestricted mode still honors the blacklist and sensitiveTarget denials.",
  "- Web pages: prefer get_browser_state with browser_* tools, using refs from the latest snapshot. On macOS, when the trusted input route is refused, pass input_route=\"dom_event\".",
  "- The browser's own UI (permission prompts, native file pickers, extensions) is native UI: use window tools for it.",
  "- A refused or scopeViolation reply did nothing. Observe again and choose a different action; do not resend the same coordinates.",
  "- An uncertain result pauses the task for the user. After resuming, observe first and check whether the previous action already took effect. Never redo an uncertain action through a different tool.",
];
const DESKTOP = [
  "- Desktop mode may use pixel coordinates only when the latest observation has no matching element (canvas/game surface). The host prefers element_index and rewrites a covering hit. Always verify with a screenshot afterwards.",
  "- Attaching to the user's own browser profile is not allowed in this mode. Bind a specific browser window yourself via observation; do not ask the user to flip a scope control.",
];
const WINDOW = [
  "- Only the currently bound window can be operated. The host injects pid/window_id; do not invent them.",
  "- Window mode requires get_window_state to grant writes; get_accessibility_tree alone is supplemental. Use click/set_value/scroll with an element_index from a fresh observation. Pixel coordinates are rejected as scopeViolation.",
];

export function cuaInstructions(scope: CuaScope): string {
  return [...COMMON, ...(scope.kind === "window" ? WINDOW : DESKTOP)].join("\n");
}

const TOOL_NOTES: Record<string, (scope: CuaScope) => string | null> = {
  get_browser_state: () => "Preferred way to read a web page. Refs stay valid until the next snapshot or navigation.",
  browser_prepare: (scope) => scope.kind === "window"
    ? "Only strategy existing_profile on the selected window is allowed."
    : "Attaching to the user's own browser profile is refused in this mode; select the native browser window with a fresh observation.",
  get_window_state: () => `Observe this window (screenshot + elements). Required before acting. Prefer element_index from this snapshot. Refreshes your allowance of ${N} actions.`,
  get_accessibility_tree: () => "Element tree for the current window. Use with get_window_state; act on element_index from this snapshot.",
  get_desktop_state: () => `Whole-screen observation. Refreshes your allowance of ${N} writes on native windows (not web page refs). Prefer get_window_state when targeting one app.`,
  click: (scope) => scope.kind === "window"
    ? "Use element_index from the latest observation. Pixel coordinates and foreground:true are rejected. Keep Background delivery."
    : "Prefer element_index from the latest observation. Pixel x/y is last resort; the host rewrites a covering hit to element_index. Keep Background delivery; do not pass foreground:true. For web page content prefer browser_click.",
  type_text: () => "For web page content prefer browser_type.",
  set_value: () => "Use element_index from the latest observation. Do not target by pixel coordinates.",
  scroll: () => "Use element_index from the latest observation when a scrollable element exists.",
  set_agent_cursor_enabled: () => "Toggles the simulated overlay cursor (not the user's mouse). The host enables it by default for an active task.",
};

/** Prefixes a short routing note; idempotent so a re-listed tool is never annotated twice. */
export function cuaToolDescription(scope: CuaScope, name: string, description: string | undefined): string | undefined {
  const note = TOOL_NOTES[name]?.(scope);
  if (!note || description?.startsWith(MARK)) return description;
  return `${MARK} ${note}${description ? `\n\n${description}` : ""}`;
}

export function cuaMergeInstructions(scope: CuaScope, existing: unknown): string {
  const ours = cuaInstructions(scope);
  if (typeof existing !== "string" || !existing) return ours;
  return existing.startsWith(ours) ? existing : `${ours}\n\n${existing}`;
}

const REJECTIONS: Record<string, string> = {
  observationRequired: `Observe the target first (get_window_state, get_browser_state or get_desktop_state), then act on what you saw. Each observation allows up to ${N} actions on that target.`,
  scopeViolation: "Window-only mode allows the selected window and, if it is a browser, its bound tabs. Keyboard shortcuts, pixel coordinates, the clipboard and other apps are unavailable. Repeated violations end the task.",
  profileAttachRequiresWindowScope: "Attaching to the user's own browser profile is not allowed in desktop mode. Ask the user to select that browser window in Computer Use (window mode).",
  toolNotAllowed: "This tool is not available. Repeated violations end the task.",
  targetClosed: "The selected window is gone. Observe again and pick another live window.",
  blacklisted: "That application is on the user's Computer Use blacklist. Skip it and continue with a different app. This is not a targeting miss.",
  sensitiveTarget: "That control is a password field, payment field, or a system dialog that grants privileges. Do not click or type into it. Ask the user to finish it themselves. This is not a targeting miss.",
  confirmationRequired: "This action needs an explicit user confirmation (ask mode). Do not retry until the user allows it once.",
  noProgress: "The same action was repeated and nothing observed changed, so the task is paused for the user. After resuming, observe and try a different approach.",
};

export function cuaRejectionText(reason: string): string {
  return `Computer Use: ${reason}. ${REJECTIONS[reason] ??
    "Do not replay an uncertain action. Ask the user to resolve the condition; after resume, observe the current screen before acting."}`;
}

export const CUA_REFUSED_HINT = "Computer Use: this call was refused and had no effect. Observe again before choosing the next action; do not resend it unchanged.";

/** Host-issued overlay enablement. Independent of Background input delivery. */
export const CUA_AGENT_CURSOR_ENABLE = {
  name: "set_agent_cursor_enabled",
  arguments: { enabled: true },
} as const;
