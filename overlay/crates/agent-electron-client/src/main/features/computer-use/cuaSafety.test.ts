import { describe, expect, it } from "vitest";
import {
  classifySensitiveUiTarget, isDeniedCuaApp, isSensitiveCuaCall, matchesCuaBlacklist,
  normalizeAppId, readCuaAuthMode, readCuaBlacklist, sensitiveUiRefusal,
} from "./cuaSafety";

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

  it("hard-denies built-in privilege hosts without treating Safari as loginwindow", () => {
    expect(isDeniedCuaApp(["SecurityAgent"])).toBe(true);
    expect(isDeniedCuaApp(["loginwindow"])).toBe(true);
    expect(isDeniedCuaApp(["Safari — Login"])).toBe(false);
    expect(isDeniedCuaApp(["Safari"], ["1Password"])).toBe(false);
    expect(isDeniedCuaApp(["1Password — Login"], ["1Password.app"])).toBe(true);
  });

  it("classifies password fields, card fields and privilege grants, not forgot-password links or pay buttons", () => {
    expect(classifySensitiveUiTarget("click", { role: "AXSecureTextField", label: "Password" })).toBe("password");
    expect(classifySensitiveUiTarget("set_value", { label: "密码" })).toBe("password");
    expect(classifySensitiveUiTarget("click", { role: "AXLink", label: "Forgot password" })).toBeNull();
    expect(classifySensitiveUiTarget("click", { role: "AXTextField", label: "CVV" })).toBe("paymentField");
    expect(classifySensitiveUiTarget("click", { role: "AXButton", label: "付款" })).toBeNull();
    expect(classifySensitiveUiTarget("click", { role: "AXButton", label: "Allow" }, { title: "Accessibility Access" })).toBe("privilegeDialog");
    expect(classifySensitiveUiTarget("click", { role: "AXButton", label: "Allow" }, { app: "Notes" })).toBeNull();
    expect(isSensitiveCuaCall("click", { name: "付款" })).toBe(true);
    expect(sensitiveUiRefusal("click", {}, { role: "AXSecureTextField" })).toBe("sensitiveTarget");
    expect(sensitiveUiRefusal("click", {}, { role: "AXButton", label: "OK" })).toBeNull();
  });
});
