export const PERMISSION_KEYS = [
  "screen_recording",
  "file_access",
  "notifications",
  "helper_accessibility",
  "helper_screen_recording",
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];
/** Permissions granted by adding the app to a System Settings list; drag-add applies to these only. */
export const DRAG_ADD_PERMISSION_KEYS: readonly PermissionKey[] = [
  "file_access",
  "helper_accessibility",
  "helper_screen_recording",
];
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
  /** The registered helper exposes a bundle path, so drag-add can offer its real identity. */
  helperAppAvailable?: boolean;
  items: GuidedPermission[];
}
export interface PermissionOnboardingAPI {
  snapshot(): Promise<PermissionSnapshot | null>;
  markSeen(): Promise<boolean>;
  openSettings(key: PermissionKey): Promise<boolean>;
  showApp(): Promise<boolean>;
  restart(): Promise<boolean>;
  showDragChip(key: PermissionKey): Promise<boolean>;
  hideDragChip(): Promise<boolean>;
}
/** A future CU product adapter must check its own TCC identity without launching/requesting. */
export interface HelperPermissionAdapter {
  check(): Promise<{
    accessibility: PermissionProbe;
    screen_recording: PermissionProbe;
  }>;
  request(key: "accessibility" | "screen_recording"): Promise<boolean>;
  /** Installed helper bundle path for drag-add; absent while the product integration is pending. */
  appPath?: () => string | null;
}
export function isPermissionKey(value: unknown): value is PermissionKey {
  return (
    typeof value === "string" &&
    PERMISSION_KEYS.includes(value as PermissionKey)
  );
}
export function isDragAddPermissionKey(
  value: unknown,
): value is PermissionKey {
  return (
    typeof value === "string" &&
    DRAG_ADD_PERMISSION_KEYS.includes(value as PermissionKey)
  );
}
export function isPermissionGuideTarget(
  value: unknown,
): value is PermissionGuideTarget {
  return value === "overview" || isPermissionKey(value);
}
/** Windows has no pre-authorization steps; neither show nor open an empty guide. */
export function supportsPermissionGuide(platform: string): boolean {
  return !platform.toLowerCase().startsWith("win");
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
