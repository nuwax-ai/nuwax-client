import { describe, expect, it } from "vitest";
import { isSensitiveCuaCall } from "./cuaSafety";
import {
  CuaElementIndex, prepareCuaTargetedCall, readObservationIndex, resolveAndGuardCuaCall,
} from "./cuaTargeting";

const okButton = { element_index: 2, role: "AXButton", label: "OK", frame: { x: 10, y: 20, w: 80, h: 24 } };
const password = { element_index: 5, role: "AXSecureTextField", label: "Password", frame: { x: 100, y: 80, w: 200, h: 28 } };
const canvas = { snapshot_id: "s00000001", app: "Notes", title: "Untitled", elements: [okButton, password] };

describe("cuaTargeting", () => {
  it("reads helper snake_case, camelCase and token indexes", () => {
    const index = readObservationIndex({
      snapshotId: "s00000009",
      app_name: "Safari",
      elements: [
        { elementIndex: 3, role: "AXButton", label: "Done", frame: { x: 1, y: 2, w: 3, h: 4 } },
        { element_token: "s00000009:11", name: "Search", x: 8, y: 9, w: 10, h: 12 },
      ],
    });
    expect(index.snapshot_id).toBe("s00000009");
    expect(index.app).toBe("Safari");
    expect(index.elements.map((item) => item.element_index)).toEqual([3, 11]);
    expect(index.elements[1].frame).toEqual({ x: 8, y: 9, w: 10, h: 12 });
  });

  it("prefers element_index over pixel coordinates when both are present", () => {
    const prepared = prepareCuaTargetedCall("click", { element_index: 2, x: 999, y: 999 }, canvas);
    expect(prepared.args).toEqual({ element_index: 2, snapshot_id: "s00000001" });
    expect(prepared.element?.label).toBe("OK");
    expect(prepared.rewritten).toBe(true);
  });

  it("rewrites a covering coordinate click to the smallest observed element", () => {
    const observation = {
      snapshot_id: "s00000002",
      elements: [
        { element_index: 0, role: "AXWindow", label: "Sheet", frame: { x: 0, y: 0, w: 400, h: 300 } },
        { element_index: 7, role: "AXButton", label: "Save", frame: { x: 40, y: 50, w: 60, h: 20 } },
      ],
    };
    const prepared = prepareCuaTargetedCall("click", { x: 45, y: 55, pid: 12 }, observation);
    expect(prepared.args).toEqual({ element_index: 7, pid: 12, snapshot_id: "s00000002" });
    expect(prepared.element?.label).toBe("Save");
  });

  it("keeps canvas coordinates when no observed element covers the point", () => {
    const prepared = prepareCuaTargetedCall("click", { x: 1, y: 1 }, canvas);
    expect(prepared.args).toEqual({ x: 1, y: 1 });
    expect(prepared.rewritten).toBe(false);
  });

  it("normalizes camelCase elementIndex before forwarding", () => {
    const prepared = prepareCuaTargetedCall("set_value", { elementIndex: 2, value: "hi" }, canvas);
    expect(prepared.args).toEqual({ element_index: 2, value: "hi" });
  });

  it("refuses password fields, card fields and privilege dialogs after resolving the element", () => {
    expect(() => resolveAndGuardCuaCall("click", { element_index: 5 }, canvas)).toThrow("sensitiveTarget");
    expect(() => resolveAndGuardCuaCall("click", { x: 110, y: 90 }, canvas)).toThrow("sensitiveTarget");
    expect(() => resolveAndGuardCuaCall("set_value", { element_index: 4, value: "4111" }, {
      elements: [{ element_index: 4, role: "AXTextField", label: "Card number" }],
    })).toThrow("sensitiveTarget");
    expect(() => resolveAndGuardCuaCall("click", { element_index: 1 }, {
      app: "SecurityAgent",
      elements: [{ element_index: 1, role: "AXButton", label: "Allow" }],
    })).toThrow("sensitiveTarget");
    expect(resolveAndGuardCuaCall("click", { x: 12, y: 22 }, canvas).args).toEqual({
      element_index: 2, snapshot_id: "s00000001",
    });
  });

  it("does not hard-deny forgot-password links or ask-mode pay buttons", () => {
    const forgot = { elements: [{ element_index: 1, role: "AXLink", label: "Forgot password" }] };
    expect(resolveAndGuardCuaCall("click", { element_index: 1 }, forgot).args).toEqual({ element_index: 1 });
    const pay = { name: "付款" };
    expect(isSensitiveCuaCall("click", pay)).toBe(true);
    expect(resolveAndGuardCuaCall("click", pay, { elements: [] }).args).toEqual(pay);
  });

  it("remembers only successful observations per owner", () => {
    const index = new CuaElementIndex();
    index.remember("a", "click", "ok", canvas);
    index.remember("a", "get_window_state", "refused", canvas);
    expect(index.latest("a").elements).toEqual([]);
    index.remember("a", "get_window_state", "ok", canvas);
    index.remember("b", "get_desktop_state", "ok", { elements: [okButton] });
    expect(index.latest("a").elements).toHaveLength(2);
    expect(index.latest("b").elements).toHaveLength(1);
    index.forget("a");
    expect(index.latest("a").elements).toEqual([]);
    expect(index.latest("b").elements).toHaveLength(1);
  });
});
