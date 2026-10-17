import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
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
it.each(["granted", "denied", "unknown", "restart_required"] as const)(
  "renders %s with the exact app identity and manual steps",
  (status) => {
    h.snapshot!.items[0].status = status;
    const html = renderToStaticMarkup(<PermissionsPage />);
    expect(html).toContain(`Claw.PermissionGuide.status.${status}`);
    expect(html).toContain("Electron");
    expect(html).toContain("/dev/Electron.app");
    expect(html).toContain("Claw.PermissionGuide.step.screen_recording.2");
    expect(html).toContain("Claw.PermissionGuide.required");
    expect(html).toContain("Claw.PermissionGuide.helperPending");
  },
);
it.each(["win32", "linux"])(
  "shows platform help without macOS permission controls on %s",
  (platform) => {
    h.snapshot!.platform = platform;
    h.snapshot!.items = [];
    const html = renderToStaticMarkup(<PermissionsPage />);
    expect(html).toContain(
      `Claw.PermissionGuide.${platform === "win32" ? "windows" : "linux"}`,
    );
    expect(html).not.toContain("Claw.PermissionGuide.openSettings");
  },
);
it("does not claim helper access from the main app's grant", () => {
  h.target = "helper_accessibility";
  const html = renderToStaticMarkup(<PermissionsPage />);
  expect(html).toContain("Claw.PermissionGuide.helperPending");
  expect(html).not.toContain("Claw.PermissionGuide.step.accessibility.2");
});
