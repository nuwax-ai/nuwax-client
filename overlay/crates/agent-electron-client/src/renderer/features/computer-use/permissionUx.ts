import type { ComputerUseStatus } from "@shared/features/computer-use/contract";

/** 设置页可映射到 i18n 的 CU 错误码；未知或带前缀的安装/签名失败收成可读种类。 */
const KNOWN_CUA_ERRORS = new Set([
  "permissionsRequired",
  "permissionHostFailed",
  "timeout",
  "daemonNotReady",
  "bundledNotFound",
  "helperNotInstalled",
  "helperStillRunning",
  "databaseNotReady",
  "disableFailed",
  "policyNotActive",
  "helperIdentityUnverified",
  "installRecovery",
  "installRollback",
  "helperSignatureFailed",
]);

export function cuaErrorKind(error?: string | null): string {
  if (!error) return "generic";
  if (KNOWN_CUA_ERRORS.has(error)) return error;
  if (error.startsWith("install-recovery:")) return "installRecovery";
  if (error.startsWith("install-rollback:")) return "installRollback";
  if (/^(codesign-failed|bundle-id-mismatch|team-id-mismatch):/.test(error)) {
    return "helperSignatureFailed";
  }
  return "generic";
}

/** 启用意图在、但助手点不了或权限未活检时，设置页应给出恢复而不是沉默。 */
export function cuaNeedsPermissionRecovery(
  status: Pick<
    ComputerUseStatus,
    | "enabled"
    | "running"
    | "error"
    | "consentPending"
    | "accessibility"
    | "screenRecording"
    | "installed"
  >,
): boolean {
  if (status.error) return true;
  if (!status.installed) return true;
  if (status.enabled && !status.running) return true;
  const helperIntent = status.enabled === true || status.consentPending === true;
  return helperIntent && (status.accessibility !== true || status.screenRecording !== true);
}

/** CU 已开但 daemon 不在时，过期的 granted 不能当「现在点得了」。否认/未知保留。 */
export function neutralizeStaleGrantedPermissions(
  hint: { accessibility: boolean | null; screenRecording: boolean | null },
  enabled: boolean,
  running: boolean,
): { accessibility: boolean | null; screenRecording: boolean | null } {
  if (!enabled || running) return hint;
  return {
    accessibility: hint.accessibility === true ? null : hint.accessibility,
    screenRecording: hint.screenRecording === true ? null : hint.screenRecording,
  };
}
