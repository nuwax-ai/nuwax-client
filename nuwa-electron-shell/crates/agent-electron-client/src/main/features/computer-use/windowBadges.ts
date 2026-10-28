import { BrowserWindow, screen } from "electron";

export interface CuaWindowFrame {
  taskId: string; color: string; visible: boolean; phase: string; controlPending?: boolean; reason?: string | null;
  bounds: { x: number; y: number; width: number; height: number };
}

/** Nonfocusable, host-owned task controls. Native occlusion checks keep them off unrelated windows. */
export function createCuaWindowBadges(subscribe: (listener: (frames: CuaWindowFrame[]) => void) => () => void, showTask?: (id: string) => unknown, t: (key: string) => string = key => key) {
  const windows = new Map<string, BrowserWindow>();
  const colors = new Map<string, string>();
  const off = subscribe((frames) => {
    const keep = new Set(frames.map((frame) => frame.taskId));
    for (const [id, window] of windows) if (!keep.has(id)) {
      if (!window.isDestroyed()) window.destroy(); windows.delete(id); colors.delete(id);
    }
    for (const frame of frames) {
      let window = windows.get(frame.taskId);
      if (!frame.visible) { if (window && !window.isDestroyed()) window.hide(); continue; }
      const rect = process.platform === "win32" ? screen.screenToDipRect(null, frame.bounds) : frame.bounds;
      if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width < 240 || rect.height < 48) {
        if (window && !window.isDestroyed()) window.hide(); continue;
      }
      if (!window || window.isDestroyed()) {
        window = new BrowserWindow({ width: 152, height: 24, show: false, frame: false, transparent: true,
          focusable: false, skipTaskbar: true, resizable: false, alwaysOnTop: true,
          title: "Nuwax Computer Use Badge",
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false } });
        window.setIgnoreMouseEvents(false);
        window.setContentProtection(true);
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        window.webContents.on("will-navigate", (event, url) => {
          event.preventDefault();
          if (url === "nuwax-cua:open" && windows.get(frame.taskId)?.isVisible()) showTask?.(frame.taskId);
        });
        windows.set(frame.taskId, window); colors.delete(frame.taskId);
      }
      const color = /^#[0-9a-f]{6}$/i.test(frame.color) ? frame.color : "#4f8cff";
      const label = t("Claw.Cua.preview." + (frame.controlPending ? "handoff" : frame.reason === "foregroundRequired" ? "waiting" : frame.phase === "running" ? "running" : "paused"));
      const key = color + label;
      if (colors.get(frame.taskId) !== key) {
        colors.set(frame.taskId, key);
        void window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(
          '<!doctype html><title>Nuwax Computer Use Badge</title><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;;style-src &#39;unsafe-inline&#39;"><style>body{margin:0;background:transparent}.badge{border-radius:12px;background:' +
          color + ';color:white;width:150px;height:22px;display:flex;align-items:center;justify-content:center;font:11px system-ui;text-decoration:none;box-shadow:0 2px 6px #0003;border:1px solid #ffffff45;white-space:nowrap;overflow:hidden}</style><a class="badge" href="nuwax-cua:open">Nuwax · ' + label.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!)) + '</a>')).catch(() => undefined);
      }
      window.setBounds({ x: Math.round(rect.x + Math.max(4, (rect.width - 152) / 2)), y: Math.round(rect.y + 4), width: 152, height: 24 });
      window.setOpacity(frame.phase === "running" ? 1 : 0.6);
      window.showInactive();
    }
  });
  return () => { off(); for (const window of windows.values()) if (!window.isDestroyed()) window.destroy(); windows.clear(); colors.clear(); };
}
