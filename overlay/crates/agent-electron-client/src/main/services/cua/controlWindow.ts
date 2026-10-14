import { BrowserWindow, ipcMain, screen } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { CUA_REASON_KEYS, actionKind } from "@shared/cuaPresentation";
import type { CuaRuntime } from "@shared/types/cuaRuntime";

type Action = "pause" | "resume" | "stop" | "dismiss";
export function createCuaControlWindow(options: {
  getRuntime: () => CuaRuntime;
  subscribe: (listener: (state: CuaRuntime) => void) => () => void;
  action: (action: Action) => Promise<unknown>;
  authenticated: () => boolean;
  t: (key: string) => string;
  preloadPath?: string;
}) {
  let window: BrowserWindow | null = null;
  let url = "";
  let disposed = false;
  const trusted = (event: IpcMainInvokeEvent) => !!window && !window.isDestroyed() &&
    event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === url;
  ipcMain.handle("cua:control:getRuntime", (event) => trusted(event) ? options.getRuntime() : null);
  ipcMain.handle("cua:control:action", async (event, action: unknown) => {
    if (!trusted(event) || !["pause", "resume", "stop", "dismiss"].includes(action as string)) return { success: false };
    if (action === "resume" && !options.authenticated()) return { success: false };
    try { return await options.action(action as Action); } catch { return { success: false }; }
  });
  const update = (state: CuaRuntime) => {
    if (disposed) return;
    if (!state.taskId && state.phase !== "failed") { window?.hide(); return; }
    if (!window || window.isDestroyed()) {
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      const width = Math.min(620, area.width - 24), height = Math.min(220, area.height - 24);
      window = new BrowserWindow({ width, height, x: Math.round(area.x + (area.width - width) / 2),
        y: Math.max(area.y, area.y + area.height - height - 24), show: false, frame: false, resizable: false,
        alwaysOnTop: true, skipTaskbar: true, backgroundColor: "#202124",
        webPreferences: { preload: options.preloadPath ?? path.join(__dirname, "..", "preload", "cuaControls.js"),
          sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false } });
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
        if (["running", "paused"].includes(options.getRuntime().phase)) void options.action("stop").catch(() => undefined);
        else owned.hide();
      });
      owned.webContents.on("did-finish-load", () => {
        if (!owned.isDestroyed()) owned.webContents.send("cua:control:runtime", options.getRuntime());
      });
      url = "data:text/html;charset=utf-8," + encodeURIComponent(controlWindowHtml(options.t));
      void owned.loadURL(url).then(() => {
        if (!disposed && !owned.isDestroyed() && (options.getRuntime().taskId || options.getRuntime().phase === "failed")) owned.showInactive();
      }).catch(() => { if (!owned.isDestroyed()) owned.destroy(); });
    } else {
      window.webContents.send("cua:control:runtime", state);
      window.showInactive();
    }
  };
  const unsubscribe = options.subscribe(update);
  update(options.getRuntime());
  return () => {
    disposed = true; unsubscribe(); window?.destroy(); window = null;
    ipcMain.removeHandler("cua:control:getRuntime"); ipcMain.removeHandler("cua:control:action");
  };
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
