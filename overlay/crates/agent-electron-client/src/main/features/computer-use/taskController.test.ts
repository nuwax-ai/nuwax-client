import { describe, expect, it } from "vitest";
import { CuaTaskController } from "./taskController";
import type { CuaOutcome } from "./cuaOutcome";

function ready(options = {}) {
  const controller = new CuaTaskController(options);
  controller.setAvailable(true);
  return controller;
}
function call(c: CuaTaskController, owner: string, tool: string, args: unknown = {}, outcome: CuaOutcome = "ok", structured: unknown = {}) {
  const decision = c.begin(owner, tool, args);
  if (decision.permit) c.finish(decision.permit, outcome, structured);
  return decision;
}
const desktop = (c: CuaTaskController, owner = "a", seen: unknown = {}) => call(c, owner, "get_desktop_state", {}, "ok", seen);

describe("Computer Use desktop ownership", () => {
  it("requires an observation before acting and keeps one owner until the session ends", () => {
    const c = ready();
    expect(call(c, "a", "click").error).toBe("observationRequired");
    desktop(c);
    expect(desktop(c, "b").error).toBe("desktopBusy");
    expect(call(c, "a", "click").permit).toBeDefined();
    call(c, "a", "end_session");
    expect(desktop(c, "b").permit).toBeDefined();
  });
  it("serializes actions and ignores a late response after pause", () => {
    const c = ready();
    const first = c.begin("a", "get_desktop_state", {}).permit!;
    expect(c.begin("a", "list_windows", {}).error).toBe("operationInProgress");
    c.pause();
    expect(c.finish(first, "ok")).toBe(false);
    expect(c.resume()).toBe(true);
    expect(call(c, "a", "click").error).toBe("observationRequired");
  });
  it("stopped owners cannot restart by sending another tool", () => {
    const c = ready();
    desktop(c);
    c.stop();
    expect(desktop(c).error).toBe("taskStopped");
    expect(desktop(c, "b").permit).toBeDefined();
  });
});

describe("Computer Use observation allowance", () => {
  it("allows a few writes per observation, then asks to look again", () => {
    const c = ready();
    desktop(c);
    for (let i = 0; i < 3; i++) expect(call(c, "a", "type_text", { text: `${i}` }).permit).toBeDefined();
    expect(call(c, "a", "click").error).toBe("observationRequired");
    expect(c.snapshot().needsObservation).toBe(true);
  });
  it("binds the allowance to the observed target", () => {
    const c = ready();
    call(c, "a", "get_window_state", { pid: 7, window_id: 9 });
    expect(call(c, "a", "click", { pid: 7, window_id: 9, element_index: 1 }).permit).toBeDefined();
    expect(call(c, "a", "scroll", { pid: 7, direction: "down" }).permit).toBeDefined();
    expect(call(c, "a", "click", { pid: 8, window_id: 10, element_index: 1 }).error).toBe("observationRequired");
    expect(call(c, "a", "browser_click", { target_id: "bt", tab_id: "t", ref: "p1:1" }).error).toBe("observationRequired");
  });
  it("lets a desktop observation cover native windows but never browser refs", () => {
    const c = ready();
    desktop(c);
    expect(call(c, "a", "click", { pid: 8, window_id: 10, element_index: 1 }).permit).toBeDefined();
    expect(call(c, "a", "browser_click", { target_id: "bt", tab_id: "t", ref: "p1:1" }).error).toBe("observationRequired");
    call(c, "a", "get_browser_state", { pid: 7, window_id: 9 }, "ok", { target_id: "bt", tabs: [{ tab_id: "t" }] });
    expect(call(c, "a", "browser_click", { target_id: "bt", tab_id: "t", ref: "p1:1" }).permit).toBeDefined();
  });
  it("does not count a refused observation as having looked", () => {
    const c = ready();
    call(c, "a", "get_browser_state", { target_id: "bt", tab_id: "t" }, "refused");
    expect(call(c, "a", "browser_click", { target_id: "bt", tab_id: "t", ref: "p1:1" }).error).toBe("observationRequired");
    expect(c.snapshot().stats.refused).toBe(2);
  });
  it("lets the model open an app without looking first", () => {
    const c = ready();
    expect(call(c, "a", "launch_app", { bundle_id: "com.apple.calculator" }).permit).toBeDefined();
  });
  it("no longer accepts a bare window list as an observation", () => {
    const c = ready();
    call(c, "a", "get_accessibility_tree");
    expect(call(c, "a", "click").error).toBe("observationRequired");
  });
});

