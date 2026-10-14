import { describe, expect, it } from "vitest";
import { cuaPolicy, scopeCuaCall } from "./windowScope";
const scope = { kind: "window", pid: 20, windowId: 40, label: "Private title" } as const;
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
  ])("rejects scope escapes through %s", (tool, args) => {
    expect(() => scopeCuaCall(scope, tool as string, args)).toThrow("scopeViolation");
  });
  it("keeps a restored window preference blocked until a new target is selected", () => {
    expect(() => scopeCuaCall({ ...scope, pid: 0, windowId: 0 }, "click", { element_index: 1 })).toThrow("targetClosed");
  });
  it("generates a driver policy with required native IDs and no global input allowance", () => {
    const policy = JSON.parse(cuaPolicy(scope, ["hotkey", "click"], ["replay_trajectory"]));
    expect(policy.allow.tools).not.toContain("click");
    expect(policy.allow.tools).not.toContain("hotkey");
    expect(policy.allow.rules.find((rule: any) => rule.tool === "click").constraints).toEqual({ pid: { allowed: [20] }, window_id: { allowed: [40] }, element_index: { min: 0, max: 100000 } });
    expect(JSON.stringify(policy)).not.toContain("Private title");
  });
});
