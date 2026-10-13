import { app, dialog, globalShortcut, ipcMain, powerMonitor } from "electron";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { writeFile } from "node:fs/promises";
import * as cua from "../services/cua/computerUse";
import { getTrayManager } from "../window/trayManager";
import { t } from "../services/i18n";
import { createCuaControlWindow } from "../services/cua/controlWindow";

export const CUA_STOP_SHORTCUT = "CommandOrControl+Shift+F12";

export function registerCuaRuntimeHandlers(options: {
  trusted: (event: IpcMainInvokeEvent) => boolean;
  authenticated: () => boolean;
  getWindow: () => BrowserWindow | null;
}) {
  const safeControl = (action: () => Promise<unknown>, needsLogin = false) => async (event: IpcMainInvokeEvent) => {
    if (!options.trusted(event)) return { success: false, error: "untrustedSender" };
    if (needsLogin && !options.authenticated()) return { success: false, error: "loginRequired", runtime: cua.getCuaRuntime() };
    try { return await action(); }
    catch { return { success: false, error: "operationFailed", runtime: cua.getCuaRuntime() }; }
  };
  ipcMain.handle("cua:getRuntime", (event) => options.trusted(event) ? cua.getCuaRuntime() : null);
  ipcMain.handle("cua:pause", safeControl(() => cua.pauseCuaTask()));
  ipcMain.handle("cua:resume", safeControl(() => cua.resumeCuaTask(), true));
  ipcMain.handle("cua:stop", safeControl(() => cua.stopCuaTask()));
  ipcMain.handle("cua:recover", safeControl(() => cua.recoverCua(), true));
  ipcMain.handle("cua:selfTest", safeControl(async () => ({ success: true, checks: await cua.selfTestCua() })));
  ipcMain.handle("cua:listWindows", safeControl(async () => ({ success: true, windows: await cua.listCuaWindows() }), true));
  ipcMain.handle("cua:setScope", async (event, scope: unknown) => {
    if (!options.trusted(event) || !options.authenticated()) return { success: false, error: "loginRequired" };
    try { return await cua.setCuaScope(scope); }
    catch { return { success: false, error: "scopeViolation", runtime: cua.getCuaRuntime() }; }
  });
  ipcMain.handle("cua:clearHistory", (event) => options.trusted(event) ? { success: cua.clearCuaHistory() } : { success: false });
  ipcMain.handle("cua:exportDiagnostics", safeControl(async () => {
    const parent = options.getWindow();
    if (!parent) return { success: false };
    const result = await dialog.showSaveDialog(parent, {
      title: t("Claw.Cua.export"), defaultPath: "nuwax-computer-use-diagnostics.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return { success: false, cancelled: true };
    await writeFile(result.filePath, JSON.stringify(await cua.getCuaDiagnostics(), null, 2), { mode: 0o600 });
    return { success: true };
  }));
  const stop = () => { void cua.stopCuaTask().catch(() => undefined); };
  const disposeControlWindow = createCuaControlWindow({ getRuntime: cua.getCuaRuntime, subscribe: cua.onCuaRuntime,
    authenticated: options.authenticated, t, action: async (action) => {
      if (action === "pause") return cua.pauseCuaTask();
      if (action === "resume") return cua.resumeCuaTask();
      if (action === "stop") return cua.stopCuaTask();
      return { success: cua.clearCuaHistory() };
    } });
  const unsubscribe = cua.onCuaRuntime((state) => {
    const window = options.getWindow();
    if (window && !window.isDestroyed()) window.webContents.send("cua:runtime", state);
    getTrayManager()?.setComputerUseStopAction(["running", "paused", "failed"].includes(state.phase) ? stop : null);
  });
  const registerShortcut = () => {
    try { cua.setCuaShortcutAvailable(globalShortcut.register(CUA_STOP_SHORTCUT, stop)); }
    catch { cua.setCuaShortcutAvailable(false); }
  };
  if (app.isReady()) registerShortcut();
  else void app.whenReady().then(registerShortcut);
  const suspend = () => {
    if (cua.getCuaRuntime().phase === "running") void cua.pauseCuaTask("screenLocked").catch(() => undefined);
  };
  powerMonitor.on("lock-screen", suspend);
  powerMonitor.on("suspend", suspend);
  app.once("will-quit", () => {
    disposeControlWindow();
    unsubscribe();
    globalShortcut.unregister(CUA_STOP_SHORTCUT);
    powerMonitor.removeListener("lock-screen", suspend);
    powerMonitor.removeListener("suspend", suspend);
  });
}
