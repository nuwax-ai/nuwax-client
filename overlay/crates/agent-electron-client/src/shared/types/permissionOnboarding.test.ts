import { describe, expect, it } from "vitest";
import {
  PermissionRestartTracker,
  isDragAddPermissionKey,
  isPermissionGuideTarget,
  isPermissionKey,
} from "./permissionOnboarding";
import en from "../locales/en-US.json";
import cn from "../locales/zh-CN.json";
import tw from "../locales/zh-TW.json";
import hk from "../locales/zh-HK.json";
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
  it("ships Computer Use session-failure copy in all four locales", () => {
    const keys = [
      "Claw.Cua.reason.operationFailed",
      "Claw.Cua.reason.loginRequired",
      "Claw.Cua.reason.operationCancelled",
      "Claw.Cua.reason.permissionsRequired",
      "Claw.Cua.reason.uncertainResult",
      "Claw.Cua.reason.helperStillRunning",
      "Claw.Cua.reason.sensitiveTarget",
      "Claw.Cua.reason.blacklisted",
    ] as const;
    for (const locale of [en, cn, tw, hk]) {
      for (const key of keys) {
        expect((locale as Record<string, string>)[key], key).toBeTruthy();
      }
      expect((locale as Record<string, string>)["Claw.Cua.reason.operationFailed"]).toContain("Nuwax Computer Use");
      expect((locale as Record<string, string>)["Claw.Cua.reason.permissionsRequired"]).toContain("Nuwax Computer Use");
    }
  });
  it("ships a short Computer Use consent that names Nuwax Computer Use", () => {
    const keys = [
      "Claw.Settings.computerUse.consentTitle",
      "Claw.Settings.computerUse.consentDescription",
      "Claw.Settings.computerUse.consentAccept",
      "Claw.Settings.computerUse.consentCancel",
      "Claw.Settings.computerUse.setupSection",
      "Claw.Settings.computerUse.behaviorSection",
      "Claw.Settings.computerUse.nextGrant",
      "Claw.PermissionGuide.helperDisabled",
    ] as const;
    for (const locale of [en, cn, tw, hk]) {
      const pack = locale as Record<string, string>;
      for (const key of keys) {
        expect(pack[key], key).toBeTruthy();
      }
      expect(pack["Claw.Settings.computerUse.consentTitle"]).toContain("Nuwax Computer Use");
      const body = pack["Claw.Settings.computerUse.consentDescription"];
      expect(body).toContain("Nuwax Computer Use");
      expect(body).toContain("Nuwax.app");
      expect(body.length).toBeLessThan(420);
      expect(pack["Claw.PermissionGuide.helperDisabled"]).toContain("Nuwax Computer Use");
      expect(pack["Claw.Settings.computerUse.nextGrant"]).toContain("Nuwax Computer Use");
    }
    expect(en["Claw.Settings.computerUse.consentDescription"]).toMatch(/not uploaded|are not uploaded/i);
    expect(en["Claw.Settings.computerUse.consentDescription"]).toMatch(/turn it off/i);
    expect(cn["Claw.Settings.computerUse.consentDescription"]).toMatch(/不上传/);
    expect(cn["Claw.Settings.computerUse.consentDescription"]).toMatch(/随时关闭/);
  });

  it("ships Computer Use helper-target copy in all four locales", () => {
    const keys = [
      "Claw.Settings.computerUse.permTargetHint",
      "Claw.Settings.computerUse.permWatching",
      "Claw.Settings.computerUse.openAxPane",
      "Claw.Settings.computerUse.openSrPane",
      "Claw.Settings.computerUse.retryHelper",
      "Claw.Settings.computerUse.helperDown",
      "Claw.Settings.computerUse.errors.timeout",
      "Claw.Settings.computerUse.errors.installRecovery",
      "Claw.Settings.computerUse.errors.installRollback",
      "Claw.Settings.computerUse.errors.helperSignatureFailed",
      "Claw.PermissionGuide.separateIdentity",
      "Claw.PermissionGuide.helperPending",
    ] as const;
    const helperNamed = keys.filter((key) =>
      /TargetHint|Watching|helperDown|timeout|separateIdentity|helperPending/.test(key),
    );
    for (const locale of [en, cn, tw, hk]) {
      for (const key of keys) {
        expect((locale as Record<string, string>)[key], key).toBeTruthy();
      }
      for (const key of helperNamed) {
        expect((locale as Record<string, string>)[key]).toContain("Nuwax Computer Use");
      }
    }
  });
  it("ships all four localizations with matching interpolation slots", () => {
    const keys = Object.keys(en).filter((key) =>
      key.startsWith("Claw.PermissionGuide."),
    );
    for (const locale of [cn, tw, hk]) {
      expect(
        Object.keys(locale).filter((key) =>
          key.startsWith("Claw.PermissionGuide."),
        ),
      ).toEqual(keys);
      for (const key of keys) {
        const value = (locale as Record<string, string>)[key];
        expect(value).toBeTruthy();
        expect(value.match(/\{\d+\}/g)).toEqual(
          (en as Record<string, string>)[key].match(/\{\d+\}/g),
        );
      }
    }
  });
});
