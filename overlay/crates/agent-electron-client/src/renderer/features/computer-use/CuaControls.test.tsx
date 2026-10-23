import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const harness = vi.hoisted(() => ({ states: [] as any[], cursor: 0, effects: [] as any[], buttons: [] as any[], error: vi.fn() }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: () => {
    const index = harness.cursor++;
    return [harness.states[index], (value: any) => { harness.states[index] = typeof value === "function" ? value(harness.states[index]) : value; }];
  },
  useEffect: (effect: any) => harness.effects.push(effect),
}));
vi.mock("antd", async () => {
  const { default: R } = await import("react");
  const Container = ({ children }: any) => <span>{children}</span>;
  return { Select: Container, Space: Container, Tag: Container, Alert: ({ message }: any) => <div>{message}</div>, message: { error: harness.error }, theme: { useToken: () => ({ token: {} }) },
    Button: (props: any) => { harness.buttons.push(props); return <button disabled={props.disabled}>{props.children}</button>; },
  };
});
vi.mock("./CuaTaskCenter", () => ({ CuaTaskCenter: () => null }));
import { CuaControls, CuaSettingsRows } from "./CuaControls";
const api = { getRuntime: vi.fn(), pause: vi.fn(), resume: vi.fn(), stop: vi.fn(), recover: vi.fn(), setMultiwindowEnabled: vi.fn() };
beforeEach(() => {
  vi.resetAllMocks(); harness.cursor = 0; harness.effects = []; harness.buttons = [];
  harness.states = [{ phase: "running", taskId: "id", revision: 2, stepCount: 2, steps: [], needsObservation: true, shortcutAvailable: false }, false, null, false];
  api.getRuntime.mockResolvedValue(harness.states[0]); api.stop.mockResolvedValue({ success: true });
  vi.stubGlobal("window", Object.assign(new EventTarget(), { electronAPI: { on: vi.fn(), off: vi.fn() } }));
});
afterEach(() => vi.unstubAllGlobals());
const render = () => renderToStaticMarkup(<CuaControls api={api as any} t={(key) => key} />);
const Row = ({ label, desc, control }: any) => <section><h4>{label}</h4><p>{desc}</p>{control}</section>;
const renderRows = () => renderToStaticMarkup(<CuaSettingsRows api={api as any} t={(key) => key} Row={Row} />);
describe("Computer Use controls", () => {
  it("leaves multiwindow floating controls to the host PiP instead of adding a second panel", () => {
    harness.states[0] = { ...harness.states[0], multiwindow: true, tasks: [] };
    expect(render()).toBe("");
  });
  it("keeps explicit recovery in settings after a multiwindow emergency stop", async () => {
    harness.states = [{ ...harness.states[0], phase: "stopped", multiwindow: true, recoverable: true, tasks: [] }, false, [], false, null, [], null];
    api.recover.mockResolvedValue({ success: true });
    expect(renderRows()).toContain("Claw.Cua.multiwindow.title");
    const recover = harness.buttons.find((button) => button.children === "Claw.Cua.recover");
    expect(recover.disabled).toBe(false); await recover.onClick();
    expect(api.recover).toHaveBeenCalledOnce();
  });
  it("keeps a single settings row and leaves the live task list in the tray center", () => {
    harness.states = [{ ...harness.states[0], multiwindow: true, tasks: [] }, false, [], false, null];
    const html = renderRows();
    expect(html.split("Claw.Cua.multiwindow.title")).toHaveLength(2);
    expect(html).not.toContain("Claw.Cua.scope.refresh");
    expect(html).not.toContain("Claw.Cua.multiwindow.stopAll");
  });
  it("keeps emergency stop enabled during another pending operation", () => {
    harness.states[3] = true;
    expect(render()).toContain("Claw.Cua.shortcutUnavailable");
    expect(harness.buttons.find((b) => b.children === "Claw.Cua.stop").disabled).toBeUndefined();
    expect(harness.buttons.find((b) => b.children === "Claw.Cua.pause").disabled).toBe(true);
  });
  it("shows stopping until input has actually stopped", () => {
    harness.states[0] = { ...harness.states[0], phase: "paused", controlPending: true, reason: "userPaused" };
    const html = render();
    expect(html).toContain("Claw.Cua.stopping");
    expect(html).not.toContain("Claw.Cua.reason.userPaused");
  });
  it("removes terminal sessions from the live-only floating control", () => {
    harness.states[0] = { ...harness.states[0], phase: "completed", resultObserved: false };
    expect(render()).toBe("");
  });
  it("explains a resumable no-progress pause and labels refused steps", () => {
    harness.states[0] = { ...harness.states[0], phase: "paused", reason: "noProgress",
      steps: [{ sequence: 1, tool: "browser_click", startedAt: 0, outcome: "refused" }] };
    const html = render();
    expect(html).toContain("Claw.Cua.reason.noProgress");
    expect(html).toContain("Claw.Cua.outcome.refused");
  });
  it("keeps the control bar hidden without a task", () => {
    harness.states[0] = { ...harness.states[0], phase: "idle", taskId: null };
    expect(render()).toBe("");
  });
  it("offers scope and diagnostics as settings rows, locked while a task runs", () => {
    harness.states = [{ ...harness.states[0], phase: "idle", taskId: null }, false, [], false, null];
    const html = renderRows();
    expect(html).toContain("Claw.Settings.computerUse.scope");
    expect(html).toContain("Claw.Cua.scope.explanation");
    expect(html).toContain("Claw.Settings.computerUse.diagnostics");
    expect(html).not.toContain("Claw.Cua.modelExplanation");
    harness.cursor = 0; harness.buttons = [];
    harness.states[0] = { ...harness.states[0], phase: "running", taskId: "id" };
    renderRows();
    expect(harness.buttons.find((b) => b.children === "Claw.Cua.clear").disabled).toBe(true);
  });
  it("ignores stale snapshots and removes subscriptions on unmount", async () => {
    let resolve!: (value: unknown) => void;
    api.getRuntime.mockReturnValue(new Promise((done) => { resolve = done; }));
    render(); const cleanup = harness.effects[0]();
    const listener = (window.electronAPI!.on as any).mock.calls[0][1];
    listener({ ...harness.states[0], phase: "stopped", revision: 4 });
    resolve({ phase: "running", revision: 3 }); await Promise.resolve();
    expect(harness.states[0].phase).toBe("stopped");
    cleanup(); expect(window.electronAPI!.off).toHaveBeenCalledWith("cua:runtime", listener);
  });
});
