import { createHash } from "node:crypto";
import { canonicalPath, limits, validateThemePackage } from "@shared/features/themes/core";
import type { HostThemeFiles, HostThemePreference } from "@shared/features/themes/contract";

export interface ThemeFileChange {
  path: string;
  content: string | null;
  encoding?: "utf8" | "base64";
}
export interface ThemeEdit {
  themeId: string;
  expectedRevision: number;
  expectedVersion: string;
  changes: ThemeFileChange[];
}
export interface ThemeHistoryEntry {
  id: string;
  at: string;
  themeId: string;
  files: HostThemeFiles | null;
  selection: { themeId: string; mode: HostThemePreference };
}

export function themeVersion(files: HostThemeFiles): string {
  return createHash("sha256").update(JSON.stringify(Object.keys(files).sort().map(key => [key, files[key]]))).digest("hex");
}

export function changedTheme(files: HostThemeFiles, changes: ThemeFileChange[]) {
  if (!Array.isArray(changes) || !changes.length || changes.length > limits.files)
    throw new Error("Invalid theme file changes");
  const next = { ...files }, seen = new Set<string>();
  for (const change of changes) {
    if (!change || typeof change !== "object") throw new Error("Invalid theme file change");
    const name = canonicalPath(change.path);
    if (seen.has(name)) throw new Error("Duplicate theme file change");
    seen.add(name);
    if (change.content === null) { delete next[name]; continue; }
    if (typeof change.content !== "string" || change.content.length > Math.ceil(limits.fileBytes / 3) * 4)
      throw new Error("Theme file size limit");
    if (change.encoding !== undefined && !["utf8", "base64"].includes(change.encoding))
      throw new Error("Invalid theme file encoding");
    next[name] = change.encoding === "base64" ? change.content : Buffer.from(change.content, "utf8").toString("base64");
  }
  const candidate = validateThemePackage(next);
  if (candidate.manifest.id !== validateThemePackage(files).manifest.id)
    throw new Error("Theme ID cannot change during editing");
  return candidate;
}

/** Keep bounded durable undo history within the existing registry's size budget. */
export function themeHistory(entries: ThemeHistoryEntry[]): ThemeHistoryEntry[] {
  const retained: ThemeHistoryEntry[] = [];
  let bytes = 0;
  for (const entry of [...entries].reverse()) {
    bytes += Buffer.byteLength(JSON.stringify(entry));
    if (retained.length >= 5 || bytes > 32 * 1024 * 1024) break;
    retained.unshift(entry);
  }
  return retained;
}
