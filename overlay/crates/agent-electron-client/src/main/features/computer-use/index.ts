/**
 * Computer Use 特性清单：独立 Nuwax Computer Use 程序的宿主接入。
 *
 * register() 内聚原 `ipc/cuaRuntimeHandlers` 的全部接线：受信控制通道、状态推送、
 * 托盘急停（经 activities 端口）、全局急停快捷键、锁屏/休眠暂停、控制浮窗，以及
 * 生命周期（会话撤销、服务启停、退出）与 Agent 会话参与者。
 */
import { app, dialog, globalShortcut, powerMonitor } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { writeFile } from "node:fs/promises";
import type { DesktopFeature, FeatureContext, FeatureHandle } from "../_kit/types";
import * as cua from "./computerUse";
import { readCuaPreferences } from "./preferences";
import { startScreenshotRetention } from "./cuaPrivacy";
import { configureComputerUseHost } from "./ports";
import { createCuaControlWindow } from "./controlWindow";
import { createCuaTaskHistory } from "./taskHistory";
import { CuaEngineSessions, cuaSessionAuthority } from "./sessionAuthority";
import type { CuaScope } from "@shared/features/computer-use/contract";
import { canPreviewCuaTask, isCuaLivePhase } from "@shared/features/computer-use/presentation";

export const CUA_STOP_SHORTCUT = "CommandOrControl+Shift+F12";

