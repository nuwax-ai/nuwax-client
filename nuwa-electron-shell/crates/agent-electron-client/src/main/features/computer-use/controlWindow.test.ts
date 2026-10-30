import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import type { CuaRuntime } from "@shared/features/computer-use/contract";
const mocks = vi.hoisted(() => ({
  views: [] as any[], handlers: new Map<string, (...args: any[]) => any>(),
  select: vi.fn(), disposePreview: vi.fn(), deferred: false, loads: [] as (() => void)[],
  previewOptions: null as any,
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    app: new EventEmitter(),
    ipcMain: { handle: (key: string, fn: (...args: any[]) => any) => mocks.handlers.set(key, fn), removeHandler: (key: string) => mocks.handlers.delete(key) },
    WebContentsView: class {
      visible = false; bounds: any; webContents: any;
      constructor() {
        const wc = Object.assign(new EventEmitter(), {
          destroyed: false, mainFrame: { url: "" }, send: vi.fn(), setWindowOpenHandler: vi.fn(),
          isDestroyed() { return this.destroyed; }, close() { this.destroyed = true; },
          loadURL(url: string) { this.mainFrame.url = url; return mocks.deferred ? new Promise<void>(resolve => mocks.loads.push(resolve)) : Promise.resolve(); },
        });
        this.webContents = wc; mocks.views.push(this);
      }
      setVisible(value: boolean) { this.visible = value; }
      setBounds(value: any) { this.bounds = value; }
      getBounds() { return this.bounds; }
      setBackgroundColor() {}
    },
  };
});
vi.mock("./previewController", () => ({ createCuaPreviewController: (options: any) => {
  mocks.previewOptions = options;
  return { select: mocks.select, sync() {}, dispose: mocks.disposePreview };
} }));
import { app } from "electron";
import { createCuaControlWindow } from "./controlWindow";
class MainWindow extends EventEmitter {
  visible = true; minimized = false; destroyed = false; width = 960; height = 640;
  children: any[] = [];
  contentView = { addChildView: (view: any) => this.children.push(view), removeChildView: (view: any) => { this.children = this.children.filter(v => v !== view); } };
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isMinimized() { return this.minimized; }
  show() { this.visible = true; this.emit("show"); }
  restore() { this.minimized = false; this.emit("restore"); }
  getContentBounds() { return { x: 100, y: 200, width: this.width, height: this.height }; }
}
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
function setup(multiwindow = true, preference?: unknown) {
  let main = new MainWindow();
  let runtime = { presentationConversationId: "A", taskId: "task", revision: 1, phase: "paused", multiwindow, tasks: [{ taskId: "task", bindingId: "binding", epoch: 1, phase: "paused", scope: { kind: "window", pid: 1, windowId: 2 }, conversationId: "A" }] } as CuaRuntime;
  let listener: (s: CuaRuntime) => void = () => {};
  const action = vi.fn(), writePreference = vi.fn();
  const dispose = createCuaControlWindow({
    getMainWindow: () => main as unknown as BrowserWindow, getRuntime: () => runtime,
    subscribe: fn => { listener = fn; return vi.fn(); }, authenticated: () => true, t: key => key, taskAction: action,
    readPreference: () => preference, writePreference,
  });
  return { dispose, action, writePreference, get main() { return main; }, replaceMain(next: MainWindow) { main = next; },
    setConversation(id: string | null) { runtime = { ...runtime, presentationConversationId: id, revision: runtime.revision + 1 }; listener(runtime); },
    setRuntime(value: CuaRuntime) { runtime = { presentationConversationId: runtime.presentationConversationId, ...value, tasks: value.tasks?.map(task => ({ conversationId: "A", ...task })) }; listener(runtime); },
    update() { runtime = { ...runtime, revision: runtime.revision + 1 }; listener(runtime); } };
}
beforeEach(() => {
  app.removeAllListeners(); mocks.views.length = 0; mocks.loads.length = 0; mocks.handlers.clear(); mocks.deferred = false;
  mocks.select.mockReset(); mocks.disposePreview.mockReset();
});
describe("Computer Use control surface follows the main client window", () => {
  it("uses the existing renderer controls for ordinary mode and creates no extra surface", async () => {
    const s = setup(false); await flush(); expect(mocks.views).toHaveLength(0); s.dispose();
  });
  it("keeps small previews within the client, including after resize", async () => {
    const s = setup(); await flush(); const v = mocks.views[0];
    expect(s.main.children).toEqual([v]); expect(v.visible).toBe(true); expect(v.bounds).toEqual({ x: 696, y: 72, width: 240, height: 152 });
    s.dispose.showTask("task"); expect(v.bounds.height).toBe(152);
    s.main.width = 300; s.main.height = 180; s.main.emit("resize");
    expect(v.bounds.x).toBeGreaterThanOrEqual(0); expect(v.bounds.y).toBeGreaterThanOrEqual(0);
    expect(v.bounds.x + v.bounds.width).toBeLessThanOrEqual(300); expect(v.bounds.y + v.bounds.height).toBeLessThanOrEqual(180);
    expect(v.webContents.send).toHaveBeenCalledWith("cua:control:presentation", expect.objectContaining({ taskId: "task", position: v.bounds }));
    s.dispose();
  });
  it("hides preview work with the main window and shows it again without stopping the task", async () => {
    const s = setup(); await flush(); s.dispose.showTask("task"); const v = mocks.views[0];
    s.main.visible = false; s.main.emit("hide"); expect(v.visible).toBe(false); expect(mocks.select).toHaveBeenLastCalledWith(null);
    s.main.visible = true; s.main.emit("show"); expect(v.visible).toBe(true); expect(mocks.select).toHaveBeenLastCalledWith("task");
    s.main.minimized = true; s.main.emit("minimize"); expect(v.visible).toBe(false);
    s.dispose.showTask("task"); expect(s.main.minimized).toBe(false); expect(v.visible).toBe(true);
    s.main.visible = false; s.main.emit("hide"); s.dispose.showTask("task");
    expect(s.main.visible).toBe(true); expect(v.visible).toBe(true); expect(s.action).not.toHaveBeenCalled(); s.dispose();
  });
  it("fits portrait frames, remembers their shape through pause and ignores stale binding frames", async () => {
    const s = setup(); await flush(); const v = mocks.views[0];
    const publish = (bindingId: string, width = 320, height = 570) => mocks.previewOptions.publish({ taskId: "task", status: "ready", frame: { bindingId, epoch: 1, width, height } });
    publish("binding"); expect(v.bounds.height).toBe(240); expect(v.bounds.width).toBe(144);
    s.update(); expect(v.bounds.height).toBe(240);
    const before = { ...v.bounds }; publish("old-binding", 1600, 900); expect(v.bounds).toEqual(before);
    s.setRuntime({ revision: 3, multiwindow: true, tasks: [{ taskId: "task", bindingId: "binding", epoch: 2, phase: "paused", scope: { kind: "window", pid: 1, windowId: 2 } }] } as CuaRuntime);
    expect(v.bounds).toEqual(before);
    expect(s.action).not.toHaveBeenCalled(); s.dispose();
  });
  it("resizes only from the private frame, clamps geometry and persists the display preference", async () => {
    const s = setup(true, { extent: 300 }); await flush(); const v = mocks.views[0];
    const event = { sender: v.webContents, senderFrame: v.webContents.mainFrame };
    const resize = mocks.handlers.get("cua:control:resize")!;
    expect(v.bounds.width).toBe(320);
    for (const size of [{ width: NaN, height: 10 }, { width: -1, height: 10 }, { width: 1, height: Infinity }, null]) expect(resize(event, size)).toBeNull();
    expect(resize({ ...event, senderFrame: {} }, { width: 400, height: 240 })).toBeNull();
    vi.useFakeTimers();
    try {
      resize(event, { width: 400, height: 240 }); expect(v.bounds.width).toBe(420); expect(v.bounds.height).toBe(260);
      vi.advanceTimersByTime(200); expect(s.writePreference).toHaveBeenLastCalledWith(expect.objectContaining({ extent: 400 }));
      resize(event, { width: 1, height: 1 }); expect(v.bounds.width).toBe(180);
      resize(event, { width: 1e9, height: 1e9 });
      expect(v.bounds.x + v.bounds.width).toBeLessThanOrEqual(s.main.width);
      expect(v.bounds.y + v.bounds.height).toBeLessThanOrEqual(s.main.height);
      expect(s.action).not.toHaveBeenCalled();
    } finally { s.dispose(); vi.useRealTimers(); }
  });
  it("stops preview work when hide/minimize arrives before native visibility changes", async () => {
    const s = setup(); await flush(); s.dispose.showTask("task"); const v = mocks.views[0];
    s.main.emit("hide");
    expect(v.visible).toBe(false); expect(mocks.select).toHaveBeenLastCalledWith(null);
    s.update(); expect(v.visible).toBe(false);
    s.main.emit("show"); expect(v.visible).toBe(true);
    s.main.emit("minimize"); expect(v.visible).toBe(false);
    s.update(); expect(v.visible).toBe(false);
    s.main.emit("restore"); expect(v.visible).toBe(true); s.dispose();
  });
  it("closes owned contents with the main window and ignores late loads before reopening", async () => {
    mocks.deferred = true; const s = setup(); const old = mocks.views[0];
    s.main.destroyed = true; s.main.emit("closed"); expect(old.webContents.isDestroyed()).toBe(true);
    mocks.loads.shift()!(); await flush(); expect(old.visible).toBe(false);
    const next = new MainWindow(); s.replaceMain(next); app.emit("browser-window-created", {}, next); await flush();
    expect(mocks.views).toHaveLength(2); expect(next.children).toEqual([mocks.views[1]]);
    mocks.loads.shift()!(); await flush(); expect(mocks.views[1].visible).toBe(true); s.dispose();
  });
  it("rejects other frames and cannot recreate controls after app exit", async () => {
    const s = setup(); await flush(); const v = mocks.views[0];
    const get = mocks.handlers.get("cua:control:getRuntime")!;
    expect(get({ sender: v.webContents, senderFrame: { url: v.webContents.mainFrame.url } })).toBeNull();
    expect(get({ sender: v.webContents, senderFrame: v.webContents.mainFrame }).taskId).toBe("task");
    app.emit("before-quit"); s.update(); app.emit("browser-window-created", {}, new MainWindow()); await flush();
    expect(mocks.views).toHaveLength(1); expect(v.webContents.isDestroyed()).toBe(true);
    s.dispose(); expect(mocks.handlers.size).toBe(0); expect(s.main.listenerCount("show")).toBe(0);
  });
  it("starts small at the top-right, clamps dragging and remembers position without controlling tasks", async () => {
    const s = setup(); await flush(); s.dispose.showTask("task"); const v = mocks.views[0];
    expect(v.bounds).toEqual({ x: 696, y: 72, width: 240, height: 152 });
    const event = { sender: v.webContents, senderFrame: v.webContents.mainFrame };
    const move = mocks.handlers.get("cua:control:move")!;
    expect(move(event, { x: Infinity, y: 0 })).toBeNull();
    expect(move({ ...event, senderFrame: {} }, { x: 2, y: 2 })).toBeNull();
    move(event, { x: -200, y: 10000 }); expect(v.bounds.x).toBe(0); expect(v.bounds.y).toBe(472);
    s.update(); expect(v.bounds.x).toBe(0); expect(v.bounds.y).toBe(472);
    expect(s.action).not.toHaveBeenCalled(); s.dispose();
  });
  it("closing hides capture until explicitly reopened while runtime updates keep the task alive", async () => {
    const s = setup(); await flush(); const v = mocks.views[0]; const event = { sender: v.webContents, senderFrame: v.webContents.mainFrame };
    expect(mocks.handlers.get("cua:control:close")!(event)).toBe(true);
    expect(v.visible).toBe(false); expect(mocks.select).toHaveBeenLastCalledWith(null);
    s.update(); expect(v.visible).toBe(false); expect(s.action).not.toHaveBeenCalled();
    s.dispose.showTask("task"); expect(v.visible).toBe(true); s.dispose();
  });
  it("only exposes live tasks and accepts a complete permutation without changing execution", async () => {
    const s = setup(); await flush(); const v = mocks.views[0];
    s.setRuntime({ taskId: "a", revision: 5, phase: "running", multiwindow: true,
      tasks: [{ taskId: "a", phase: "running", scope: { kind: "window", pid: 1, windowId: 2 } }, { taskId: "b", phase: "paused", scope: { kind: "window", pid: 3, windowId: 4 } }, { taskId: "unbound", phase: "paused" }, { taskId: "ended", phase: "completed" }] } as CuaRuntime);
    const event = { sender: v.webContents, senderFrame: v.webContents.mainFrame };
    const get = mocks.handlers.get("cua:control:getRuntime")!, reorder = mocks.handlers.get("cua:control:reorder")!;
    expect(get(event).tasks.map((t: any) => t.taskId)).toEqual(["a", "b"]);
    expect(v.bounds.width).toBe(248); expect(v.bounds.height).toBe(160);
    expect(s.dispose.showTask("unbound").success).toBe(false);
    expect(reorder(event, ["b", "b"])).toBeNull(); expect(reorder(event, ["ended", "a"])).toBeNull();
    expect(reorder(event, ["b", "a"])).toEqual(["b", "a"]);
    expect(get(event).tasks.map((t: any) => t.taskId)).toEqual(["b", "a"]);
    expect(s.dispose.showTask("ended").success).toBe(false); expect(s.action).not.toHaveBeenCalled();
    s.setRuntime({ taskId: "ended", revision: 6, phase: "completed", multiwindow: true, tasks: [{ taskId: "ended", phase: "completed" }] } as CuaRuntime);
    expect(v.webContents.isDestroyed()).toBe(true); s.dispose();
  });

  it("keeps a draining emergency-stop task on the preview surface", async () => {
    const s = setup(); await flush(); const v = mocks.views[0];
    s.setRuntime({ taskId: "task", revision: 2, phase: "stopped", multiwindow: true, controlPending: true,
      tasks: [{ taskId: "task", phase: "stopped", controlPending: true, scope: { kind: "window", pid: 1, windowId: 2 } }] } as CuaRuntime);
    expect(v.visible).toBe(true); expect(v.webContents.isDestroyed()).toBe(false);
    s.setRuntime({ taskId: "task", revision: 3, phase: "stopped", multiwindow: true,
      tasks: [{ taskId: "task", phase: "stopped", scope: { kind: "window", pid: 1, windowId: 2 } }] } as CuaRuntime);
    expect(v.webContents.isDestroyed()).toBe(true); s.dispose();
  });
  it("limits private controls to pause, resume, stop and exact takeover", async () => {
    const s = setup(); await flush(); const wc = mocks.views[0].webContents;
    const event = { sender: wc, senderFrame: wc.mainFrame };
    const act = mocks.handlers.get("cua:control:taskAction")!;
    await act(event, "task", "bind"); await act({ ...event, senderFrame: {} }, "task", "stop");
    expect(s.action).not.toHaveBeenCalled();
    await act(event, "task", "takeover"); expect(s.action).toHaveBeenCalledWith("task", "takeover");
    expect(mocks.handlers.has("cua:control:listWindows")).toBe(false); s.dispose();
  });


  it("shows only the current conversation's stack and switching never controls execution", async () => {
    const s = setup(); await flush(); let v = mocks.views.at(-1);
    const task = (taskId: string, conversationId: string) => ({ taskId, conversationId, phase: "running", scope: { kind: "window", pid: 1, windowId: 2 } });
    s.setRuntime({ revision: 3, multiwindow: true, tasks: [task("a1", "A"), task("a2", "A"), task("b1", "B"), task("unknown", "")] } as CuaRuntime);
    const get = mocks.handlers.get("cua:control:getRuntime")!;
    const event = () => ({ sender: v.webContents, senderFrame: v.webContents.mainFrame });
    expect(get(event()).tasks.map((task: any) => task.taskId)).toEqual(["a1", "a2"]);
    expect(v.bounds.width).toBe(248);
    expect(mocks.handlers.get("cua:control:reorder")!(event(), ["a2", "a1"])).toEqual(["a2", "a1"]);
    mocks.handlers.get("cua:control:setPresentation")!(event(), "a2");
    s.setConversation("unused"); expect(v.webContents.isDestroyed()).toBe(true);
    expect(mocks.select).toHaveBeenLastCalledWith(null);
    expect(get(event())).toBeNull();
    expect(s.dispose.showTask("a1").success).toBe(false);
    s.setConversation("B"); await flush(); v = mocks.views.at(-1); expect(v.visible).toBe(true);
    expect(get(event()).tasks.map((task: any) => task.taskId)).toEqual(["b1"]);
    expect(v.bounds.width).toBe(240);
    s.setConversation("A"); await flush(); v = mocks.views.at(-1); expect(v.visible).toBe(true);
    expect(get(event()).tasks.map((task: any) => task.taskId)).toEqual(["a2", "a1"]);
    expect(mocks.handlers.get("cua:control:getPresentation")!(event()).taskId).toBe("a2");
    expect(s.action).not.toHaveBeenCalled(); s.dispose();
  });
  it("remembers dismissal and selection per conversation and rejects late cross-conversation controls", async () => {
    const s = setup(); await flush(); let v = mocks.views.at(-1);
    s.setRuntime({ revision: 3, multiwindow: true, tasks: [
      { taskId: "a", conversationId: "A", phase: "running", scope: { kind: "window", pid: 1, windowId: 2 } },
      { taskId: "b", conversationId: "B", phase: "running", scope: { kind: "window", pid: 3, windowId: 4 } },
    ] } as CuaRuntime);
    const event = () => ({ sender: v.webContents, senderFrame: v.webContents.mainFrame });
    const stale = event();
    mocks.handlers.get("cua:control:close")!(event());
    s.setConversation("B"); await flush(); v = mocks.views.at(-1); expect(v.visible).toBe(true);
    expect(mocks.handlers.get("cua:control:close")!(stale)).toBe(false);
    expect(mocks.handlers.get("cua:control:setPresentation")!(event(), "a")).toBeNull();
    expect(mocks.handlers.get("cua:control:reorder")!(event(), ["a", "b"])).toBeNull();
    expect((await mocks.handlers.get("cua:control:taskAction")!(event(), "a", "stop")).success).toBe(false);
    s.setConversation("A"); await flush(); v = mocks.views.at(-1); s.update(); expect(v.visible).toBe(false);
    s.dispose.showTask("a"); expect(v.visible).toBe(true);
    s.setConversation(null); expect(v.webContents.isDestroyed()).toBe(true);
    expect(s.action).not.toHaveBeenCalled(); s.dispose();
  });

});
