import { app, ipcMain, WebContentsView } from "electron";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { createCuaPreviewController, type PreviewIdentity } from "./previewController";
import { taskPreviewWindowHtml } from "./taskPreviewWindow";
import type { CuaPreviewUpdate, CuaRuntime, CuaWindow } from "@shared/features/computer-use/contract";

type Action = "pause" | "resume" | "stop" | "dismiss" | "recover";
/** One contained preview surface. The ordinary control bar lives in the host renderer. */
export function createCuaControlWindow(options: {
  getMainWindow: () => BrowserWindow | null;
  getRuntime: () => CuaRuntime;
  subscribe: (listener: (state: CuaRuntime) => void) => () => void;
  action: (action: Action) => Promise<unknown>;
  authenticated: () => boolean;
  t: (key: string) => string;
  preloadPath?: string;
  readPreference?: () => unknown;
  writePreference?: (value: unknown) => void;
  previewIdentity?: (id: string) => PreviewIdentity | null;
  capturePreview?: (id: string) => Promise<CuaPreviewUpdate>;
  listWindows?: () => Promise<CuaWindow[]>;
  taskAction?: (id: string, action: "bind" | "pause" | "resume" | "stop" | "mode" | "takeover", value?: unknown) => Promise<unknown>;
}) {
  let view: WebContentsView | null = null, owner: BrowserWindow | null = null;
  let url = "", disposed = false, loaded = false, selected: string | null = null;
  const saved = options.readPreference?.() as { expanded?: boolean; bounds?: { width?: number; height?: number } } | null;
  let expanded = saved?.expanded === true;
  const preferredWidth = Number.isFinite(saved?.bounds?.width) ? Math.max(320, Math.min(520, saved!.bounds!.width!)) : 420;
  const preferredHeight = Number.isFinite(saved?.bounds?.height) ? Math.max(200, Math.min(480, saved!.bounds!.height!)) : 320;
  const presentation = () => ({ taskId: selected, expanded });
  const alive = () => !!view && !view.webContents.isDestroyed();
  const visible = () => alive() && loaded && !!owner && !owner.isDestroyed() && owner.isVisible() && !owner.isMinimized()
    && options.getRuntime().multiwindow === true && !!options.getRuntime().taskId;
  const send = (channel: string, value: unknown) => { if (alive()) view!.webContents.send(channel, value); };
  const preview = createCuaPreviewController({
    identity: id => options.authenticated() ? options.previewIdentity?.(id) ?? null : null,
    capture: id => options.capturePreview?.(id) ?? Promise.resolve({ taskId: id, status: "unavailable" }),
    publish: frame => { if (visible() && options.authenticated()) send("cua:control:preview", frame); },
  });
  const sync = () => {
    if (!alive() || !owner || owner.isDestroyed()) { preview.select(null); return; }
    const area = owner.getContentBounds();
    const width = Math.max(1, Math.min(preferredWidth, area.width - 32));
    const height = Math.max(1, Math.min(expanded ? preferredHeight : 42, area.height - 64));
    view!.setBounds({ x: Math.max(0, area.width - width - 16), y: Math.max(0, area.height - height - 16), width, height });
    const show = visible();
    view!.setVisible(show);
    preview.select(show && expanded && options.authenticated() ? selected : null);
    preview.sync();
  };
  const setPresentation = (id: string | null, open: boolean) => {
    if (id && options.getRuntime().tasks?.some(task => task.taskId === id)) selected = id;
    expanded = open;
    options.writePreference?.({ expanded, bounds: { width: preferredWidth, height: preferredHeight } });
    send("cua:control:presentation", presentation()); sync(); return presentation();
  };
  const trusted = (event: IpcMainInvokeEvent) => alive() && event.sender === view!.webContents
    && event.senderFrame === view!.webContents.mainFrame && event.senderFrame.url === url;
  ipcMain.handle("cua:control:getPresentation", event => trusted(event) ? presentation() : null);
  ipcMain.handle("cua:control:setPresentation", (event, id: unknown, open: unknown) => {
    if (!trusted(event) || !options.authenticated() || typeof open !== "boolean" || (id !== null && typeof id !== "string")) return null;
    return setPresentation(id as string | null, open);
  });
  ipcMain.handle("cua:control:getRuntime", event => trusted(event) ? options.getRuntime() : null);
  ipcMain.handle("cua:control:action", async (event, action: unknown) => {
    if (!trusted(event) || !["pause", "resume", "stop", "dismiss", "recover"].includes(String(action))) return { success: false };
    if (["resume", "recover"].includes(String(action)) && !options.authenticated()) return { success: false };
    try { return await options.action(action as Action); } catch { return { success: false }; }
  });
  ipcMain.handle("cua:control:listWindows", event => trusted(event) && options.authenticated() ? options.listWindows?.() ?? [] : []);
  ipcMain.handle("cua:control:taskAction", async (event, id: unknown, action: unknown, value: unknown) => {
    if (!trusted(event) || typeof id !== "string" || !["bind", "pause", "resume", "stop", "mode", "takeover"].includes(String(action))) return { success: false };
    if (!["pause", "stop"].includes(String(action)) && !options.authenticated()) return { success: false };
    try { return await options.taskAction?.(id, action as "bind" | "pause" | "resume" | "stop" | "mode" | "takeover", value) ?? { success: false }; }
    catch { return { success: false }; }
  });
  const trackOwner = (main: BrowserWindow, method: "on" | "removeListener") => {
    main[method]("show", sync); main[method]("hide", sync);
    main[method]("minimize", sync); main[method]("restore", sync);
    main[method]("resize", sync); main[method]("enter-full-screen", sync); main[method]("leave-full-screen", sync);
  };
  const destroySurface = () => {
    preview.select(null); loaded = false;
    if (owner) {
      trackOwner(owner, "removeListener");
      owner.removeListener("closed", destroySurface);
      if (!owner.isDestroyed() && view) owner.contentView.removeChildView(view);
    }
    const old = view; view = null; owner = null;
    if (old && !old.webContents.isDestroyed()) old.webContents.close();
  };
  const update = (state: CuaRuntime) => {
    if (disposed) return;
    // Single-window/desktop controls are already rendered inside App.tsx.
    if (!state.multiwindow || (!state.taskId && state.phase !== "failed")) { destroySurface(); return; }
    const current = state.tasks?.find(task => task.taskId === selected);
    const live = state.tasks?.find(task => ["running", "paused"].includes(task.phase));
    if (!current || (live && ["completed", "stopped", "failed"].includes(current.phase))) selected = live?.taskId ?? state.tasks?.[0]?.taskId ?? null;
    const main = options.getMainWindow();
    if (!main || main.isDestroyed()) { destroySurface(); return; }
    if (owner !== main || !alive()) {
      destroySurface(); owner = main;
      const created = new WebContentsView({ webPreferences: {
        preload: options.preloadPath ?? path.join(__dirname, "..", "preload", "cuaControls.js"),
        sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false,
      } });
      view = created; created.setVisible(false); created.setBackgroundColor("#00000000");
      main.contentView.addChildView(created);
      trackOwner(main, "on");
      main.once("closed", destroySurface);
      const wc = created.webContents;
      wc.setWindowOpenHandler(() => ({ action: "deny" }));
      wc.on("will-navigate", event => event.preventDefault());
      wc.on("will-attach-webview", event => event.preventDefault());
      wc.on("render-process-gone", destroySurface);
      url = "data:text/html;charset=utf-8," + encodeURIComponent(taskControlWindowHtml(options.t));
      void wc.loadURL(url).then(() => {
        if (disposed || view !== created || wc.isDestroyed()) return;
        loaded = true; send("cua:control:runtime", options.getRuntime());
        send("cua:control:presentation", presentation()); sync();
      }).catch(() => { if (view === created) destroySurface(); });
    } else {
      send("cua:control:runtime", state); send("cua:control:presentation", presentation()); sync();
    }
  };
  const onBeforeQuit = () => { disposed = true; destroySurface(); };
  const onWindowCreated = () => { setImmediate(() => { if (!disposed) update(options.getRuntime()); }); };
  app.on("before-quit", onBeforeQuit); app.on("browser-window-created", onWindowCreated);
  const unsubscribe = options.subscribe(update);
  update(options.getRuntime());
  const dispose = () => {
    disposed = true; preview.dispose(); unsubscribe(); destroySurface();
    app.removeListener("before-quit", onBeforeQuit); app.removeListener("browser-window-created", onWindowCreated);
    for (const channel of ["getPresentation", "setPresentation", "getRuntime", "action", "listWindows", "taskAction"]) ipcMain.removeHandler("cua:control:" + channel);
  };
  return Object.assign(dispose, { showTask(id?: string) {
    id ??= selected ?? options.getRuntime().tasks?.[0]?.taskId;
    if (!id || !options.authenticated() || !options.getRuntime().tasks?.some(task => task.taskId === id)) return { success: false, error: "taskUnavailable" };
    const main = options.getMainWindow();
    if (main && !main.isDestroyed()) {
      if (main.isMinimized()) main.restore();
      if (!main.isVisible()) main.show();
    }
    update(options.getRuntime()); setPresentation(id, true); return { success: true };
  } });
}

export function taskControlWindowHtml(t: (key: string) => string): string { return taskPreviewWindowHtml(t); }
