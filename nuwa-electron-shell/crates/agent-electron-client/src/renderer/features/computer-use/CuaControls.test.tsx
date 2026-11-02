import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const harness = vi.hoisted(() => ({ states: [] as any[], cursor: 0, effects: [] as any[], buttons: [] as any[], switches: [] as any[], error: vi.fn() }));
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
  return { Select: Container, Space: Container, Tag: Container, Tooltip: ({ title, children }: any) => <span title={title}>{children}</span>, Alert: ({ message }: any) => <div>{message}</div>, message: { error: harness.error }, theme: { useToken: () => ({ token: {} }) },
    Switch: (props: any) => { harness.switches.push(props); return <input type="checkbox" checked={props.checked} disabled={props.disabled} readOnly />; },
    Button: (props: any) => { harness.buttons.push(props); return <button disabled={props.disabled} aria-label={props["aria-label"]}>{props.icon}{props.children}</button>; },
  };
});
vi.mock("./CuaTaskCenter", () => ({ CuaTaskCenter: () => null }));
import { CuaControls, CuaSettingsRows, clampCuaControlPosition } from "./CuaControls";
const api = { getRuntime: vi.fn(), pause: vi.fn(), resume: vi.fn(), stop: vi.fn(), stopTask: vi.fn(), recover: vi.fn(), setMultiwindowEnabled: vi.fn() };
beforeEach(() => {
  vi.resetAllMocks(); harness.cursor = 0; harness.effects = []; harness.buttons = []; harness.switches = [];
  harness.states = [{ conversationId: "A", presentationConversationId: "A", phase: "running", taskId: "id", revision: 2, stepCount: 2, steps: [], needsObservation: true, shortcutAvailable: false }, false, null, false];
  api.getRuntime.mockResolvedValue(harness.states[0]); api.stop.mockResolvedValue({ success: true }); api.stopTask.mockResolvedValue({ success: true });
  vi.stubGlobal("window", Object.assign(new EventTarget(), { electronAPI: { on: vi.fn(), off: vi.fn() } }));
  vi.stubGlobal("navigator", { platform: "MacIntel" });
});
afterEach(() => vi.unstubAllGlobals());
const render = () => renderToStaticMarkup(<CuaControls api={api as any} t={(key) => key} />);
const Row = ({ label, desc, control }: any) => <section><h4>{label}</h4><p>{desc}</p>{control}</section>;
const renderRows = () => renderToStaticMarkup(<CuaSettingsRows api={api as any} t={(key) => key} Row={Row} />);
describe("Computer Use controls", () => {
  it("lets a fresh profile explicitly enable multiwindow through the host without changing its default", async () => {
    harness.states = [{ ...harness.states[0], phase: "idle", multiwindow: false }, false];
    api.setMultiwindowEnabled.mockResolvedValue({ success: true, runtime: { ...harness.states[0], multiwindow: true } });
    expect(renderRows()).toContain("Claw.Cua.multiwindow.enable");
    expect(harness.switches[0].checked).toBe(false);
    expect(api.setMultiwindowEnabled).not.toHaveBeenCalled();
    await harness.switches[0].onChange(true);
    expect(api.setMultiwindowEnabled).toHaveBeenCalledWith(true);
    expect(harness.states[0].multiwindow).toBe(true);
  });
  it("does not offer unsupported Linux multiwindow and disables mode changes while controls are pending", () => {
    vi.stubGlobal("navigator", { platform: "Linux x86_64" });
    expect(renderRows()).not.toContain("Claw.Cua.multiwindow.enable");
    harness.cursor = 0;
    vi.stubGlobal("navigator", { platform: "Win32" });
    harness.states[0].controlPending = true;
    renderRows();
    expect(harness.switches[0].disabled).toBe(true);
  });
  it("does not display another conversation's ordinary floating controls", () => {
    harness.states[0] = { ...harness.states[0], presentationConversationId: "B" };
    expect(render()).toBe("");
    harness.cursor = 0;
    harness.states[0] = { ...harness.states[0], presentationConversationId: "A" };
    expect(render()).toContain("Claw.Cua.pause");
  });
  it("leaves multiwindow floating controls to the host PiP instead of adding a second panel", () => {
    harness.states[0] = { ...harness.states[0], multiwindow: true, tasks: [] };
    expect(render()).toBe("");
  });
  it("keeps explicit recovery in settings after an emergency stop", async () => {
    harness.states = [{ ...harness.states[0], phase: "stopped", recoverable: true, tasks: [] }, false];
    api.recover.mockResolvedValue({ success: true });
    expect(renderRows()).toContain("Claw.Cua.recover");
    const recover = harness.buttons.find((button) => button.children === "Claw.Cua.recover");
    expect(recover.disabled).toBe(false); await recover.onClick();
    expect(api.recover).toHaveBeenCalledOnce();
  });
  it("hides scope, diagnostics and window pickers from ordinary settings", () => {
    harness.states = [{ ...harness.states[0], multiwindow: true, tasks: [] }, false, [], false, null];
    const html = renderRows();
    expect(html).not.toContain("Claw.Settings.computerUse.scope");
    expect(html).not.toContain("Claw.Cua.scope.refresh");
    expect(html).not.toContain("Claw.Cua.multiwindow.title");
    expect(html).not.toContain("Claw.Settings.computerUse.diagnostics");
  });
  it("keeps pause disabled during another pending operation without exposing stop", () => {
    harness.states[3] = true;
    expect(render()).not.toContain("Claw.Cua.shortcutUnavailable");
    expect(harness.buttons.find((b) => b["aria-label"] === "Claw.Cua.stop")).toBeUndefined();
    expect(harness.buttons.find((b) => b["aria-label"] === "Claw.Cua.pause").disabled).toBe(true);
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
  it("keeps action details and pause reasons in the tray center", () => {
    harness.states[0] = { ...harness.states[0], phase: "paused", reason: "noProgress",
      steps: [{ sequence: 1, tool: "browser_click", startedAt: 0, outcome: "refused" }] };
    const html = render();
    expect(html).not.toContain("Claw.Cua.reason.noProgress");
    expect(html).not.toContain("Claw.Cua.outcome.refused");
    expect(html).not.toContain("Claw.Cua.preview.collapse");
  });
  it("shows a compact actionable failure on the slim card", () => {
    harness.states[0] = { ...harness.states[0], phase: "paused", reason: "permissionsRequired" };
    expect(render()).toContain("Claw.Cua.reason.permissionsRequired");
    harness.cursor = 0; harness.buttons = [];
    harness.states[0] = { ...harness.states[0], reason: "uncertainResult" };
    expect(render()).toContain("Claw.Cua.reason.uncertainResult");
  });
  it("keeps the slim card up while emergency stop is still draining", () => {
    harness.states[0] = { ...harness.states[0], phase: "stopped", controlPending: true, reason: "userStopped" };
    const html = render();
    expect(html).toContain("Claw.Cua.stopping");
    expect(html).not.toContain('aria-label="Claw.Cua.stop"');
    expect(html).not.toContain("Claw.Cua.reason.userStopped");
    expect(harness.buttons.find((b) => b["aria-label"] === "Claw.Cua.stop")).toBeUndefined();
    expect(harness.buttons.find((b) => b["aria-label"] === "Claw.Cua.pause")).toBeUndefined();
  });
  it("shows the helper failure without reintroducing a stop button", () => {
    harness.states[0] = { ...harness.states[0], phase: "failed", reason: "helperStillRunning" };
    const html = render();
    expect(html).toContain("Claw.Cua.reason.helperStillRunning");
    expect(html).not.toContain('aria-label="Claw.Cua.stop"');
  });
  it("keeps the control bar hidden without a task", () => {
    harness.states[0] = { ...harness.states[0], phase: "idle", taskId: null };
    expect(render()).toBe("");
  });
  it("keeps takeover and pause and replaces feature disable with a stop for the displayed task", async () => {
    Object.assign(api, { takeOver: vi.fn(async () => ({ success: true })), setEnabled: vi.fn(async () => ({ success: true })) });
    const html = render();
    expect(html).toContain('data-phase="running"');
    const takeover = harness.buttons.find(b => b["aria-label"] === "Claw.Cua.preview.takeover");
    await takeover.onClick();
    expect((api as any).takeOver).toHaveBeenCalledOnce();
    await harness.buttons.find(b => b["aria-label"] === "Claw.Cua.pause").onClick();
    expect(api.pause).toHaveBeenCalledOnce();
    expect(api.stop).not.toHaveBeenCalled();
    const stop = harness.buttons.find(b => b["aria-label"] === "Claw.Cua.stopCurrent");
    expect(stop.children).toBeUndefined(); expect(stop.icon).toBeDefined();
    await stop.onClick();
    expect(api.stopTask).toHaveBeenCalledWith("id");
    expect((api as any).setEnabled).not.toHaveBeenCalled();
    expect(harness.buttons.find(b => b["aria-label"] === "Claw.Cua.stop")).toBeUndefined();
    expect(html).not.toContain("Claw.Settings.computerUse.enableOff");
    expect(harness.buttons.find(b => b["aria-label"] === "Claw.Cua.preview.close")).toBeUndefined();
  });
  it("shows resume while paused and keeps user context", async () => {
    harness.states[0] = { ...harness.states[0], phase: "paused", scope: { kind: "window", label: "My editor" } };
    const html = render(); expect(html).toContain("My editor");
    await harness.buttons.find(b => b["aria-label"] === "Claw.Cua.resume").onClick();
    expect(api.resume).toHaveBeenCalledOnce();
  });
  it("explains that desktop takeover pauses automation and leaves window switching to the user", () => {
    harness.states[0] = { ...harness.states[0], phase: "paused", reason: "userTakingControl" };
    const html = render();
    expect(harness.buttons.find(b => b["aria-label"] === "Claw.Cua.preview.takeover").title).toBe("Claw.Cua.preview.legacyTakeover");
    expect(html).not.toContain("Claw.Cua.reason.userTakingControl");
  });
  it("constrains a dragged card against its actual size and a smaller host", () => {
    expect(clampCuaControlPosition({ x: 900, y: 700 }, { width: 288, height: 180 }, { width: 600, height: 400 })).toEqual({ x: 304, y: 212 });
    expect(clampCuaControlPosition({ x: -400, y: -100 }, { width: 288, height: 180 }, { width: 320, height: 200 })).toEqual({ x: 8, y: 12 });
  });
  it("shows recovery only after a failed helper, never a scope picker", () => {
    harness.states = [{ ...harness.states[0], phase: "stopped", recoverable: true, taskId: null }, false];
    const html = renderRows();
    expect(html).toContain("Claw.Cua.recover");
    expect(html).not.toContain("Claw.Settings.computerUse.scope");
    expect(html).not.toContain("Claw.Cua.clear");
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
