import type { HostThemeFiles, HostThemesState, HostThemePreference } from "@shared/types/hostBridge";

/** Host operations supplied by the feature composition root, without implementation imports. */
export interface ShellThemeEdit {
  themeId: string;
  expectedRevision: number;
  expectedVersion: string;
  changes: Array<{ path: string; content: string | null; encoding?: "utf8" | "base64" }>;
}
export interface ShellThemeService {
  state(): HostThemesState;
  history(): Array<{ id: string; at: string; themeId: string }>;
  readForEdit(themeId: string): Promise<{ themeId: string; revision: number; version: string; editable: boolean; files: HostThemeFiles }>;
  copyForEdit(input: { sourceId: string; themeId: string; name: string; expectedRevision: number; expectedVersion: string }, check: () => void): Promise<unknown>;
  previewChanges(input: ShellThemeEdit): Promise<unknown>;
  applyChanges(input: ShellThemeEdit, check: () => void): Promise<unknown>;
  select(themeId: string, mode: HostThemePreference, onlyIfUnselected: boolean, expectedRevision: number, check: () => void): Promise<unknown>;
  restore(input: { historyId: string; expectedRevision: number; expectedVersion: string }, check?: () => void): Promise<unknown>;
}
export interface ShellAuthoringContext {
  tokenNames: readonly string[];
  defaultTokens: unknown;
  surfaces: readonly string[];
}
export interface ShellLinkPreference {
  key: string;
  normalize(value: unknown): "in-app" | "system";
}
export const shellError = (error: unknown): string =>
  error && typeof error === "object" && "code" in error ? "Local capability storage unavailable"
    : error instanceof Error ? error.message : "Shell operation failed";
