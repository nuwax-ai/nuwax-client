import { describe, expect, it } from "vitest";
import { CuaBrowserBindings, cuaPolicy, scopeCuaCall, visibleCuaTools } from "./windowScope";
const scope = { kind: "window", pid: 20, windowId: 40, label: "Private title" } as const;
const desktop = { kind: "desktop" } as const;
const BROWSER = ["get_browser_state", "browser_prepare", "browser_navigate", "browser_click", "browser_type", "browser_pointer", "browser_dialog"];

function bound() {
  const bindings = new CuaBrowserBindings();
  const bind = scopeCuaCall(scope, "get_browser_state", {}, bindings);
  bindings.record(scope, bind.tool, bind.args, "ok", { target_id: "bt-1", tabs: [{ tab_id: "tab-1", active: true }, { tab_id: "tab-2" }] });
  return bindings;
}

describe("CUA exact window scope", () => {
  it("binds desktop observation and element input to the selected native target", () => {
    expect(scopeCuaCall(scope, "get_desktop_state", {})).toEqual({ tool: "get_window_state", args: { pid: 20, window_id: 40 } });
    expect(scopeCuaCall(scope, "set_value", { element_index: 7, value: "text" }).args).toEqual({ element_index: 7, value: "text", pid: 20, window_id: 40 });
  });
  it.each([
    ["click", { x: 10, y: 10 }], ["click", { element_index: 1, foreground: true }],
    ["click", { element_index: 1, pid: 99 }], ["set_value", { element_index: 1, window_id: 99 }],
    ["click", { element_index: -1 }], ["click", { element_index: "1" }],
    ["get_window_state", { target: { pid: 99 } }], ["press_key", { key: "ENTER" }],
    ["browser_navigate", { url: "https://example.test" }], ["launch_app", {}], ["start_recording", {}],
    ["clipboard_write", { text: "secret" }], ["get_window_state", { scope: "desktop" }],
    ["browser_download", { target_id: "bt-1", tab_id: "tab-1" }], ["page", { action: "get_text" }],
  ])("rejects scope escapes through %s", (tool, args) => {
    expect(() => scopeCuaCall(scope, tool as string, args, bound())).toThrow("scopeViolation");
  });
  it("keeps a restored window preference blocked until a new target is selected", () => {
    expect(() => scopeCuaCall({ ...scope, pid: 0, windowId: 0 }, "click", { element_index: 1 })).toThrow("targetClosed");
  });
  it("generates a driver policy with required native IDs and no global input allowance", () => {
    const policy = JSON.parse(cuaPolicy(scope, ["hotkey", "click", ...BROWSER], ["replay_trajectory"]));
    expect(policy.allow.tools).not.toContain("click");
    expect(policy.allow.tools).not.toContain("hotkey");
    expect(policy.allow.tools).not.toContain("browser_prepare");
    expect(policy.allow.rules.find((rule: any) => rule.tool === "click").constraints).toEqual({ pid: { allowed: [20] }, window_id: { allowed: [40] }, element_index: { min: 0, max: 100000 } });
    expect(policy.allow.rules.find((rule: any) => rule.tool === "browser_prepare").constraints).toEqual({ pid: { allowed: [20] }, window_id: { allowed: [40] } });
    expect(JSON.stringify(policy)).not.toContain("Private title");
  });
});

