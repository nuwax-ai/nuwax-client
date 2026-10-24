import { describe, expect, it } from "vitest";
import { isSensitiveCuaCall, matchesCuaBlacklist, normalizeAppId, readCuaAuthMode, readCuaBlacklist } from "./cuaSafety";

describe("cuaSafety", () => {
  it("treats missing auth mode as unrestricted", () => {
    expect(readCuaAuthMode(undefined)).toBe("unrestricted");
    expect(readCuaAuthMode("ask")).toBe("ask");
    expect(readCuaBlacklist([" 1Password.app ", "1Password", ""])).toEqual(["1Password.app", "1Password"]);
  });

  it("matches blacklist by app name or window title", () => {
    expect(normalizeAppId("1Password.app")).toBe("1password");
    expect(matchesCuaBlacklist(["1Password — Login"], ["1Password.app"])).toBe(true);
    expect(matchesCuaBlacklist(["Safari — Start"], ["1Password"])).toBe(false);
  });

  it("flags kill, clipboard write and pay/send labels as sensitive", () => {
    expect(isSensitiveCuaCall("kill_app", {})).toBe(true);
    expect(isSensitiveCuaCall("clipboard_write", { text: "x" })).toBe(true);
    expect(isSensitiveCuaCall("click", { name: "付款" })).toBe(true);
    expect(isSensitiveCuaCall("click", { name: "OK" })).toBe(false);
    expect(isSensitiveCuaCall("hotkey", { keys: ["meta", "q"] })).toBe(true);
  });
});
