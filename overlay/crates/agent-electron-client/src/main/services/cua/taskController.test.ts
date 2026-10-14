import { describe, expect, it } from "vitest";
import { CuaTaskController } from "./taskController";

function ready(options = {}) {
  const controller = new CuaTaskController(options);
  controller.setAvailable(true);
  return controller;
}
function call(c: CuaTaskController, owner: string, tool: string, args = {}) {
  const decision = c.begin(owner, tool, args);
  if (decision.permit) c.finish(decision.permit, true);
  return decision;
}
describe("Computer Use desktop ownership", () => {
  it("requires a fresh observation and keeps one owner until session ends", () => {
    const c = ready();
    expect(call(c, "a", "click").error).toBe("observationRequired");
    call(c, "a", "get_desktop_state");
    expect(call(c, "b", "get_desktop_state").error).toBe("desktopBusy");
    expect(call(c, "a", "click").permit).toBeDefined();
    expect(call(c, "a", "type_text").error).toBe("observationRequired");
    call(c, "a", "get_desktop_state");
    expect(call(c, "a", "type_text").permit).toBeDefined();
    call(c, "a", "end_session");
    expect(call(c, "b", "get_desktop_state").permit).toBeDefined();
  });
  it("serializes actions and ignores a late response after pause", () => {
    const c = ready();
    const first = c.begin("a", "get_desktop_state", {}).permit!;
    expect(c.begin("a", "list_windows", {}).error).toBe("operationInProgress");
    c.pause();
    expect(c.finish(first, true)).toBe(false);
    expect(c.resume()).toBe(true);
    expect(call(c, "a", "click").error).toBe("observationRequired");
  });
  it("stopped owners cannot restart by sending another tool", () => {
    const c = ready();
    call(c, "a", "get_desktop_state");
    c.stop();
    expect(call(c, "a", "get_desktop_state").error).toBe("taskStopped");
    expect(call(c, "b", "get_desktop_state").permit).toBeDefined();
  });
  it("failed writes pause without replaying and require observation after resume", () => {
    const c = ready();
    call(c, "a", "get_desktop_state");
    const p = c.begin("a", "click", { x: 4 }).permit!;
    c.finish(p, false);
    expect(c.snapshot().reason).toBe("toolFailed");
    c.resume();
    expect(call(c, "a", "click").error).toBe("observationRequired");
  });
  it("bounds repeated actions across observations and cannot resume past the limit", () => {
    const c = ready();
    for (let i = 0; i < 3; i++) {
      call(c, "a", "get_desktop_state");
      expect(call(c, "a", "click", { x: 1 }).permit).toBeDefined();
    }
    call(c, "a", "get_desktop_state");
    expect(call(c, "a", "click", { x: 1 }).error).toBe("repeatedAction");
    expect(c.resume()).toBe(false);
  });
  it("enforces step and elapsed time budgets", () => {
    const c = ready({ maxSteps: 1 });
    call(c, "a", "get_desktop_state");
    expect(call(c, "a", "click").error).toBe("stepLimit");
    let now = 0;
    const d = ready({ now: () => now, maxTaskMs: 50 });
    call(d, "a", "get_desktop_state");
    now = 51;
    expect(call(d, "a", "click").error).toBe("timeLimit");
  });
  it("expires an abandoned lease without needing another incoming tool call", () => {
    let now = 0;
    const c = ready({ now: () => now, maxTaskMs: 50 });
    call(c, "a", "get_desktop_state");
    now = 51;
    expect(c.checkDeadline()).toBe("timeLimit");
    expect(c.snapshot().phase).toBe("paused");
  });
  it("audits no arguments, user content or owner identity", () => {
    const c = ready();
    call(c, "private-owner", "get_desktop_state");
    call(c, "private-owner", "type_text", { text: "secret-password" });
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
    call(c, "a", "get_desktop_state");
    const pending = c.begin("a", "click", {}).permit!;
    c.disconnect("a");
    c.pause("connectionClosed");
    expect(c.snapshot().phase).toBe("stopped");
    expect(c.finish(pending, true)).toBe(false);
  });
});
