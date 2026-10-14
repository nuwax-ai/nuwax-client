import { describe, expect, it } from "vitest";
import {
  CUA_ANY, CUA_EXEMPT, classifyReply, observationDigest, observedTargets, writeTarget,
} from "./cuaOutcome";

/** Replies captured from Nuwax Computer Use (cua-driver 0.28.2); see specs/computer-use-control-layer.md appendix B. */
const SAMPLES = {
  windowGone: { result: { isError: true, structuredContent: { code: "window_id_not_found", pid: 999999, window_id: 999999 } } },
  badSnapshot: { result: { isError: true, structuredContent: { refusal: { code: "invalid_snapshot_id", message: "click: snapshot_id has invalid format" }, status: "refused" } } },
  missingPid: { result: { isError: true, structuredContent: { code: "tool_invocation_failed" } } },
  noTargetWindow: { result: { isError: true, structuredContent: { candidates: [], code: "window_target_not_found", effect: "refused", pid: 999999 } } },
  bindingStale: { result: { structuredContent: { refusal: { code: "browser_binding_stale", message: "target bogus is not a live binding" }, status: "refused" } } },
  routeUnavailable: { result: { structuredContent: { effect: "refused", escalation: { reason: "route_unavailable", target: "page" }, route: "trusted_input" } } },
  domScroll: { result: { structuredContent: { delivery: { mode: "background" }, effect: "unverifiable", route: "dom" } } },
};

describe("Computer Use reply classification", () => {
  it("treats every refusal shape as refused, with or without isError", () => {
    expect(classifyReply("click", SAMPLES.badSnapshot)).toBe("refused");
    expect(classifyReply("scroll", SAMPLES.noTargetWindow)).toBe("refused");
    expect(classifyReply("browser_navigate", SAMPLES.bindingStale)).toBe("refused");
    expect(classifyReply("browser_click", SAMPLES.routeUnavailable)).toBe("refused");
    expect(classifyReply("get_browser_state", SAMPLES.bindingStale)).toBe("refused");
  });
  it("never lets a failed read pause the task, and treats argument validation as not executed", () => {
    expect(classifyReply("get_window_state", SAMPLES.windowGone)).toBe("refused");
    expect(classifyReply("click", SAMPLES.missingPid)).toBe("refused");
  });
  it("keeps unexplained write failures and protocol errors uncertain", () => {
    expect(classifyReply("click", { result: { isError: true, structuredContent: { code: "ax_action_failed" } } })).toBe("uncertain");
    expect(classifyReply("type_text", { result: { isError: true } })).toBe("uncertain");
    expect(classifyReply("click", { error: { code: -32000 } })).toBe("uncertain");
    expect(classifyReply("list_windows", { error: { code: -32000 } })).toBe("refused");
  });
  it("accepts dispatched-but-unverifiable browser input as executed", () => {
    expect(classifyReply("browser_pointer", SAMPLES.domScroll)).toBe("ok");
  });
});

describe("Computer Use targets", () => {
  it("maps observations to the targets they refresh", () => {
    expect(observedTargets("get_window_state", { pid: 7, window_id: 9 }, {})).toEqual(["w:9", "p:7"]);
    expect(observedTargets("get_desktop_state", {}, {})).toEqual(["desktop"]);
    expect(observedTargets("get_browser_state", { target_id: "bt-1", tab_id: "tab-1" }, {})).toEqual(["b:bt-1/tab-1"]);
    expect(observedTargets("get_browser_state", { pid: 7, window_id: 9 },
      { target_id: "bt-1", tabs: [{ tab_id: "tab-1", active: true }, { tab_id: "tab-2" }] }))
      .toEqual(["w:9", "p:7", "b:bt-1/tab-1", "b:bt-1/tab-2"]);
    expect(observedTargets("get_accessibility_tree", {}, {})).toBeNull();
    expect(observedTargets("click", { pid: 7 }, {})).toBeNull();
  });
  it("resolves the UI a write acts on", () => {
    expect(writeTarget("browser_click", { target_id: "bt-1", tab_id: "tab-1", ref: "p1:2" })).toBe("b:bt-1/tab-1");
    expect(writeTarget("click", { pid: 7, window_id: 9, element_index: 3 })).toBe("w:9");
    expect(writeTarget("click", { target: { kind: "window", pid: 7, window_id: 9 } })).toBe("w:9");
    expect(writeTarget("scroll", { pid: 7, direction: "down" })).toBe("p:7");
    expect(writeTarget("click", { x: 1, y: 2, scope: "desktop" })).toBe("desktop");
    expect(writeTarget("move_cursor", { x: 1, y: 2 })).toBe("desktop");
    expect(writeTarget("click", { element_token: "s00000001:3" })).toBe(CUA_ANY);
    expect(writeTarget("launch_app", { bundle_id: "com.apple.calculator" })).toBe(CUA_EXEMPT);
    expect(writeTarget("browser_prepare", { allow_launch: true })).toBe(CUA_EXEMPT);
    expect(writeTarget("browser_prepare", { pid: 7, window_id: 9 })).toBe("w:9");
  });
});

describe("Computer Use observation digest", () => {
  it("ignores per-snapshot identifiers but sees layout changes", () => {
    const a = { snapshot_id: "s00000001", elements: [{ element_token: "s00000001:3", label: "OK", frame: { y: 10 } }] };
    const b = { snapshot_id: "s00000002", elements: [{ element_token: "s00000002:3", label: "OK", frame: { y: 10 } }] };
    const scrolled = { snapshot_id: "s00000003", elements: [{ element_token: "s00000003:3", label: "OK", frame: { y: -400 } }] };
    expect(observationDigest(a)).toBe(observationDigest(b));
    expect(observationDigest(a)).not.toBe(observationDigest(scrolled));
    const top = { refs: [{ ref: "p3:0", name: "Pick me", visibility: "offscreen" }] };
    const later = { refs: [{ ref: "p4:0", name: "Pick me", visibility: "offscreen" }] };
    const inView = { refs: [{ ref: "p5:0", name: "Pick me", visibility: "in_viewport" }] };
    expect(observationDigest(top)).toBe(observationDigest(later));
    expect(observationDigest(top)).not.toBe(observationDigest(inView));
  });
});
