import { app, BrowserWindow, ipcMain, screen } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import path from "node:path";
import log from "electron-log";
import { randomBytes } from "node:crypto";
import type { PermissionKey } from "@shared/types/permissionOnboarding";

export interface DragChipIdentity {
  key: PermissionKey;
  appName: string;
  appPath: string;
}

type ChipLabelKey = "dragChipTitle" | "dragChipHint" | "dragChipManual";
export type DragChipLabels = Record<ChipLabelKey, string>;

const WIDTH = 300;
const HEIGHT = 112;

/**
 * Floating palette that stays above System Settings so the user can drag the
 * subject .app bundle straight into the TCC list. Same data-URL + dedicated
 * preload + trusted-sender pattern as the CUA control window.
 */
export function permissionDragChipHtml(labels: DragChipLabels): string {
  const safe = JSON.stringify(labels).replace(/</g, "\\u003c");
  const nonce = randomBytes(16).toString("hex");
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<style>
:root{color-scheme:light dark;--text:#303237;--muted:#777c84;--glass:#ffffffec;--line:#00000012;--accent:#438c76}
*{box-sizing:border-box}body{margin:0;height:100vh;display:flex;align-items:center;gap:12px;padding:14px;background:transparent;color:var(--text);font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;user-select:none}
#card{flex:1;display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--line);border-radius:14px;background:var(--glass);box-shadow:0 10px 30px #00000026;backdrop-filter:blur(24px)}
#chip{display:flex;align-items:center;gap:9px;padding:8px 12px;border:1.5px dashed var(--muted);border-radius:11px;cursor:grab;background:#ffffff50}
#chip:active{cursor:grabbing;border-color:var(--accent)}
#chip:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
#icon{width:30px;height:30px;flex:none;pointer-events:none}
#name{font-weight:650;font-size:12px;max-width:92px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#text{min-width:0}
#title{font-weight:600;font-size:12px;margin:0 0 3px}
#hint{margin:0;font-size:11px;line-height:1.55;color:var(--muted)}
#close{width:26px;height:26px;flex:none;align-self:flex-start;border:0;border-radius:8px;background:transparent;color:var(--muted);font-size:14px;cursor:pointer}
#close:hover{background:#00000010;color:var(--text)}
#close:focus-visible{outline:2px solid var(--accent)}
@media(prefers-color-scheme:dark){:root{--text:#eeeef0;--muted:#a4a6af;--glass:#292a30ed;--line:#ffffff16}#chip{background:#ffffff0d}}
</style></head><body>
<div id="card">
  <div id="chip" draggable="true" tabindex="0" role="button" aria-label="__TITLE__">
    <img id="icon" alt="" src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect x='4' y='3' width='16' height='18' rx='3' fill='%23777c84'/%3E%3C/svg%3E">
    <span id="name"></span>
  </div>
  <div id="text"><p id="title"></p><p id="hint"></p></div>
  <button id="close" aria-label="close">&#10005;</button>
</div>
<script nonce="${nonce}">
const labels=${safe};const api=window.permissionChip;
document.getElementById("title").textContent=labels.dragChipTitle;
document.getElementById("hint").textContent=labels.dragChipHint;
document.getElementById("chip").setAttribute("aria-label",labels.dragChipTitle);
document.getElementById("close").onclick=()=>void api.close();
document.getElementById("close").onkeydown=e=>{if(e.key==="Enter"||e.key===" ")e.preventDefault()};
document.getElementById("chip").ondragstart=e=>{e.preventDefault();void api.drag().then(ok=>{if(!ok)document.getElementById("hint").textContent=labels.dragChipManual})};
document.getElementById("chip").onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();void api.drag().then(ok=>{if(!ok)document.getElementById("hint").textContent=labels.dragChipManual})}};
api.onIdentity(value=>{if(!value)return;
  const name=document.getElementById("name");name.textContent=value.appName;name.title=value.appName;
  document.getElementById("hint").textContent=labels.dragChipHint.replace("{0}",value.appName);
  document.getElementById("chip").setAttribute("aria-label",labels.dragChipTitle+" "+value.appName);
  if(value.icon)document.getElementById("icon").src=value.icon;});
</script></body></html>`.replace(
    "__TITLE__",
    labels.dragChipTitle
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;"),
  );
}

const iconCache = new Map<string, Electron.NativeImage>();
async function appIcon(appPath: string): Promise<Electron.NativeImage | null> {
  const cached = iconCache.get(appPath);
  if (cached && !cached.isEmpty()) return cached;
  try {
    const icon = await app.getFileIcon(appPath, { size: "normal" });
    if (icon && !icon.isEmpty()) {
      iconCache.set(appPath, icon);
      return icon;
    }
  } catch (error) {
    log.warn("[Permissions] drag chip icon unavailable", error);
  }
  return null;
}

export function createPermissionDragChip(options: {
  t: (key: string) => string;
  getWindow: () => BrowserWindow | null;
}) {
  let window: BrowserWindow | null = null;
  let url = "";
  let disposed = false;
  let identity: DragChipIdentity | null = null;
  let requested = false;
  let loaded = false;
  let owner: BrowserWindow | null = null;
  let hiddenByOwner = false;
  const ownerListeners: Array<[string, () => void]> = [];

  const unbindOwner = () => {
    for (const [event, listener] of ownerListeners) (owner as NodeJS.EventEmitter | null)?.removeListener(event, listener);
    ownerListeners.length = 0;
    owner = null;
  };
  const syncVisibility = () => {
    if (!window || window.isDestroyed()) return;
    if (!disposed && requested && loaded && owner && !owner.isDestroyed() &&
        !hiddenByOwner && owner.isVisible() && !owner.isMinimized()) window.showInactive();
    else window.hide();
  };
  const bindOwner = (next: BrowserWindow) => {
    if (owner === next) return;
    unbindOwner();
    owner = next;
    hiddenByOwner = !next.isVisible() || next.isMinimized();
    const bind = (event: string, listener: () => void) => {
      (next as NodeJS.EventEmitter).on(event, listener);
      ownerListeners.push([event, listener]);
    };
    for (const event of ["hide", "minimize", "close"]) bind(event, () => {
      // Electron can deliver hide before isVisible() changes.
      hiddenByOwner = true;
      syncVisibility();
    });
    for (const event of ["show", "restore"]) bind(event, () => {
      hiddenByOwner = false;
      syncVisibility();
      queueMicrotask(syncVisibility);
    });
    bind("closed", () => {
      requested = false;
      window?.destroy();
      window = null;
      unbindOwner();
    });
  };

  const labels = (): DragChipLabels => {
    const read = (key: ChipLabelKey) =>
      options.t(`Claw.PermissionGuide.${key}`);
    return {
      dragChipTitle: read("dragChipTitle"),
      dragChipHint: read("dragChipHint"),
      dragChipManual: read("dragChipManual"),
    };
  };
  const trusted = (event: IpcMainInvokeEvent) =>
    !!window &&
    !window.isDestroyed() &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    event.senderFrame.url === url;

  ipcMain.handle("permissions:onboarding:dragChip:start", async (event) => {
    if (!trusted(event) || !identity) return false;
    const current = identity;
    const icon = await appIcon(current.appPath);
    if (!icon || identity !== current || !trusted(event) || disposed || !requested || hiddenByOwner) return false;
    // The renderer cancelled its HTML5 drag; the native session starts here.
    event.sender.startDrag({ file: current.appPath, icon });
    return true;
  });
  ipcMain.handle("permissions:onboarding:dragChip:close", (event) => {
    if (!trusted(event)) return false;
    hide();
    return true;
  });

  const publish = () => {
    if (!window || window.isDestroyed() || !identity) return;
    // Snapshot so a key switch mid-flight can't pair a stale icon with a new name.
    const current = identity;
    void appIcon(current.appPath).then((icon) => {
      if (!disposed && identity === current && window && !window.isDestroyed())
        window.webContents.send("permissionChip:identity", {
          appName: current.appName,
          icon: icon ? icon.toDataURL() : null,
        });
    });
  };

  function show(next: DragChipIdentity): boolean {
    if (disposed) return false;
    const nextOwner = options.getWindow();
    if (!nextOwner || nextOwner.isDestroyed()) return false;
    bindOwner(nextOwner);
    identity = next;
    requested = true;
    if (!window || window.isDestroyed()) {
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      // Non-activating so System Settings keeps focus while the chip floats above it.
      window = new BrowserWindow({
        parent: nextOwner,
        width: WIDTH,
        height: HEIGHT,
        x: Math.round(area.x + area.width - WIDTH - 20),
        y: Math.round(area.y + area.height - HEIGHT - 24),
        show: false,
        frame: false,
        resizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        focusable: false,
        hasShadow: false,
        transparent: true,
        backgroundColor: "#00000000",
        webPreferences: {
          preload: path.join(__dirname, "..", "preload", "permissionChip.js"),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          devTools: false,
        },
      });
      const owned = window;
      loaded = false;
      owned.setAlwaysOnTop(true, "floating");
      owned.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      owned.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      owned.webContents.on("will-navigate", (event) => event.preventDefault());
      owned.webContents.on("will-attach-webview", (event) => event.preventDefault());
      owned.webContents.on("render-process-gone", () => {
        if (!owned.isDestroyed()) owned.destroy();
        if (window === owned) window = null;
      });
      owned.webContents.on("did-finish-load", publish);
      url = "data:text/html;charset=utf-8," + encodeURIComponent(permissionDragChipHtml(labels()));
      void owned.loadURL(url).then(() => {
        if (!disposed && window === owned && !owned.isDestroyed()) {
          loaded = true;
          syncVisibility();
        }
      }).catch(() => {
        if (!owned.isDestroyed()) owned.destroy();
        if (window === owned) window = null;
      });
    } else {
      publish();
      syncVisibility();
    }
    return true;
  }
  function hide() {
    requested = false;
    if (window && !window.isDestroyed()) window.hide();
  }
  function dispose() {
    disposed = true;
    identity = null;
    requested = false;
    unbindOwner();
    window?.destroy();
    window = null;
    ipcMain.removeHandler("permissions:onboarding:dragChip:start");
    ipcMain.removeHandler("permissions:onboarding:dragChip:close");
    app.removeListener("before-quit", dispose);
  }
  app.on("before-quit", dispose);
  return Object.assign(dispose, { show, hide });
}
