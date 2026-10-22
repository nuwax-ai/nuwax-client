import { app, BrowserWindow, ipcMain, screen } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { createCuaPreviewController, type PreviewIdentity } from "./previewController";
import { taskPreviewWindowHtml } from "./taskPreviewWindow";
import type { CuaPreviewUpdate } from "@shared/features/computer-use/contract";
import { randomBytes } from "node:crypto";
import { CUA_REASON_KEYS, actionKind } from "@shared/features/computer-use/presentation";
import type { CuaRuntime, CuaWindow } from "@shared/features/computer-use/contract";

type Action = "pause" | "resume" | "stop" | "dismiss" | "recover";
export function createCuaControlWindow(options: {
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
  let window: BrowserWindow | null = null;
  let url = "";
  let disposed = false;
  let multiwindow = false;
  const saved = options.readPreference?.() as { expanded?: boolean; bounds?: Electron.Rectangle } | null;
  const savedBounds = saved?.bounds && [saved.bounds.x, saved.bounds.y, saved.bounds.width, saved.bounds.height].every(Number.isFinite)
    && saved.bounds.width >= 300 && saved.bounds.height >= 200 ? saved.bounds : undefined;
  let expanded = saved?.expanded !== false, selected: string | null = null;
  let expandedHeight = Math.max(200, savedBounds?.height ?? 320), resizing = false;
  const remember = () => {
    if (resizing) return;
    const bounds = window && !window.isDestroyed() ? window.getBounds() : savedBounds;
    if (expanded && bounds) expandedHeight = bounds.height;
    options.writePreference?.({ expanded, bounds: bounds ? { ...bounds, height: expandedHeight } : undefined });
  };
  const presentation = () => ({ taskId: selected, expanded });
  const preview = createCuaPreviewController({
    identity: id => options.authenticated() ? options.previewIdentity?.(id) ?? null : null,
    capture: id => options.capturePreview?.(id) ?? Promise.resolve({ taskId: id, status: "unavailable" }),
    publish: frame => { if (window && !window.isDestroyed() && window.isVisible() && options.authenticated()) window.webContents.send("cua:control:preview", frame); },
  });
  const syncPreview = () => { preview.sync(); preview.select(multiwindow && expanded && window?.isVisible() && !window.isMinimized() && options.authenticated() ? selected : null); };
  const setPresentation = (id: string | null, open: boolean) => {
    if (id && options.getRuntime().tasks?.some(task => task.taskId === id)) selected = id;
    expanded = open;
    if (window && !window.isDestroyed() && multiwindow) {
      resizing = true;
      window.setMinimumSize(300, expanded ? 200 : 42);
      window.setResizable(expanded);
      const bounds = window.getBounds();
      const area = screen.getDisplayMatching(bounds).workArea;
      const width = Math.min(Math.max(bounds.width, 320), area.width - 16);
      const height = expanded ? Math.min(expandedHeight, area.height - 16) : 42;
      window.setBounds({ x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
        y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)), width, height });
      resizing = false;
      window.webContents.send("cua:control:presentation", presentation());
    }
    remember(); syncPreview(); return presentation();
  };
  const trusted = (event: IpcMainInvokeEvent) => !!window && !window.isDestroyed() &&
    event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === url;
  ipcMain.handle("cua:control:getPresentation", event => trusted(event) ? presentation() : null);
  ipcMain.handle("cua:control:setPresentation", (event, id: unknown, open: unknown) => {
    if (!trusted(event) || !options.authenticated() || typeof open !== "boolean" || (id !== null && typeof id !== "string")) return null;
    return setPresentation(id as string | null, open);
  });
  ipcMain.handle("cua:control:getRuntime", (event) => trusted(event) ? options.getRuntime() : null);
  ipcMain.handle("cua:control:action", async (event, action: unknown) => {
    if (!trusted(event) || !["pause", "resume", "stop", "dismiss", "recover"].includes(action as string)) return { success: false };
    if (["resume", "recover"].includes(String(action)) && !options.authenticated()) return { success: false };
    try { return await options.action(action as Action); } catch { return { success: false }; }
  });
  ipcMain.handle("cua:control:listWindows", (event) => trusted(event) && options.authenticated() ? options.listWindows?.() ?? [] : []);
  ipcMain.handle("cua:control:taskAction", async (event, id: unknown, action: unknown, value: unknown) => {
    if (!trusted(event) || typeof id !== "string" || !["bind", "pause", "resume", "stop", "mode", "takeover"].includes(String(action))) return { success: false };
    if (!["pause", "stop"].includes(String(action)) && !options.authenticated()) return { success: false };
    try { return await options.taskAction?.(id, action as "bind" | "pause" | "resume" | "stop" | "mode" | "takeover", value) ?? { success: false }; }
    catch { return { success: false }; }
  });
  const update = (state: CuaRuntime) => {
    if (disposed) return;
    if (state.multiwindow && !state.tasks?.some(task => task.taskId === selected)) selected = state.tasks?.[0]?.taskId ?? null;
    preview.sync();
    if (!state.taskId && state.phase !== "failed") { preview.select(null); window?.hide(); return; }
    if (window && multiwindow !== !!state.multiwindow) { window.destroy(); window = null; }
    multiwindow = !!state.multiwindow;
    if (!window || window.isDestroyed()) {
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      const width = Math.min(multiwindow ? 420 : 620, area.width - 24), height = Math.min(multiwindow ? (expanded ? 320 : 42) : 220, area.height - 24);
      window = new BrowserWindow({ width, height, x: Math.round(area.x + area.width - width - 20),
        y: Math.max(area.y, area.y + area.height - height - 24), show: false, frame: false, resizable: multiwindow && expanded,
        alwaysOnTop: true, skipTaskbar: true, hasShadow: !multiwindow, backgroundColor: multiwindow ? "#00000000" : "#202124", transparent: multiwindow,
        webPreferences: { preload: options.preloadPath ?? path.join(__dirname, "..", "preload", "cuaControls.js"),
          sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false } });
      if (multiwindow && savedBounds) {
        const b = savedBounds;
        const display = screen.getDisplayMatching(b).workArea;
        const width = Math.min(Math.max(300, b.width), display.width), height = expanded ? Math.min(Math.max(200, b.height), display.height) : 42;
        window.setBounds({ x: Math.max(display.x, Math.min(b.x, display.x + display.width - width)), y: Math.max(display.y, Math.min(b.y, display.y + display.height - height)), width, height });
      }
      const owned = window;
      owned.setAlwaysOnTop(true, "floating");
      owned.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      owned.setContentProtection(true);
      owned.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      owned.webContents.on("will-navigate", (event) => event.preventDefault());
      owned.webContents.on("will-attach-webview", (event) => event.preventDefault());
      owned.on("close", (event) => {
        if (disposed) return;
        event.preventDefault();
        if (multiwindow) { setPresentation(selected, false); return; }
        if (["running", "paused"].includes(options.getRuntime().phase)) void options.action("stop").catch(() => undefined);
        else owned.hide();
      });
      owned.on("move", remember); owned.on("resize", remember);
      owned.on("hide", () => preview.select(null)); owned.on("minimize", () => preview.select(null));
      owned.on("show", syncPreview); owned.on("restore", syncPreview);
      owned.webContents.on("render-process-gone", () => { preview.select(null); if (!owned.isDestroyed()) owned.destroy(); });
      owned.webContents.on("did-finish-load", () => {
        if (!owned.isDestroyed()) {
          owned.webContents.send("cua:control:runtime", options.getRuntime());
          owned.webContents.send("cua:control:presentation", presentation());
          syncPreview();
        }
      });
      url = "data:text/html;charset=utf-8," + encodeURIComponent(multiwindow ? taskControlWindowHtml(options.t) : controlWindowHtml(options.t));
      void owned.loadURL(url).then(() => {
        if (!disposed && !owned.isDestroyed() && (options.getRuntime().taskId || options.getRuntime().phase === "failed")) owned.showInactive();
      }).catch(() => { if (!owned.isDestroyed()) owned.destroy(); });
    } else {
      window.webContents.send("cua:control:runtime", state);
      if (!window.isMinimized()) window.showInactive(); syncPreview();
    }
  };
  const onBeforeQuit = () => {
    disposed = true;
    if (window && !window.isDestroyed()) {
      window.destroy();
    }
    window = null;
  };
  app?.on?.("before-quit", onBeforeQuit);
  const unsubscribe = options.subscribe(update);
  update(options.getRuntime());
  const dispose = () => {
    preview.dispose();
    disposed = true; app?.removeListener?.("before-quit", onBeforeQuit); unsubscribe();
    if (window && !window.isDestroyed()) window.destroy();
    window = null;
    ipcMain.removeHandler("cua:control:getPresentation"); ipcMain.removeHandler("cua:control:setPresentation");
    ipcMain.removeHandler("cua:control:getRuntime"); ipcMain.removeHandler("cua:control:action");
    ipcMain.removeHandler("cua:control:listWindows"); ipcMain.removeHandler("cua:control:taskAction");
  };
  return Object.assign(dispose, { showTask(id?: string) {
    id ??= selected ?? options.getRuntime().tasks?.[0]?.taskId;
    if (!id || !options.authenticated() || !options.getRuntime().tasks?.some(task => task.taskId === id)) return { success: false, error: "taskUnavailable" };
    update(options.getRuntime()); setPresentation(id, true); window?.showInactive(); syncPreview(); return { success: true };
  } });
}

