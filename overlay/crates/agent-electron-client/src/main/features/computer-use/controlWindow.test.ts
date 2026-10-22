import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import type { CuaRuntime } from "@shared/features/computer-use/contract";
const mocks = vi.hoisted(() => ({
  views: [] as any[], handlers: new Map<string, (...args: any[]) => any>(),
  select: vi.fn(), disposePreview: vi.fn(), deferred: false, loads: [] as (() => void)[],
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
      setBackgroundColor() {}
    },
  };
});
vi.mock("./previewController", () => ({ createCuaPreviewController: () => ({ select: mocks.select, sync() {}, dispose: mocks.disposePreview }) }));
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
function setup(multiwindow = true) {
  let main = new MainWindow();
  let runtime = { taskId: "task", revision: 1, phase: "paused", multiwindow, tasks: [{ taskId: "task", phase: "paused" }] } as CuaRuntime;
  let listener: (s: CuaRuntime) => void = () => {};
  const action = vi.fn();
  const dispose = createCuaControlWindow({
    getMainWindow: () => main as unknown as BrowserWindow, getRuntime: () => runtime,
    subscribe: fn => { listener = fn; return vi.fn(); }, authenticated: () => true, t: key => key, action,
  });
  return { dispose, action, get main() { return main; }, replaceMain(next: MainWindow) { main = next; },
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
  it("keeps compact/expanded views within the client, including after resize", async () => {
    const s = setup(); await flush(); const v = mocks.views[0];
    expect(s.main.children).toEqual([v]); expect(v.visible).toBe(true); expect(v.bounds.height).toBe(42);
    s.dispose.showTask("task"); expect(v.bounds.height).toBe(320);
    s.main.width = 300; s.main.height = 180; s.main.emit("resize");
    expect(v.bounds.x).toBeGreaterThanOrEqual(0); expect(v.bounds.y).toBeGreaterThanOrEqual(0);
    expect(v.bounds.x + v.bounds.width).toBeLessThanOrEqual(300); expect(v.bounds.y + v.bounds.height).toBeLessThanOrEqual(180);
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
});
