import { describe, expect, it } from "vitest";
import {
  PermissionRestartTracker,
  isDragAddPermissionKey,
  isPermissionGuideTarget,
  isPermissionKey,
} from "./permissionOnboarding";
describe("permission guide contract", () => {
  it("validates navigation targets", () => {
    expect(isPermissionGuideTarget("overview")).toBe(true);
    expect(isPermissionKey("helper_screen_recording")).toBe(true);
    for (const value of [null, {}, "__proto__", "constructor", "file:///tmp"])
      expect(isPermissionGuideTarget(value)).toBe(false);
  });
  it("limits drag-add to list-type permissions", () => {
    for (const key of [
      "file_access",
      "helper_accessibility",
      "helper_screen_recording",
    ])
      expect(isDragAddPermissionKey(key)).toBe(true);
    for (const key of [
      "screen_recording",
      "notifications",
      "overview",
      "__proto__",
      null,
    ])
      expect(isDragAddPermissionKey(key)).toBe(false);
  });
  it("does not infer restart from focus, a missing probe or helper grants", () => {
    const tracker = new PermissionRestartTracker();
    expect(tracker.update("screen_recording", "unknown").status).toBe(
      "unknown",
    );
    expect(tracker.update("screen_recording", "granted").status).toBe(
      "granted",
    );
    tracker.update("helper_screen_recording", "denied");
    expect(tracker.update("helper_screen_recording", "granted").status).toBe(
      "granted",
    );
  });
});
