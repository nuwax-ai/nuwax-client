export const BROWSER_SETTING = "nuwax.linkOpenMode";
export const BROWSER_FEATURE_SETTING = "features.browser.enabled";
export const BROWSER_AGENT_ENABLED_SETTING = "features.browser.agent.enabled";
export const isBrowserAgentEnabled = (value: unknown): boolean => value === true;
export const BROWSER_TOOLBAR_HEIGHT = 48;
export const BROWSER_AUXILIARY_BAR_HEIGHT = 42;
export type LinkOpenMode = "in-app" | "system";
export const linkOpenMode = (value: unknown): LinkOpenMode =>
  value === "system" ? "system" : "in-app";
export const BROWSER_IPC = {
  capabilities: "browser:capabilities",
  hostCapabilities: "browser:host-capabilities",
  state: "browser-window:state",
  command: "browser-window:command",
  changed: "browser-window:changed",
} as const;
export interface BrowserCapabilities {
  available: boolean;
}
export interface BrowserTab {
  id: number;
  title: string;
  loading: boolean;
}
/** Host-owned agent binding state; the toolbar only needs to know it exists. */
export interface BrowserAgentState {
  controlled: boolean;
  origin?: string;
}
export interface BrowserState {
  tabs: BrowserTab[];
  activeTabId: number;
  title: string;
  url: string;
  domain: string;
  loading: boolean;
  initialLoading: boolean;
  agent: BrowserAgentState | null;
  canGoBack: boolean;
  canGoForward: boolean;
  zoom: number;
  pinned: boolean;
  platform: "darwin" | "win32" | "linux";
  maximized: boolean;
  fullscreen: boolean;
  addressOpen: boolean;
  error: string | null;
  finding: boolean;
  findText: string;
  /** An explicit Find command must focus the query even if the bar is already open. */
  findFocusRequest: number;
  matches: number;
  activeMatch: number;
  labels: Record<string, string>;
  dark: boolean;
}
export type BrowserCommand =
  | {
      type:
        | "back"
        | "forward"
        | "reload"
        | "force-reload"
        | "stop"
        | "copy"
        | "external"
        | "pin"
        | "print"
        | "zoom-in"
        | "zoom-out"
        | "zoom-reset"
        | "find-open"
        | "find-close"
        | "address-open"
        | "address-close"
        | "agent-revoke"
        | "window-minimize"
        | "window-maximize"
        | "window-close";
    }
  | { type: "find"; text: string; forward?: boolean; next?: boolean }
  | { type: "tab-activate" | "tab-close"; id: number }
  | { type: "menu"; x?: number };
export interface BrowserWindowBridge {
  getState(): Promise<BrowserState | null>;
  command(command: BrowserCommand): Promise<boolean>;
  onState(listener: (state: BrowserState) => void): () => void;
}
export interface BrowserBridge {
  getCapabilities(): Promise<BrowserCapabilities>;
}
