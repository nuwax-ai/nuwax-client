export const PERMISSION_KEYS = [
  "screen_recording",
  "file_access",
  "notifications",
  "helper_accessibility",
  "helper_screen_recording",
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];
export type PermissionProbe = "granted" | "denied" | "unknown";
export type GuidedPermissionStatus = PermissionProbe | "restart_required";
export type PermissionGuideTarget = PermissionKey | "overview";
export interface GuidedPermission {
  key: PermissionKey;
  status: GuidedPermissionStatus;
  probe: PermissionProbe;
}
export interface PermissionSnapshot {
  platform: string;
  appName: string;
  appPath: string;
  seen: boolean;
  helperAvailable: boolean;
  items: GuidedPermission[];
}
export interface PermissionOnboardingAPI {
  snapshot(): Promise<PermissionSnapshot | null>;
  markSeen(): Promise<boolean>;
  openSettings(key: PermissionKey): Promise<boolean>;
  showApp(): Promise<boolean>;
  restart(): Promise<boolean>;
}
/** A future CU product adapter must check its own TCC identity without launching/requesting. */
export interface HelperPermissionAdapter {
  check(): Promise<{
    accessibility: PermissionProbe;
    screen_recording: PermissionProbe;
  }>;
  request(key: "accessibility" | "screen_recording"): Promise<boolean>;
}
export function isPermissionKey(value: unknown): value is PermissionKey {
  return (
    typeof value === "string" &&
    PERMISSION_KEYS.includes(value as PermissionKey)
  );
}
export function isPermissionGuideTarget(
  value: unknown,
): value is PermissionGuideTarget {
  return value === "overview" || isPermissionKey(value);
}
/** Session-only: a fresh grant may not propagate to processes already running. */
export class PermissionRestartTracker {
  private denied = new Set<PermissionKey>();
  private pending = new Set<PermissionKey>();
  update(key: PermissionKey, probe: PermissionProbe): GuidedPermission {
    const restartable = key === "screen_recording" || key === "file_access";
    if (probe === "denied") {
      this.denied.add(key);
      this.pending.delete(key);
    } else if (probe === "granted" && restartable && this.denied.has(key)) {
      this.pending.add(key);
    }
    return {
      key,
      probe,
      status: this.pending.has(key) ? "restart_required" : probe,
    };
  }
}
