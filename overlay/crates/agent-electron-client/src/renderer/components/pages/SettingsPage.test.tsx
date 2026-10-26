import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ stateIndex: 0 }));

vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    // Exercise the settings content after its asynchronous config load completes.
    useState: (initial: unknown) =>
      actual.useState(h.stateIndex++ === 0 ? false : initial),
  };
});
vi.mock("../../App", () => ({
  useTheme: () => ({ themeMode: "light", setThemeMode: vi.fn() }),
}));
vi.mock("../../services/core/i18n", () => ({ t: (key: string) => key }));
vi.mock("../../services/core/setup", () => ({ setupService: {} }));
vi.mock("../../services/core/workspaceDir", () => ({
  modifyWorkspaceDir: vi.fn(),
  openWorkspaceDir: vi.fn(),
}));
vi.mock("../../features/computer-use", () => ({
  ComputerUseSettings: () => null,
}));

import SettingsPage from "./SettingsPage";

beforeEach(() => {
  h.stateIndex = 0;
  vi.stubGlobal("window", {});
});
afterEach(() => vi.unstubAllGlobals());

it.each([
  ["MacIntel", true],
  ["Win32", false],
  ["Linux x86_64", false],
] as const)("renders loaded settings on %s", (platform, showsAuthorization) => {
  vi.stubGlobal("navigator", { platform });
  const html = renderToStaticMarkup(
    <SettingsPage onOpenAuthorization={vi.fn()} />,
  );
  expect(html).toContain("Claw.Settings.group.service");
  expect(html.includes("Claw.Settings.systemAuthorization.open")).toBe(
    showsAuthorization,
  );
});

it("hides the authorization entry when the host does not provide it", () => {
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  const html = renderToStaticMarkup(<SettingsPage />);
  expect(html).toContain("Claw.Settings.group.service");
  expect(html).not.toContain("Claw.Settings.systemAuthorization.open");
});
