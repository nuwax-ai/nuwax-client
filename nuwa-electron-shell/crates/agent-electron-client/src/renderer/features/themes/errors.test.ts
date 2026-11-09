import { expect, it } from "vitest";
import { relativeThemeDetail } from "./errors";
it("retains relative CSS diagnostics and hides storage paths", () => {
  expect(
    relativeThemeDetail("styles/shell.css: unsupported property position")
  ).toBe("styles/shell.css: unsupported property position");
  expect(
    relativeThemeDetail("theme.json.variants.light.tokens: missing JSON")
  ).toBe("theme.json.variants.light.tokens: missing JSON");
  for (const error of [
    "ENOENT /Users/private/theme.json",
    "Theme storage unavailable",
    "/private/tmp/theme.css: error",
    "C:\\secret\\theme.css: denied",
  ])
    expect(relativeThemeDetail(error)).toBe("");
});
