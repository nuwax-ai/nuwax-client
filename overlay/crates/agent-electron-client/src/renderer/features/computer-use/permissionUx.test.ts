import { describe, expect, it } from "vitest";
import {
  cuaErrorKind,
  cuaNeedsPermissionRecovery,
  neutralizeStaleGrantedPermissions,
} from "./permissionUx";

describe("cuaErrorKind", () => {
  it("keeps known codes and maps install/signature prefixes", () => {
    expect(cuaErrorKind("timeout")).toBe("timeout");
    expect(cuaErrorKind("install-recovery:EACCES")).toBe("installRecovery");
    expect(cuaErrorKind("install-rollback:ENOENT")).toBe("installRollback");
    expect(cuaErrorKind("codesign-failed:exit 1")).toBe("helperSignatureFailed");
    expect(cuaErrorKind("bundle-id-mismatch:other")).toBe("helperSignatureFailed");
    expect(cuaErrorKind("mystery")).toBe("generic");
    expect(cuaErrorKind(null)).toBe("generic");
  });
});

describe("cuaNeedsPermissionRecovery", () => {
  const ready = {
    enabled: true,
    running: true,
    error: null,
    consentPending: false,
    accessibility: true,
    screenRecording: true,
    installed: true,
  };

  it("stays quiet when the helper is live and both grants are proven", () => {
    expect(cuaNeedsPermissionRecovery(ready)).toBe(false);
  });

  it("asks for recovery when CU is on but the daemon is down or a grant is missing", () => {
    expect(cuaNeedsPermissionRecovery({ ...ready, running: false })).toBe(true);
    expect(cuaNeedsPermissionRecovery({ ...ready, accessibility: false })).toBe(true);
    expect(cuaNeedsPermissionRecovery({ ...ready, error: "daemonNotReady" })).toBe(true);
    expect(cuaNeedsPermissionRecovery({ ...ready, enabled: false, consentPending: true, accessibility: null })).toBe(true);
  });
});

describe("neutralizeStaleGrantedPermissions", () => {
  it("hides stale grants only while CU is enabled and the helper is not running", () => {
    const granted = { accessibility: true, screenRecording: true };
    expect(neutralizeStaleGrantedPermissions(granted, true, false)).toEqual({
      accessibility: null,
      screenRecording: null,
    });
    expect(neutralizeStaleGrantedPermissions(granted, true, true)).toEqual(granted);
    expect(neutralizeStaleGrantedPermissions(granted, false, false)).toEqual(granted);
    expect(neutralizeStaleGrantedPermissions(
      { accessibility: false, screenRecording: null },
      true,
      false,
    )).toEqual({ accessibility: false, screenRecording: null });
  });
});
