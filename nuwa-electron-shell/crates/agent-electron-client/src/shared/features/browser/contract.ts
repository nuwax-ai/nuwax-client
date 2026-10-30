export const BROWSER_SETTING = "nuwax.linkOpenMode";
export const BROWSER_FEATURE_SETTING = "features.browser.enabled";
export const BROWSER_TOOLBAR_HEIGHT = 36;
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
export interface BrowserState {
  title: string;
  url: string;
  domain: string;
  loading: boolean;
  initialLoading: boolean;
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
        | "stop"
        | "copy"
        | "external"
        | "menu"
        | "pin"
        | "print"
        | "zoom-in"
        | "zoom-out"
        | "zoom-reset"
        | "find-open"
        | "find-close"
        | "address-open"
        | "address-close"
        | "window-minimize"
        | "window-maximize"
        | "window-close";
    }
  | { type: "find"; text: string; forward?: boolean; next?: boolean };
export interface BrowserWindowBridge {
  getState(): Promise<BrowserState | null>;
  command(command: BrowserCommand): Promise<boolean>;
  onState(listener: (state: BrowserState) => void): () => void;
}
export interface BrowserBridge {
  getCapabilities(): Promise<BrowserCapabilities>;
}