describe("CUA window scope for a browser window", () => {
  it("shows browser tools in window mode, but not downloads, uploads or the legacy page tool", () => {
    const visible = visibleCuaTools(scope, [...BROWSER, "browser_download", "browser_set_input_files", "page", "hotkey"]);
    expect(visible).toEqual(BROWSER);
  });
  it("binds and attaches only the selected window", () => {
    expect(scopeCuaCall(scope, "get_browser_state", { snapshot_format: "semantic_v2" }).args)
      .toEqual({ snapshot_format: "semantic_v2", pid: 20, window_id: 40 });
    expect(scopeCuaCall(scope, "browser_prepare", { strategy: { kind: "existing_profile" } }).args)
      .toEqual({ strategy: { kind: "existing_profile" }, pid: 20, window_id: 40 });
    for (const args of [{ pid: 99 }, { window_id: 99 }, { allow_launch: true }, { profile: { mode: "isolated_new" } }, { strategy: { kind: "other" } }]) {
      expect(() => scopeCuaCall(scope, "browser_prepare", args)).toThrow("scopeViolation");
    }
    expect(() => scopeCuaCall(scope, "get_browser_state", { pid: 99, window_id: 98 })).toThrow("scopeViolation");
  });
  it("allows browser actions only on tabs bound from the selected window", () => {
    const bindings = bound();
    expect(scopeCuaCall(scope, "browser_click", { target_id: "bt-1", tab_id: "tab-2", ref: "p1:1" }, bindings).tool).toBe("browser_click");
    expect(scopeCuaCall(scope, "get_browser_state", { target_id: "bt-1", tab_id: "tab-1" }, bindings).tool).toBe("get_browser_state");
    expect(() => scopeCuaCall(scope, "browser_click", { target_id: "bt-9", tab_id: "tab-1" }, bindings)).toThrow("scopeViolation");
    expect(() => scopeCuaCall(scope, "browser_type", { target_id: "bt-1", tab_id: "tab-9", ref: "p1:1", text: "x" }, bindings)).toThrow("scopeViolation");
    bindings.clear();
    expect(() => scopeCuaCall(scope, "browser_click", { target_id: "bt-1", tab_id: "tab-1" }, bindings)).toThrow("scopeViolation");
  });
  it("records bindings only from a successful bind of the selected window", () => {
    const bindings = new CuaBrowserBindings();
    const tabs = { target_id: "bt-1", tabs: [{ tab_id: "tab-1" }] };
    bindings.record(scope, "get_browser_state", { pid: 20, window_id: 40 }, "refused", tabs);
    bindings.record(scope, "get_browser_state", { pid: 21, window_id: 40 }, "ok", tabs);
    bindings.record(desktop, "get_browser_state", { pid: 20, window_id: 40 }, "ok", tabs);
    bindings.record(scope, "get_browser_state", { target_id: "bt-1", tab_id: "tab-1" }, "ok", tabs);
    expect(bindings.has("bt-1", "tab-1")).toBe(false);
    bindings.record(scope, "get_browser_state", { pid: 20, window_id: 40 }, "ok", tabs);
    expect(bindings.has("bt-1", "tab-1")).toBe(true);
  });
});

describe("CUA desktop scope", () => {
  it("collapses identical native target formats before driver dispatch", () => {
    const args = { pid: 20, window_id: 40, target: { kind: "window", pid: 20, window_id: 40 }, element_token: "s00000001:1", text: "marker" };
    expect(scopeCuaCall(desktop, "type_text", args).args).toEqual({ pid: 20, window_id: 40, element_token: "s00000001:1", text: "marker" });
    expect(args.target).toEqual({ kind: "window", pid: 20, window_id: 40 });
    expect(scopeCuaCall(desktop, "click", { scope: "window", target: args.target, element_index: 1 }).args)
      .toEqual({ pid: 20, window_id: 40, element_index: 1 });
  });
  it.each([
    { pid: 21 }, { window_id: 41 }, { scope: "desktop" }, { pid: "20" },
    { pid: 20, target: { kind: "desktop", display_id: "primary" } },
    { pid: 20, target: { kind: "window", pid: 20, window_id: 40, app: "other" } },
  ])("refuses ambiguous mixed native targets without choosing an identity: %j", (extra) => {
    expect(() => scopeCuaCall(desktop, "type_text", { target: { kind: "window", pid: 20, window_id: 40 }, ...extra }))
      .toThrow("scopeViolation");
  });
  it("preserves a single explicit target format", () => {
    const args = { target: { kind: "window", pid: 20, window_id: 40 }, element_token: "s00000001:1", text: "marker" };
    expect(scopeCuaCall(desktop, "type_text", args).args).toEqual(args);
  });
  it("refuses attaching to the user's own browser profile but allows an isolated browser", () => {
    expect(() => scopeCuaCall(desktop, "browser_prepare", { pid: 7, window_id: 9, strategy: { kind: "existing_profile" } }))
      .toThrow("profileAttachRequiresWindowScope");
    expect(scopeCuaCall(desktop, "browser_prepare", { allow_launch: true, profile: { mode: "isolated_new" } }).tool).toBe("browser_prepare");
    expect(scopeCuaCall(desktop, "browser_click", { target_id: "bt-1", tab_id: "tab-1" }).tool).toBe("browser_click");
  });
});
