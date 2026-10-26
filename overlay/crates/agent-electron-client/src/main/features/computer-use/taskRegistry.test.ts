import { describe, expect, it } from "vitest";
import { CuaTaskRegistry } from "./taskRegistry";
import { taskCuaCall } from "./taskPolicy";

const windowA = { pid: 10, windowId: 100, label: "private title" };
function setup(max = 4) {
  const registry = new CuaTaskRegistry(max);
  registry.setAvailable(true);
  const a = registry.ensure("host-grant-a"), b = registry.ensure("host-grant-b");
  registry.bind(a.id, windowA); registry.bind(b.id, { pid: 10, windowId: 200, label: "B" });
  registry.resumeTask(a.id); registry.resumeTask(b.id);
  return { registry, a, b };
}

describe("window task ownership and scheduling", () => {
  it("keeps host-resolved conversation metadata on each task after its grant is retired", () => {
    const owners = new Map([["grant-a", "A"], ["grant-b", "B"]]);
    const registry = new CuaTaskRegistry(4, owner => owners.get(owner) ?? null);
    registry.ensure("grant-a"); registry.ensure("grant-b"); registry.ensure("unknown");
    owners.clear();
    expect(registry.list().map(task => task.conversationId)).toEqual(["A", "B", null]);
  });
  it("keeps scope, observations, budgets and cancellation independent for two sessions", () => {
    const { registry, a, b } = setup();
    const observed = registry.begin(a.owner, "get_window_state", { pid: 10, window_id: 100 });
    expect(observed.permit).toBeDefined();
    registry.finish(observed.permit!, "ok", { windows: [] });
    expect(registry.begin(b.owner, "click", { pid: 10, window_id: 200 })).toEqual({ error: "observationRequired" });
    const write = registry.begin(a.owner, "click", { pid: 10, window_id: 100 });
    expect(write.permit).toBeDefined();
    registry.pauseTask(a.id, "userTakingControl");
    expect(registry.valid(write.permit!)).toBe(false);
    expect(registry.finish(write.permit!, "ok")).toBe(false);
    expect(registry.stateForOwner(b.owner)?.phase).toBe("running");
    expect(registry.resumeTask(a.id)).toBe(true);
    expect(registry.begin(a.owner, "click", { pid: 10, window_id: 100 })).toEqual({ error: "observationRequired" });
  });

  it("never grants one window to two tasks, including while a stop is draining", () => {
    const { registry, a, b } = setup();
    registry.pending(a.id, true);
    registry.stopTask(a.id);
    expect(() => registry.bind(b.id, windowA)).toThrow("windowBusy");
    registry.pending(a.id, false);
    expect(() => registry.bind(b.id, windowA)).not.toThrow();
  });

  it("serializes same-process operations until native completion and allows independent processes", async () => {
    const { registry, a, b } = setup();
    const releaseA = await registry.acquire(a.owner);
    let acquiredB = false;
    const next = registry.acquire(b.owner).then((release) => { acquiredB = true; return release; });
    await Promise.resolve();
    expect(acquiredB).toBe(false);
    const c = registry.ensure("C"); registry.bind(c.id, { pid: 11, windowId: 300, label: "" }); registry.resumeTask(c.id);
    const releaseC = await registry.acquire(c.owner);
    registry.pauseTask(a.id);
    await Promise.resolve();
    expect(acquiredB).toBe(false);
    releaseA();
    (await next)(); releaseC();
    expect(acquiredB).toBe(true);
  });

  it("removes revoked queued work without dispatching it", async () => {
    const { registry, a, b } = setup();
    const release = await registry.acquire(a.owner);
    const blocked = registry.acquire(b.owner);
    const rejected = expect(blocked).rejects.toThrow("operationCancelled");
    registry.stopTask(b.id); await rejected; release();
    expect(registry.stateForOwner(a.owner)?.phase).toBe("running");
  });

  it("queues capacity overflow and promotes it without resetting budgets", () => {
    const { registry, a, b } = setup(1);
    expect(registry.stateForOwner(b.owner)?.queued).toBe(true);
    registry.stopTask(a.id);
    expect(registry.stateForOwner(b.owner)?.queued).toBe(false);
    expect(registry.stateForOwner(b.owner)?.phase).toBe("running");
  });

  it("reserves foreground exclusively and never resumes another task implicitly", () => {
    const { registry, a, b } = setup();
    registry.pauseTask(a.id); registry.pauseTask(b.id);
    registry.setMode(a.id, "foreground"); registry.resumeTask(a.id);
    expect(registry.resumeTask(b.id)).toBe(false);
    registry.pauseTask(a.id); registry.setMode(a.id, "background");
    expect(registry.stateForOwner(b.owner)?.phase).toBe("paused");
  });

  it("returns public task ids without exposing grant owners or retaining tool content", () => {
    const { registry } = setup();
    expect(JSON.stringify(registry.snapshot())).not.toContain("host-grant");
    expect(registry.list()).toHaveLength(2);
  });
});

describe("background policy", () => {
  const scope = { kind: "window" as const, ...windowA };
  it("converts discovery reads to the bound window rather than exposing the desktop", () => {
    expect(taskCuaCall(scope, "background", "get_accessibility_tree", {}))
      .toEqual({ tool: "get_window_state", args: { pid: 10, window_id: 100, capture_mode: "ax" } });
    expect(taskCuaCall(scope, "background", "get_desktop_state", {}).tool).toBe("get_window_state");
  });
  it("binds pixel/element operations to the selected window and strips model session fields", () => {
    expect(taskCuaCall(scope, "background", "click", { x: 5, y: 8, session: "other", _session_id: "other" }))
      .toEqual({ tool: "click", args: { pid: 10, window_id: 100, x: 5, y: 8, delivery_mode: "background" } });
  });
  it("requires host approval for foreground and rejects global or foreign-window routes", () => {
    for (const [tool, args] of [["click", { delivery_mode: "foreground" }], ["drag", {}]] as const)
      expect(() => taskCuaCall(scope, "background", tool, args)).toThrow("foregroundRequired");
    for (const [tool, args] of [["clipboard_write", {}], ["click", { pid: 99 }], ["click", { target: { display_id: 1 } }]] as const)
      expect(() => taskCuaCall(scope, "background", tool, args)).toThrow("scopeViolation");
    expect(taskCuaCall(scope, "foreground", "press_key", { key: "ENTER" }).args.delivery_mode).toBe("foreground");
  });
});