export const computerUseFeature: DesktopFeature = {
  id: "computer-use",
  products: ["nuwax"],
  enabledByDefault: true,
  agentServers: ["cua"],
  register(ctx: FeatureContext): FeatureHandle {
    configureComputerUseHost({
      dataHome: ctx.dataDir,
      readSetting: (key) => ctx.settings.read(key),
      writeSetting: (key, value) => ctx.settings.write(key, value),
      setLocalMcpServer: (id, entry) => ctx.agent.setLocalMcpServer(id, entry),
      hasLocalMcpServer: (id) => ctx.agent.hasLocalMcpServer(id),
      resolveNodeBinary: () => ctx.agent.resolveNodeBinary(),
    });

    readCuaPreferences();
    const stopScreenshotRetention = startScreenshotRetention(ctx.dataDir);

    const offPermissionSubject = ctx.permissions?.registerExternalSubject?.({
      enabled: async () => { const status = await cua.getCuaStatus(); return status.enabled || status.consentPending === true; },
      check: async () => {
        const status = await cua.getCuaStatus();
        const probe = (value: boolean | null) => value === true ? "granted" as const : value === false ? "denied" as const : "unknown" as const;
        return { accessibility: probe(status.accessibility), screen_recording: probe(status.screenRecording) };
      },
      request: async (key) => {
        const result = await cua.requestCuaPermissions();
        return (key === "accessibility" ? result.accessibility : result.screenRecording) === true;
      },
      appPath: cua.getCuaHelperAppPath,
    });

    const history = createCuaTaskHistory(() => ctx.settings.read("computerUseTaskHistory"),
      rows => { ctx.settings.write("computerUseTaskHistory", rows); });
    ctx.hostIpc.handle("cua:getTaskHistory", () => history.list(), []);
    ctx.hostIpc.handle("cua:clearTaskHistory", () => { history.clear(); return { success: true }; }, { success: false });
    const openCenter = () => {
      const main = ctx.windows.getMain();
      if (!main || main.isDestroyed()) return;
      if (main.isMinimized()) main.restore();
      main.show(); main.focus(); main.webContents.send("cua:openCenter");
    };
    const safeControl = (action: () => Promise<unknown>, needsLogin = false) => async () => {
      if (needsLogin && !ctx.session.isAuthenticated()) {
        return { success: false, error: "loginRequired", runtime: cua.getCuaRuntime() };
      }
      try { return await action(); }
      catch { return { success: false, error: "operationFailed", runtime: cua.getCuaRuntime() }; }
    };
    ctx.hostIpc.handle("cua:getRuntime", () => cua.getCuaRuntime(), null);
    ctx.hostIpc.handle("cua:getTasks", () => cua.getCuaTasks(), []);
    const taskControl = (action: (id: string, value?: unknown) => Promise<unknown>, needsLogin: boolean) =>
      async (_event: IpcMainInvokeEvent, id: unknown, value?: unknown) => {
        if (typeof id !== "string") return { success: false, error: "taskUnavailable" };
        if (needsLogin && !ctx.session.isAuthenticated()) return { success: false, error: "loginRequired" };
        try { return await action(id, value); }
        catch { return { success: false, error: "operationFailed", runtime: cua.getCuaRuntime() }; }
      };
    for (const [name, action, needsLogin] of [
      ["bindTarget", cua.bindWindowTask, true], ["pauseTask", (id: string) => cua.pauseWindowTask(id), false],
      ["resumeTask", cua.resumeWindowTask, true], ["takeOverTask", cua.takeOverWindowTask, true], ["stopTask", cua.stopWindowTask, false], ["setTaskMode", cua.setWindowTaskMode, true],
    ] as const) ctx.hostIpc.handle("cua:" + name, taskControl(action as (id: string, value?: unknown) => Promise<unknown>, needsLogin), { success: false });
    ctx.hostIpc.handle("cua:stopAll", safeControl(() => cua.stopCuaTask()), { success: false });
    ctx.hostIpc.handle("cua:setMultiwindowEnabled", async (_event: IpcMainInvokeEvent, enabled: unknown) => {
      if (!ctx.session.isAuthenticated() || typeof enabled !== "boolean") return { success: false, error: "loginRequired" };
      return cua.setMultiwindowEnabled(enabled);
    }, { success: false, error: "untrustedSender" });
    ctx.hostIpc.handle("cua:takeOver", safeControl(() => cua.takeOverCua(), true), { success: false, error: "untrustedSender" });
    ctx.hostIpc.handle("cua:pause", safeControl(() => cua.pauseCuaTask()), { success: false, error: "untrustedSender" });
    ctx.hostIpc.handle("cua:resume", safeControl(() => cua.resumeCuaTask(), true), { success: false, error: "untrustedSender" });
    ctx.hostIpc.handle("cua:stop", safeControl(() => cua.stopCuaTask()), { success: false, error: "untrustedSender" });
    ctx.hostIpc.handle("cua:recover", safeControl(() => cua.recoverCua(), true), { success: false, error: "untrustedSender" });
    ctx.hostIpc.handle("cua:selfTest", safeControl(async () => ({ success: true, checks: await cua.selfTestCua() })), { success: false, error: "untrustedSender" });
    ctx.hostIpc.handle("cua:listWindows", safeControl(async () => ({ success: true, windows: await cua.listCuaWindows() }), true), { success: false, error: "untrustedSender" });
    ctx.hostIpc.handle("cua:setScope", async (event: IpcMainInvokeEvent, scope: unknown) => {
      if (!ctx.session.isAuthenticated()) return { success: false, error: "loginRequired" };
      try { return await cua.setCuaScope(scope as CuaScope); }
      catch { return { success: false, error: "scopeViolation", runtime: cua.getCuaRuntime() }; }
    }, { success: false, error: "loginRequired" });
    ctx.hostIpc.handle("cua:clearHistory", () => ({ success: cua.clearCuaHistory() }), { success: false });
    ctx.hostIpc.handle("cua:exportDiagnostics", safeControl(async () => {
      const parent = ctx.windows.getMain();
      if (!parent) return { success: false };
      const result = await dialog.showSaveDialog(parent, {
        title: ctx.translate?.("Claw.Cua.export") ?? "Claw.Cua.export",
        defaultPath: "nuwax-computer-use-diagnostics.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (result.canceled || !result.filePath) return { success: false, cancelled: true };
      await writeFile(result.filePath, JSON.stringify(await cua.getCuaDiagnostics(), null, 2), { mode: 0o600 });
      return { success: true };
    }), { success: false, error: "untrustedSender" });
    ctx.hostIpc.handle("cua:getStatus", () => cua.getCuaStatus(), null);
    ctx.hostIpc.handle("cua:setEnabled", async (event: IpcMainInvokeEvent, enabled: boolean) => {
      if (enabled === true && !ctx.session.isAuthenticated()) return { success: false, error: "untrusted sender" };
      return cua.setCuaEnabled(enabled === true);
    }, { success: false, error: "untrusted sender" });
    ctx.hostIpc.handle("cua:setAgentCursor", async (event: IpcMainInvokeEvent, enabled: boolean) =>
      cua.setCuaAgentCursorEnabled(enabled === true), { success: false, error: "untrusted sender" });
    ctx.hostIpc.handle("cua:setAuthMode", (event: IpcMainInvokeEvent, mode: unknown) => cua.setCuaAuthMode(mode), { success: false, error: "untrusted sender" });
    ctx.hostIpc.handle("cua:setBlacklist", (event: IpcMainInvokeEvent, list: unknown) => cua.setCuaBlacklist(list), { success: false, error: "untrusted sender" });
    ctx.hostIpc.handle("cua:listInstalledApps", () => cua.listCuaInstalledApps(), []);
    ctx.hostIpc.handle("cua:listScreenshots", () => cua.listCuaScreenshotFiles(), []);
    ctx.hostIpc.handle("cua:confirmSensitive", (event: IpcMainInvokeEvent, allow: unknown, taskId?: string) => {
      return { success: ctx.session.isAuthenticated() && allow === true && cua.allowCuaSensitiveOnce(taskId) };
    }, { success: false });
    ctx.hostIpc.handle("cua:requestPermissions", () => cua.requestCuaPermissions(), null);
    ctx.hostIpc.handle("cua:installHelper", () => cua.installCuaHelper(), { success: false, error: "untrusted sender" });
    ctx.hostIpc.handle("cua:getVlmConfig", () => cua.getVlmConfig(), null);
    ctx.hostIpc.handle("cua:setVlmConfig", (event: IpcMainInvokeEvent, patch: unknown) => cua.setVlmConfig(
      (patch ?? {}) as { baseUrl?: string; model?: string; apiKey?: string; clearApiKey?: boolean },
    ), { success: false, error: "untrusted sender" });
    ctx.hostIpc.handle("cua:testVlm", () => cua.testVlm(), { success: false, error: "untrusted sender" });

    // 操作提示仅属于主窗口；独立最小 preload 和精确 sender 校验保持不变。
    const disposeControlWindow = createCuaControlWindow({
      getMainWindow: () => ctx.windows.getMain(),
      getRuntime: cua.getCuaRuntime, subscribe: cua.onCuaRuntime,
      authenticated: () => ctx.session.isAuthenticated(), t: ctx.translate ?? ((key: string) => key),
      readPreference: () => ctx.settings.read("computerUsePresentation"),
      writePreference: value => { ctx.settings.write("computerUsePresentation", value); },
      previewIdentity: cua.getCuaPreviewIdentity,
      capturePreview: cua.captureCuaTaskPreview,
      taskAction: async (id, action) => {
        if (action === "pause") return cua.pauseWindowTask(id);
        if (action === "resume") return cua.resumeWindowTask(id);
        if (action === "stop") return cua.stopWindowTask(id);
        if (action === "confirm") return cua.allowCuaSensitiveOnce(id) ? cua.resumeWindowTask(id)
          : { success: false, error: "operationCancelled" };
        return cua.takeOverWindowTask(id);
      },
    });
    const showPreview = (id: string) => {
      const state = cua.getCuaRuntime();
      if (state.multiwindow) return disposeControlWindow.showTask(id);
      if (!ctx.session.isAuthenticated() || state.taskId !== id || !isCuaLivePhase(state.phase, state)) return { success: false, error: "taskUnavailable" };
      const main = ctx.windows.getMain();
      if (!main || main.isDestroyed()) return { success: false, error: "taskUnavailable" };
      if (main.isMinimized()) main.restore(); main.show(); main.focus(); main.webContents.send("cua:showPreview");
      return { success: true };
    };
    ctx.hostIpc.handle("cua:showTaskPreview", taskControl(async id => showPreview(id), true), { success: false });

    // 状态推送宿主窗口 + 托盘急停项（经通用进行中操作端口）。
    const stop = () => { void cua.stopCuaTask().catch(() => undefined); };
    const promptedTargets = new Set<string>();
    const publish = (state: ReturnType<typeof cua.getCuaRuntime>) => {
      history.record(state);
      const window = ctx.windows.getMain();
      if (window && !window.isDestroyed()) {
        window.webContents.send("cua:runtime", state);
        const waiting = (state.tasks ?? []).filter(task => ["running", "paused"].includes(task.phase) &&
          (!task.scope || task.scope.kind === "window" && !task.scope.windowId));
        if (waiting.some(task => !promptedTargets.has(task.taskId))) {
          // Open inside the existing client without showing/focusing a hidden
          // owner. Detailed target setup no longer lives in the floating card.
          window.webContents.send("cua:openCenter");
          for (const task of waiting) promptedTargets.add(task.taskId);
        }
      }
      const current = new Set((state.tasks ?? []).map(task => task.taskId));
      for (const id of promptedTargets) if (!current.has(id)) promptedTargets.delete(id);
      const active = state.tasks ? state.tasks.some(task => isCuaLivePhase(task.phase, task))
        : isCuaLivePhase(state.phase, state);
      const actions = [{ id: "center", labelKey: "Claw.Cua.center.open", run: openCenter }];
      if (active) {
        actions.push({ id: "preview", labelKey: "Claw.Cua.preview.expand", run: () => {
          const id = state.multiwindow ? state.tasks?.find(canPreviewCuaTask)?.taskId : state.taskId;
          if (id) showPreview(id); else openCenter();
        } });
        actions.push({ id: "stop", labelKey: "Claw.Cua.multiwindow.stopAll", run: stop });
      }
      ctx.activities.set({ actions });
    };
    const unsubscribe = cua.onCuaRuntime(publish);
    publish(cua.getCuaRuntime());

    const registerShortcut = () => {
      try { cua.setCuaShortcutAvailable(globalShortcut.register(CUA_STOP_SHORTCUT, stop)); }
      catch { cua.setCuaShortcutAvailable(false); }
    };
    if (app.isReady()) registerShortcut();
    else void app.whenReady().then(registerShortcut);

    // 锁屏/休眠：暂停执行中的任务；解锁不自动恢复。
    const suspend = () => {
      cua.setCuaPreviewSuspended(true);
      if (cua.getCuaRuntime().phase === "running") void cua.pauseCuaTask("screenLocked").catch(() => undefined);
    };
    let locked = false;
    const lock = () => { locked = true; suspend(); };
    const unlock = () => { locked = false; cua.setCuaPreviewSuspended(false); };
    const wake = () => { if (!locked) cua.setCuaPreviewSuspended(false); };
    powerMonitor.on("lock-screen", lock);
    powerMonitor.on("unlock-screen", unlock);
    powerMonitor.on("resume", wake);
    powerMonitor.on("suspend", suspend);
    const onBeforeQuit = () => { cua.cancelCuaPermissionRequest(); };
    app.on("before-quit", onBeforeQuit);
    const onWillQuit = () => { void cua.suspendCua("appQuit").catch(() => undefined); };
    app.on("will-quit", onWillQuit);

    // 生命周期：登录失效第一时间撤销；服务停止随停清理；服务启动前收敛；退出收尾。
    const offInvalidated = ctx.lifecycle.onSessionInvalidated(() => {
      void cua.suspendCua("sessionEnded").catch(() => undefined);
    });
    const offSessionEnd = ctx.lifecycle.onSessionEnd(() => {
      void cua.suspendCua("sessionEnded").catch(() => undefined);
    });
    const offStopping = ctx.lifecycle.onServicesStopping(() => cua.suspendCua("sessionEnded"));
    const offStarting = ctx.lifecycle.onServicesStarting((signal) => cua.ensureCuaOnBoot(signal));
    const offQuit = ctx.lifecycle.onQuit(() => cua.suspendCua("appQuit"));

    const offParticipant = ctx.agent.registerSessionParticipant(() => new CuaEngineSessions(cuaSessionAuthority));

    return { dispose() {
      stopScreenshotRetention();
      offPermissionSubject?.();
      offParticipant();
      offInvalidated(); offSessionEnd(); offStopping(); offStarting(); offQuit();
      disposeControlWindow();
      unsubscribe();
      ctx.activities.set(null);
      globalShortcut.unregister(CUA_STOP_SHORTCUT);
      powerMonitor.removeListener("lock-screen", lock);
      powerMonitor.removeListener("unlock-screen", unlock); powerMonitor.removeListener("resume", wake);
      powerMonitor.removeListener("suspend", suspend);
      app.removeListener("will-quit", onWillQuit);
      app.removeListener("before-quit", onBeforeQuit);
      ctx.hostIpc.dispose();
    } };
  },
};
