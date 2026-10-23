import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ states: [] as any[], cursor: 0, effects: [] as any[], buttons: [] as any[], panel: vi.fn() }));
vi.mock("react", async original => ({ ...(await original<typeof import("react")>()),
  useState: () => { const n = h.cursor++; return [h.states[n], (value: any) => { h.states[n] = value; }]; },
  useEffect: (effect: any) => { h.effects.push(effect); },
}));
vi.mock("antd", () => ({
  Modal: ({ children }: any) => <section>{children}</section>, Space: ({ children }: any) => <div>{children}</div>,
  Tag: ({ children }: any) => <span>{children}</span>, Empty: Object.assign(({ description }: any) => <div>{description}</div>, { PRESENTED_IMAGE_SIMPLE: "" }),
  Tabs: ({ activeKey, items }: any) => <div>{items.find((item: any) => item.key === activeKey).children}</div>,
  Button: (props: any) => { h.buttons.push(props); return <button>{props.children}</button>; }, message: { error: vi.fn() },
}));
vi.mock("./CuaTaskPanel", () => ({ CuaTaskPanel: (props: any) => { h.panel(props); return <div>live windows</div>; } }));
import { CuaTaskCenter } from "./CuaTaskCenter";
const api = { getTaskHistory: vi.fn(), clearTaskHistory: vi.fn(), stop: vi.fn() };
const runtime = { revision: 1, multiwindow: true, tasks: [
  { taskId: "active", phase: "running" }, { taskId: "paused", phase: "paused" }, { taskId: "ended", phase: "completed" },
] };
const render = () => { h.cursor = 0; return renderToStaticMarkup(<CuaTaskCenter api={api as any} runtime={runtime as any} accept={vi.fn()} t={key => key} />); };
beforeEach(() => {
  h.states = [false, [], "active"]; h.cursor = 0; h.effects = []; h.buttons = []; vi.clearAllMocks();
  vi.stubGlobal("window", { electronAPI: { on: vi.fn(), off: vi.fn() } });
  api.getTaskHistory.mockResolvedValue([]); api.clearTaskHistory.mockResolvedValue({ success: true });
});
afterEach(() => vi.unstubAllGlobals());
describe("tray task center", () => {
  it("opens only on its tray event and keeps terminal entries out of the live controls", () => {
    expect(render()).toBe(""); const off = h.effects[0]();
    const [name, show] = vi.mocked(window.electronAPI.on).mock.calls[0]; expect(name).toBe("cua:openCenter"); show();
    expect(render()).toContain("live windows"); expect(h.panel.mock.calls[0][0].runtime.tasks.map((task: any) => task.taskId)).toEqual(["active", "paused"]);
    off(); expect(window.electronAPI.off).toHaveBeenCalledWith("cua:openCenter", show);
  });
  it("renders persisted summaries without resume or takeover and clears only those summaries", async () => {
    h.states = [true, [{ taskId: "ended", phase: "completed", label: "Old app", endedAt: 100, stepCount: 2 }], "history"];
    const html = render(); expect(html).toContain("Old app"); expect(html).not.toContain("live windows"); expect(h.panel).not.toHaveBeenCalled();
    await h.buttons.find(button => button.children === "Claw.Cua.clear").onClick();
    expect(api.clearTaskHistory).toHaveBeenCalledOnce(); expect(api.stop).not.toHaveBeenCalled(); expect(h.states[1]).toEqual([]);
  });
  it("ignores a pending history read after the center closes", async () => {
    h.states[0] = true; let resolve!: (rows: any[]) => void; api.getTaskHistory.mockReturnValue(new Promise(done => { resolve = done; }));
    render(); const cleanup = h.effects[1](); cleanup(); resolve([{ taskId: "late" }]); await Promise.resolve();
    expect(h.states[1]).toEqual([]);
  });
  it("shows mode and window scope when present without requiring them on old history", () => {
    h.states = [true, [{ taskId: "ended", phase: "completed", label: "Editor", endedAt: 100, stepCount: 2, scopeKind: "window", mode: "background" }], "history"];
    const html = render(); expect(html).toContain("Claw.Cua.multiwindow.background"); expect(html).toContain("Claw.Cua.scope.window");
  });

});
