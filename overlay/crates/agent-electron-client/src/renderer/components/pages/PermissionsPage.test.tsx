import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PermissionSnapshot } from "@shared/types/permissionOnboarding";
const h = vi.hoisted(() => ({
  snapshot: null as PermissionSnapshot | null,
  cursor: 0,
  target: "screen_recording",
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = h.cursor++;
    return [
      index === 0 ? h.snapshot : index === 1 ? h.target : initial,
      vi.fn(),
    ];
  },
  useEffect: vi.fn(),
}));
vi.mock("../../services/core/i18n", () => ({
  t: (key: string, ...args: string[]) => `${key} ${args.join(" ")}`,
}));
import PermissionsPage from "./PermissionsPage";
beforeEach(() => {
  h.cursor = 0;
  h.target = "screen_recording";
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  h.snapshot = {
    platform: "darwin",
    appName: "Electron",
    appPath: "/dev/Electron.app",
    seen: false,
    helperAvailable: false,
    items: [
      { key: "screen_recording", status: "denied", probe: "denied" },
      { key: "file_access", status: "unknown", probe: "unknown" },
    ],
  };
  vi.stubGlobal("window", { electronAPI: { permissionOnboarding: {} } });
});
afterEach(() => vi.unstubAllGlobals());
it.each(["granted", "denied", "unknown", "restart_required"] as const)(
  "renders %s with the exact app identity and manual steps",
  (status) => {
    h.snapshot!.items[0].status = status;
    const html = renderToStaticMarkup(<PermissionsPage />);
    expect(html).toContain(
      `Claw.PermissionGuide.status.${
        status === "restart_required" ? "restartRequired" : status
      }`,
    );
    expect(html).toContain("Electron");
    expect(html).toContain("/dev/Electron.app");
    expect(html).toContain("Claw.PermissionGuide.step.screenRecording.step2");
    expect(html).toContain("Claw.PermissionGuide.required");
    expect(html).toContain("Claw.PermissionGuide.helperPending");
  },
);
it("hides Windows permission content even if navigated directly", () => {
  h.snapshot!.platform = "win32";
  h.snapshot!.items = [];
  expect(renderToStaticMarkup(<PermissionsPage />)).toBe("");
});
it("hides Windows permission content before any snapshot arrives", () => {
  vi.stubGlobal("navigator", { platform: "Win32" });
  h.snapshot = null;
  expect(renderToStaticMarkup(<PermissionsPage />)).toBe("");
});
it("preserves Linux capture help without macOS permission controls", () => {
  h.snapshot!.platform = "linux";
  h.snapshot!.items = [];
  const html = renderToStaticMarkup(<PermissionsPage />);
  expect(html).toContain("Claw.PermissionGuide.linux");
  expect(html).toContain("Claw.PermissionGuide.testCapture");
  expect(html).not.toContain("Claw.PermissionGuide.openSettings");
});
it("does not claim helper access from the main app's grant", () => {
  h.target = "helper_accessibility";
  const html = renderToStaticMarkup(<PermissionsPage />);
  expect(html).toContain("Claw.PermissionGuide.helperPending");
  expect(html).not.toContain("Claw.PermissionGuide.step.accessibility.step2");
});
