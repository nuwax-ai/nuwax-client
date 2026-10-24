import { describe, expect, it } from "vitest";
import { CuaConfirmationGate, classifySensitiveUiTarget, isDeniedCuaApp, sensitiveUiRefusal, isSensitiveCuaCall, matchesCuaBlacklist, normalizeAppId, readCuaAuthMode, readCuaBlacklist } from "./cuaSafety";

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
    expect(isSensitiveCuaCall("click", { name: "OK" })).toBe(true);
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


describe("observed sensitive actions", () => {
  const args = { pid: 25, window_id: 50, snapshot_id: "s00000001", element_index: 7 };
  it("confirms native refs, browser refs and pixels without trusting caller labels", () => {
    const gate = new CuaConfirmationGate();
    expect(gate.requires("A", "click", { ...args, name: "OK" })).toBe(true);
    expect(gate.requires("B", "browser_click", { target_id: "b", tab_id: "t", ref: "e7" })).toBe(true);
    expect(gate.requires("C", "click", { pid: 25, x: 10, y: 20 })).toBe(true);
    expect(gate.allow()).toBe(false);
  });
  it("uses fresh target evidence and binds approval to owner and exact action", () => {
    let now = 100;
    const gate = new CuaConfirmationGate(() => now);
    const observe = (snapshot_id: string) => gate.observe("A", "get_window_state", args, {
      snapshot_id, elements: [{ element_index: 7, name: "付款", role: "button" }, { element_index: 8, name: "Settings", role: "button" }, { element_index: 9, name: "Confirm", role: "button" }],
    });
    observe(args.snapshot_id);
    expect(gate.requires("A", "click", { ...args, element_index: 8 })).toBe(false);
    expect(gate.requires("A", "click", { ...args, element_index: 9 })).toBe(true);
    expect(gate.requires("A", "click", args)).toBe(true);
    expect(gate.allow("A")).toBe(true);
    expect(gate.requires("B", "click", args)).toBe(true);
    observe("s00000002");
    expect(gate.requires("A", "click", { element_index: 7, window_id: 50, pid: 25, snapshot_id: "s00000002" })).toBe(false);
    expect(gate.requires("A", "click", args)).toBe(true);
    gate.allow("A"); now += 60_001;
    expect(gate.requires("A", "click", args)).toBe(true);
    gate.retire("A"); expect(gate.allow("A")).toBe(false);
  });
});