export function taskControlWindowHtml(t: (key: string) => string): string {
  return taskPreviewWindowHtml(t);
}

export function controlWindowHtml(t: (key: string) => string): string {
  const keys = ["title", "pause", "resume", "stop", "dismiss", "stopping", "scope.desktop", "scope.window", "scope.choose",
    "phase.idle", "phase.running", "phase.paused", "phase.stopped", "phase.failed", "phase.completed", "reason.generic", "latestAction",
    ...CUA_REASON_KEYS.map((key) => `reason.${key}`),
    ...["observe", "browser", "clipboard", "session", "application", "input", "other"].map((key) => `action.${key}`),
    ...["running", "ok", "refused", "error", "cancelled"].map((key) => `outcome.${key}`)];
  const labels = JSON.stringify(Object.fromEntries(keys.map((key) => [key, t(`Claw.Cua.${key}`)]))).replace(/</g, "\\u003c");
  const nonce = randomBytes(16).toString("hex");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>
  :root{color-scheme:light dark}*{box-sizing:border-box}body{min-height:100vh;margin:0;background:#202124;color:#f5f5f5;font:14px system-ui;padding:16px;border:1px solid #666;border-radius:12px}header{-webkit-app-region:drag;display:flex;justify-content:space-between;cursor:move}p{margin:12px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}button{-webkit-app-region:no-drag;font:inherit;padding:7px 14px;margin-right:8px;border:1px solid #888;border-radius:7px;background:#353638;color:inherit;cursor:pointer}button:disabled{opacity:.45;cursor:default}#stop{background:#a4262c;border-color:#ff7979}#error{color:#ffa6a6;font-size:12px}button[hidden]{display:none}
  </style></head><body><header><strong id="title"></strong><span id="phase" role="status"></span></header><p id="scope"></p><p id="step"></p><div><button id="pause"></button><button id="resume"></button><button id="stop"></button><button id="dismiss"></button></div><p id="error" role="alert"></p><script nonce="${nonce}">
  const labels=${labels};let revision=-1;const actionKind=${actionKind.toString()};const api=window.cuaControls;
  for(const key of ['title','pause','resume','stop','dismiss'])document.getElementById(key).textContent=labels[key];
  function draw(s){if(!s||s.revision<revision)return;revision=s.revision;document.getElementById('phase').textContent=labels[s.controlPending?'stopping':'phase.'+s.phase];document.getElementById('scope').textContent=s.scope?.kind==='window'?labels['scope.window']+': '+(s.scope.label||labels['scope.choose']):labels['scope.desktop'];
  const last=s.steps?.at(-1);document.getElementById('step').textContent=last?labels.latestAction+': '+labels['action.'+actionKind(last.tool)]+' · '+labels['outcome.'+last.outcome]:'';document.getElementById('error').textContent=s.reason?(labels['reason.'+s.reason]||labels['reason.generic']):'';
  document.getElementById('pause').hidden=s.phase!=='running';document.getElementById('resume').hidden=s.phase!=='paused';document.getElementById('resume').disabled=!!s.controlPending;document.getElementById('pause').disabled=!!s.controlPending;document.getElementById('stop').hidden=!['running','paused','failed'].includes(s.phase);document.getElementById('dismiss').hidden=!['completed','stopped'].includes(s.phase);}
  for(const action of ['pause','resume','stop','dismiss'])document.getElementById(action).onclick=async()=>{try{const r=await api.action(action);document.getElementById('error').textContent=r?.success===false?labels['reason.generic']:'';draw(await api.getRuntime())}catch{document.getElementById('error').textContent=labels['reason.generic']}};
  api.onRuntime(draw);api.getRuntime().then(draw);
  </script></body></html>`;
}
