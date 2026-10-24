import { computerUseHost } from "./ports";
import log from "electron-log";

export const CUA_PREFERENCES_KEY = "computerUsePreferences.v1";
const LEGACY_KEY = "step1_config";
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** General settings snapshots must never own CU consent or runtime preferences. */
export function readCuaPreferences(): Record<string, unknown> {
  const host = computerUseHost();
  const saved = host.readSetting(CUA_PREFERENCES_KEY);
  if (saved && typeof saved === "object" && !Array.isArray(saved)) return { ...saved as Record<string, unknown> };
  const legacy = record(host.readSetting(LEGACY_KEY));
  const migrated = Object.fromEntries(Object.entries(legacy).filter(([key]) => key.startsWith("computerUse")));
  migrated.computerUseEnabled = legacy.computerUseEnabled === true;
  // Failed persistence is retried on the next read; never infer ON from helper files.
  if (Object.keys(legacy).some(key => key.startsWith("computerUse"))) host.writeSetting(CUA_PREFERENCES_KEY, migrated);
  return migrated;
}

export function writeCuaPreferences(patch: Record<string, unknown>): boolean {
  if (Object.keys(patch).some(key => !key.startsWith("computerUse"))) return false;
  const host = computerUseHost();
  const next = { ...readCuaPreferences(), ...patch };
  if (!host.writeSetting(CUA_PREFERENCES_KEY, next)) return false;
  // Compatibility projection for older clients. Only the separate record is authoritative.
  if (!host.writeSetting(LEGACY_KEY, { ...record(host.readSetting(LEGACY_KEY)), ...next }))
    log.warn("[Cua] legacy preference projection failed");
  return true;
}