describe("Computer Use failures", () => {
  it("hands refused calls back without pausing", () => {
    const c = ready();
    desktop(c);
    expect(call(c, "a", "click", { element_token: "s1:3" }, "refused").permit).toBeDefined();
    expect(c.snapshot().phase).toBe("running");
    expect(c.snapshot().steps.at(-1)?.outcome).toBe("refused");
  });
  it("pauses on an uncertain write, without replaying, and requires observation after resume", () => {
    const c = ready();
    desktop(c);
    call(c, "a", "click", { x: 4 }, "uncertain");
    expect(c.snapshot()).toMatchObject({ phase: "paused", reason: "uncertainResult" });
    expect(c.resume()).toBe(true);
    expect(call(c, "a", "click").error).toBe("observationRequired");
  });
  it("stops after repeated policy violations and cannot be resumed", () => {
    const c = ready();
    desktop(c);
    c.recordRejection("a", "scopeViolation");
    c.recordRejection("a", "observationRequired");
    c.recordRejection("a", "toolNotAllowed");
    expect(c.snapshot().phase).toBe("running");
    c.recordRejection("a", "scopeViolation");
    expect(c.snapshot()).toMatchObject({ phase: "stopped", reason: "violationLimit" });
    expect(desktop(c).error).toBe("taskStopped");
  });
  it("ignores rejections reported for someone who does not own the task", () => {
    const c = ready();
    desktop(c);
    for (let i = 0; i < 5; i++) c.recordRejection("b", "scopeViolation");
    expect(c.snapshot().phase).toBe("running");
  });
});

describe("Computer Use progress detection", () => {
  it("pauses the same write when nothing observed has changed, and allows resuming", () => {
    const c = ready();
    for (let i = 0; i < 3; i++) {
      desktop(c, "a", { same: true });
      expect(call(c, "a", "scroll", { direction: "down" }).permit).toBeDefined();
    }
    desktop(c, "a", { same: true });
    expect(call(c, "a", "scroll", { direction: "down" }).error).toBe("noProgress");
    expect(c.snapshot()).toMatchObject({ phase: "paused", reason: "noProgress" });
    expect(c.resume()).toBe(true);
    desktop(c, "a", { same: true });
    expect(call(c, "a", "scroll", { direction: "down" }).permit).toBeDefined();
  });
  it("keeps repeating a write while each observation shows progress, up to a hard cap", () => {
    const c = ready();
    for (let i = 0; i < 12; i++) {
      desktop(c, "a", { offset: i });
      expect(call(c, "a", "scroll", { direction: "down" }).permit).toBeDefined();
    }
    desktop(c, "a", { offset: 99 });
    expect(call(c, "a", "scroll", { direction: "down" }).error).toBe("noProgress");
  });
  it("does not treat different writes as repetition", () => {
    const c = ready();
    for (let i = 0; i < 6; i++) {
      desktop(c, "a", { same: true });
      expect(call(c, "a", "press_key", { key: i % 2 ? "up" : "down" }).permit).toBeDefined();
    }
  });
});

describe("Computer Use budgets and audit", () => {
  it("enforces step and elapsed time budgets, which resume cannot reset", () => {
    const c = ready({ maxSteps: 1 });
    desktop(c);
    expect(call(c, "a", "click").error).toBe("stepLimit");
    expect(c.resume()).toBe(false);
    let now = 0;
    const d = ready({ now: () => now, maxTaskMs: 50 });
    desktop(d);
    now = 51;
    expect(call(d, "a", "click").error).toBe("timeLimit");
  });
  it("expires an abandoned lease without needing another incoming tool call", () => {
    let now = 0;
    const c = ready({ now: () => now, maxTaskMs: 50 });
    desktop(c);
    now = 51;
    expect(c.checkDeadline()).toBe("timeLimit");
    expect(c.snapshot().phase).toBe("paused");
  });
  it("counts outcomes without recording arguments, user content or owner identity", () => {
    const c = ready();
    desktop(c, "private-owner");
    call(c, "private-owner", "type_text", { text: "secret-password" });
    call(c, "private-owner", "click", { x: 1 }, "refused");
    call(c, "private-owner", "click", { x: 2 }, "uncertain");
    c.resume();
    expect(c.snapshot().stats).toEqual({ steps: 4, refused: 1, uncertain: 1, pauses: 1, resumes: 1, violations: 0 });
    const json = JSON.stringify(c.snapshot());
    expect(json).not.toContain("secret-password");
    expect(json).not.toContain("private-owner");
    expect(c.clearHistory()).toBe(false);
    c.stop();
    expect(c.clearHistory()).toBe(true);
  });
  it("revokes even when a UI listener throws, and preserves the disconnected recovery state", () => {
    const c = ready();
    c.subscribe(() => { throw new Error("window closed"); });
    desktop(c);
    const pending = c.begin("a", "click", {}).permit!;
    c.disconnect("a");
    c.pause("connectionClosed");
    expect(c.snapshot().phase).toBe("stopped");
    expect(c.finish(pending, "ok")).toBe(false);
  });
});
