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
import { configureComputerUseHost } from "./ports";
import { createCuaControlWindow } from "./controlWindow";
import { createCuaWindowBadges } from "./windowBadges";
import { CuaEngineSessions, cuaSessionAuthority } from "./sessionAuthority";
import type { CuaScope } from "@shared/features/computer-use/contract";

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

    const offPermissionSubject = ctx.permissions?.registerExternalSubject?.({
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
    ctx.hostIpc.handle("cua:requestPermissions", () => cua.requestCuaPermissions(), null);
    ctx.hostIpc.handle("cua:installHelper", () => cua.installCuaHelper(), { success: false, error: "untrusted sender" });
    ctx.hostIpc.handle("cua:getVlmConfig", () => cua.getVlmConfig(), null);
    ctx.hostIpc.handle("cua:setVlmConfig", (event: IpcMainInvokeEvent, patch: unknown) => cua.setVlmConfig(
      (patch ?? {}) as { baseUrl?: string; model?: string; apiKey?: string; clearApiKey?: boolean },
    ), { success: false, error: "untrusted sender" });
    ctx.hostIpc.handle("cua:testVlm", () => cua.testVlm(), { success: false, error: "untrusted sender" });

    // 控制浮窗：独立最小 preload、精确 sender 校验、阻断导航，急停常驻可见。
    const disposeControlWindow = createCuaControlWindow({
      getRuntime: cua.getCuaRuntime, subscribe: cua.onCuaRuntime,
      authenticated: () => ctx.session.isAuthenticated(), t: ctx.translate ?? ((key: string) => key),
      action: async (action) => {
        if (action === "pause") return cua.pauseCuaTask();
        if (action === "resume") return cua.resumeCuaTask();
        if (action === "stop") return cua.stopCuaTask();
        if (action === "recover") return cua.recoverCua();
        return { success: cua.clearCuaHistory() };
      },
      readPreference: () => ctx.settings.read("computerUsePresentation"),
      writePreference: value => { ctx.settings.write("computerUsePresentation", value); },
      previewIdentity: cua.getCuaPreviewIdentity,
      capturePreview: cua.captureCuaTaskPreview,
      listWindows: cua.listCuaWindows,
      taskAction: async (id, action, value) => {
        if (action === "bind") return cua.bindWindowTask(id, value);
        if (action === "pause") return cua.pauseWindowTask(id);
        if (action === "resume") return cua.resumeWindowTask(id);
        if (action === "stop") return cua.stopWindowTask(id);
        if (action === "takeover") return cua.takeOverWindowTask(id);
        return cua.setWindowTaskMode(id, value);
      },
    });
    const showPreview = (id: string) => disposeControlWindow.showTask(id);
    ctx.hostIpc.handle("cua:showTaskPreview", taskControl(async id => showPreview(id), true), { success: false });
    const disposeBadges = createCuaWindowBadges(cua.onCuaWindowFrames, showPreview, ctx.translate);

    // 状态推送宿主窗口 + 托盘急停项（经通用进行中操作端口）。
    const stop = () => { void cua.stopCuaTask().catch(() => undefined); };
    const unsubscribe = cua.onCuaRuntime((state) => {
      const window = ctx.windows.getMain();
      if (window && !window.isDestroyed()) window.webContents.send("cua:runtime", state);
      const active = state.tasks ? state.tasks.some((task) => ["running", "paused", "failed"].includes(task.phase))
        : ["running", "paused", "failed"].includes(state.phase);
      const actions = [{ id: "stop", labelKey: "Claw.Cua.stop", run: stop }];
      if (state.multiwindow && state.tasks?.length) actions.unshift({
        id: "preview", labelKey: "Claw.Cua.preview.expand",
        run: () => { disposeControlWindow.showTask(); },
      });
      ctx.activities.set(active ? { actions } : null);
    });

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
      offPermissionSubject?.();
      offParticipant();
      offInvalidated(); offSessionEnd(); offStopping(); offStarting(); offQuit();
      disposeControlWindow();
      disposeBadges();
      unsubscribe();
      ctx.activities.set(null);
      globalShortcut.unregister(CUA_STOP_SHORTCUT);
      powerMonitor.removeListener("lock-screen", lock);
      powerMonitor.removeListener("unlock-screen", unlock); powerMonitor.removeListener("resume", wake);
      powerMonitor.removeListener("suspend", suspend);
      app.removeListener("will-quit", onWillQuit);
      ctx.hostIpc.dispose();
    } };
  },
};
