import { describe, expect, it, vi } from "vitest";
import type { CuaRuntime } from "@shared/features/computer-use/contract";
import { createCuaTaskHistory } from "./taskHistory";
const state = (id: string, phase = "completed") => ({ taskId: id, phase, startedAt: 1, updatedAt: 5, stepCount: 3,
  scope: { kind: "window", label: "Test window", pid: 42, windowId: 44 }, steps: [{ arguments: "private text" }], secret: "capability" } as unknown as CuaRuntime);
describe("local Computer Use history", () => {
  it("persists only terminal summaries and never native authority or user action payloads", () => {
    const write = vi.fn(), history = createCuaTaskHistory(() => [], write);
    history.record(state("a", "running")); expect(write).not.toHaveBeenCalled();
    history.record(state("a")); history.record(state("a")); expect(write).toHaveBeenCalledOnce();
    const row = history.list()[0]; expect(Object.keys(row).sort()).toEqual(["taskId", "phase", "label", "startedAt", "endedAt", "stepCount"].sort());
    expect(JSON.stringify(row)).not.toMatch(/private text|capability|pid|windowId/);
    const restored = createCuaTaskHistory(() => history.list(), vi.fn()); expect(restored.list()).toEqual(history.list());
  });
  it("clears history without reviving old rows on the next runtime notification", () => {
    const history = createCuaTaskHistory(() => [], vi.fn()); history.record(state("a")); history.clear(); history.record(state("a"));
    expect(history.list()).toEqual([]); history.record(state("b", "stopped")); expect(history.list().map(row => row.taskId)).toEqual(["b"]);
  });
  it("bounds, validates and copies persisted summaries; storage errors do not block revocation", () => {
    const history = createCuaTaskHistory(() => [null, { phase: "running" }], () => { throw Error("read-only DB"); });
    for (let n = 0; n < 150; n++) history.record(state(String(n)));
    expect(history.list()).toHaveLength(100); expect(history.list()[0].taskId).toBe("149");
    const copy = history.list(); copy[0].label = "changed"; expect(history.list()[0].label).toBe("Test window");
    expect(() => history.clear()).not.toThrow();
  });
});
