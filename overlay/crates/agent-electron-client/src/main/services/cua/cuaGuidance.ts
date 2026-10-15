import type { CuaScope } from "@shared/types/cuaRuntime";
import { CUA_WRITES_PER_OBSERVATION as N } from "./taskController";

/** Model-facing text. Kept in one place so tool descriptions, instructions and refusals agree. */
const MARK = "[Nuwax]";

const COMMON = [
  "Nuwax Computer Use operates this computer for the user.",
  `- Look before you act: get_window_state for an app window, get_browser_state for a web page, get_desktop_state for the whole screen. Each observation allows up to ${N} actions on what it showed; then observe again.`,
  "- Web pages: prefer get_browser_state with browser_* tools, using refs from the latest snapshot. On macOS, when the trusted input route is refused, pass input_route=\"dom_event\".",
  "- Native apps: use element_token or element_index from the latest get_window_state. Use pixel coordinates only for canvas-like surfaces.",
  "- The browser's own UI (permission prompts, native file pickers, extensions) is native UI: use window tools for it.",
  "- A refused reply did nothing. Observe again and choose a different action; do not resend it unchanged.",
  "- An uncertain result pauses the task for the user. After resuming, observe first and check whether the previous action already took effect. Never redo an uncertain action through a different tool.",
];
const DESKTOP = [
  "- Attaching to the user's own browser profile is not allowed in this mode. If the task needs the user's logged-in browser, ask the user to select that browser window in Computer Use (window mode).",
];
const WINDOW = [
  "- Only the window the user selected can be operated. If it is a browser, call browser_prepare with strategy {\"kind\":\"existing_profile\"} once, then get_browser_state without ids to bind it.",
  "- Keyboard shortcuts, pixel coordinates, the clipboard and other apps are unavailable in this mode.",
];

export function cuaInstructions(scope: CuaScope): string {
  return [...COMMON, ...(scope.kind === "window" ? WINDOW : DESKTOP)].join("\n");
}

const TOOL_NOTES: Record<string, (scope: CuaScope) => string | null> = {
  get_browser_state: () => "Preferred way to read a web page. Refs stay valid until the next snapshot or navigation.",
  browser_prepare: (scope) => scope.kind === "window"
    ? "Only strategy existing_profile on the selected window is allowed."
    : "Attaching to the user's own browser profile is refused in this mode; ask the user to select the browser window in Computer Use.",
  get_window_state: () => `Observing refreshes your allowance of ${N} actions on this window.`,
  get_desktop_state: () => `Observing refreshes your allowance of ${N} actions on native windows (not web page refs).`,
  click: () => "For web page content prefer browser_click.",
  type_text: () => "For web page content prefer browser_type.",
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
  targetClosed: "The selected window is gone. Ask the user to select a window again.",
  noProgress: "The same action was repeated and nothing observed changed, so the task is paused for the user. After resuming, observe and try a different approach.",
};

export function cuaRejectionText(reason: string): string {
  return `Computer Use: ${reason}. ${REJECTIONS[reason] ??
    "Do not replay an uncertain action. Ask the user to resolve the condition; after resume, observe the current screen before acting."}`;
}

export const CUA_REFUSED_HINT = "Computer Use: this call was refused and had no effect. Observe again before choosing the next action; do not resend it unchanged.";
