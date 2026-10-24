import { app, ipcMain, WebContentsView } from "electron";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { createCuaPreviewController, type PreviewIdentity } from "./previewController";
import { taskPreviewWindowHtml } from "./taskPreviewWindow";
import type { CuaPreviewUpdate, CuaRuntime } from "@shared/features/computer-use/contract";
import { CUA_CONTROL_INITIAL_POSITION, canPreviewCuaTask } from "@shared/features/computer-use/presentation";

/** One contained preview surface. The ordinary control bar lives in the host renderer. */
export function createCuaControlWindow(options: {
  getMainWindow: () => BrowserWindow | null;
  getRuntime: () => CuaRuntime;
  subscribe: (listener: (state: CuaRuntime) => void) => () => void;
  authenticated: () => boolean;
  t: (key: string) => string;
  preloadPath?: string;
  readPreference?: () => unknown;
  writePreference?: (value: unknown) => void;
  previewIdentity?: (id: string) => PreviewIdentity | null;
  capturePreview?: (id: string) => Promise<CuaPreviewUpdate>;
  taskAction?: (id: string, action: "pause" | "resume" | "stop" | "takeover" | "confirm") => Promise<unknown>;
}) {
  let view: WebContentsView | null = null, owner: BrowserWindow | null = null;
  let dismissed = false;
  let order: string[] = [];
  let url = "", disposed = false, loaded = false, hiddenByOwner = false, selected: string | null = null;
  const saved = options.readPreference?.() as { position?: { x: number; y: number } } | null;
  const preferredWidth = 240, preferredHeight = 152;
  let position = saved?.position && [saved.position.x, saved.position.y].every(Number.isFinite) ? saved.position : null;
  const liveTasks = () => (options.getRuntime().tasks ?? []).filter(canPreviewCuaTask);
  const runtime = () => {
    const state = options.getRuntime();
    const tasks = liveTasks();
    return { ...state, tasks: tasks.sort((a, b) => order.indexOf(a.taskId) - order.indexOf(b.taskId)) };
  };
  const presentation = () => ({ taskId: selected, position: view?.getBounds() ?? position });
  const save = () => options.writePreference?.({ position });
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const savePosition = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; if (!disposed) save(); }, 200);
    saveTimer.unref();
  };
  const alive = () => !!view && !view.webContents.isDestroyed();
  const visible = () => alive() && loaded && !hiddenByOwner && !!owner && !owner.isDestroyed() && owner.isVisible() && !owner.isMinimized()
    && !dismissed && options.getRuntime().multiwindow === true && liveTasks().length > 0;
  const send = (channel: string, value: unknown) => { if (alive()) view!.webContents.send(channel, value); };
  const preview = createCuaPreviewController({
    identity: id => options.authenticated() ? options.previewIdentity?.(id) ?? null : null,
    capture: id => options.capturePreview?.(id) ?? Promise.resolve({ taskId: id, status: "unavailable" }),
    publish: frame => { if (visible() && options.authenticated()) send("cua:control:preview", frame); },
    alternateTargets: id => liveTasks().map(task => task.taskId).filter(other => other !== id),
  });
  const sync = () => {
    if (!alive() || !owner || owner.isDestroyed()) { preview.select(null); return; }
    const area = owner.getContentBounds();
    const stackSpace = Math.min(3, Math.max(0, liveTasks().length - 1)) * 8;
    const width = Math.max(1, Math.min(preferredWidth + stackSpace, area.width - 32));
    const height = Math.max(1, Math.min(preferredHeight + stackSpace, area.height - 64));
    const maxX = Math.max(0, area.width - width - 16), maxY = Math.max(0, area.height - height - 16);
    const initialX = area.width - width - CUA_CONTROL_INITIAL_POSITION.right;
    view!.setBounds({ x: Math.max(0, Math.min(position?.x ?? initialX, maxX)),
      y: Math.max(Math.min(40, maxY), Math.min(position?.y ?? CUA_CONTROL_INITIAL_POSITION.top, maxY)), width, height });
    send("cua:control:presentation", presentation());
    const show = visible();
    view!.setVisible(show);
    preview.select(show && options.authenticated() ? selected : null);
    preview.sync();
  };
  const setPresentation = (id: string | null) => {
    if (id && liveTasks().some(task => task.taskId === id)) selected = id;
    save();
    sync(); return presentation();
  };
  const trusted = (event: IpcMainInvokeEvent) => alive() && event.sender === view!.webContents
    && event.senderFrame === view!.webContents.mainFrame && event.senderFrame.url === url;
  ipcMain.handle("cua:control:getPresentation", event => trusted(event) ? presentation() : null);
  ipcMain.handle("cua:control:setPresentation", (event, id: unknown) => {
    if (!trusted(event) || !options.authenticated() || (id !== null && typeof id !== "string")) return null;
    return setPresentation(id as string | null);
  });
  ipcMain.handle("cua:control:getRuntime", event => trusted(event) ? runtime() : null);
  ipcMain.handle("cua:control:close", event => {
    if (!trusted(event)) return false;
    dismissed = true; sync(); return true;
  });
  ipcMain.handle("cua:control:move", (event, value: unknown) => {
    const point = value as { x?: unknown; y?: unknown } | null;
    if (!trusted(event) || !point || typeof point.x !== "number" || typeof point.y !== "number" ||
        !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    const area = owner!.getContentBounds(), bounds = view!.getBounds();
    position = { x: Math.max(0, Math.min(Math.round(point.x), Math.max(0, area.width - bounds.width - 16))),
      y: Math.max(Math.min(40, Math.max(0, area.height - bounds.height - 16)), Math.min(Math.round(point.y), Math.max(0, area.height - bounds.height - 16))) };
    savePosition(); sync(); return presentation();
  });
  ipcMain.handle("cua:control:reorder", (event, ids: unknown) => {
    if (!trusted(event) || !Array.isArray(ids) || ids.length > 32 || ids.some(id => typeof id !== "string")) return null;
    const live = liveTasks().map(task => task.taskId);
    if (ids.length !== live.length || new Set(ids).size !== live.length || ids.some(id => !live.includes(id))) return null;
    order = [...ids]; send("cua:control:runtime", runtime()); return order;
  });
  ipcMain.handle("cua:control:taskAction", async (event, id: unknown, action: unknown) => {
    if (!trusted(event) || typeof id !== "string" || !["pause", "resume", "stop", "takeover", "confirm"].includes(String(action))) return { success: false };
    if (!["pause", "stop"].includes(String(action)) && !options.authenticated()) return { success: false };
    try { return await options.taskAction?.(id, action as "pause" | "resume" | "stop" | "takeover" | "confirm") ?? { success: false }; }
    catch { return { success: false }; }
  });
  // Native close-to-tray events can precede the isVisible/isMinimized change.
  const onOwnerHide = () => { hiddenByOwner = true; sync(); };
  const onOwnerShow = () => {
    hiddenByOwner = false; sync();
    setImmediate(() => { if (!disposed) sync(); });
  };
  const trackOwner = (main: BrowserWindow, method: "on" | "removeListener") => {
    main[method]("show", onOwnerShow); main[method]("hide", onOwnerHide);
    main[method]("minimize", onOwnerHide); main[method]("restore", onOwnerShow);
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
    const live = liveTasks();
    if (!state.multiwindow || !live.length) { dismissed = false; destroySurface(); return; }
    order = [...order.filter(id => live.some(task => task.taskId === id)), ...live.map(task => task.taskId).filter(id => !order.includes(id))];
    if (!live.some(task => task.taskId === selected)) selected = order[0] ?? null;
    const main = options.getMainWindow();
    if (!main || main.isDestroyed()) { destroySurface(); return; }
    if (owner !== main || !alive()) {
      destroySurface(); owner = main; hiddenByOwner = !main.isVisible() || main.isMinimized();
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
        loaded = true; send("cua:control:runtime", runtime());
        sync();
      }).catch(() => { if (view === created) destroySurface(); });
    } else {
      send("cua:control:runtime", runtime()); sync();
    }
  };
  const onBeforeQuit = () => { disposed = true; destroySurface(); };
  const onWindowCreated = () => { setImmediate(() => { if (!disposed) update(options.getRuntime()); }); };
  app.on("before-quit", onBeforeQuit); app.on("browser-window-created", onWindowCreated);
  const unsubscribe = options.subscribe(update);
  update(options.getRuntime());
  const dispose = () => {
    if (saveTimer) clearTimeout(saveTimer);
    disposed = true; preview.dispose(); unsubscribe(); destroySurface();
    app.removeListener("before-quit", onBeforeQuit); app.removeListener("browser-window-created", onWindowCreated);
    for (const channel of ["getPresentation", "setPresentation", "getRuntime", "taskAction", "move", "close", "reorder"]) ipcMain.removeHandler("cua:control:" + channel);
  };
  return Object.assign(dispose, { showTask(id?: string) {
    id ??= selected ?? liveTasks()[0]?.taskId;
    if (!id || !options.authenticated() || !liveTasks().some(task => task.taskId === id)) return { success: false, error: "taskUnavailable" };
    const main = options.getMainWindow();
    if (main && !main.isDestroyed()) {
      if (main.isMinimized()) main.restore();
      if (!main.isVisible()) main.show();
    }
    dismissed = false; update(options.getRuntime()); setPresentation(id); return { success: true };
  } });
}

export function taskControlWindowHtml(t: (key: string) => string): string { return taskPreviewWindowHtml(t); }
