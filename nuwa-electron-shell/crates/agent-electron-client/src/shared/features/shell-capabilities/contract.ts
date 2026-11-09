export const SHELL_CAPABILITIES_IPC = "host:shell-capabilities";
export const SHELL_MCP_SERVER = "nuwax-shell";
export const SHELL_ACCESS_SETTING = "shellCapabilities.access";
export const shellDomains = ["themes", "settings", "extensions"] as const;
export type ShellDomain = typeof shellDomains[number];
export type ShellAccess = Record<ShellDomain, boolean>;
export interface ShellChange {
  id: string;
  at: string;
  domain: ShellDomain;
  operation: string;
  status: "applied" | "saved" | "failed" | "canceled";
}
export interface ShellCapabilitiesState {
  access: ShellAccess;
  ready: boolean;
  error?: string;
  history: Array<{ id: string; at: string; themeId: string }>;
  changes: ShellChange[];
  themeRevision: number | null;
}
export interface ShellCapabilitiesBridge {
  getState(): Promise<ShellCapabilitiesState>;
  setAccess(access: ShellAccess): Promise<ShellCapabilitiesState>;
  restoreTheme(historyId: string, expectedRevision: number): Promise<void>;
}
