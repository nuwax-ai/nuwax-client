import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  events: new Map<string, () => void>(),
  stop: vi.fn(), pause: vi.fn(), resume: vi.fn(), recover: vi.fn(), selfTest: vi.fn(), clear: vi.fn(),
  taskPause: vi.fn(), taskStop: vi.fn(), taskResume: vi.fn(), taskMode: vi.fn(),
  runtime: { phase: "running" }, register: vi.fn(), shortcut: vi.fn(), send: vi.fn(),
  listener: undefined as ((state: any) => void) | undefined,
  activities: [] as Array<{ actions: Array<{ id: string; run(): void }> } | null>,
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, fn: any) => mocks.handlers.set(name, fn),
    removeHandler: (name: string) => void mocks.handlers.delete(name),
  },
  app: {
    isReady: () => true,
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    whenReady: () => Promise.resolve(),
  },
  dialog: { showSaveDialog: vi.fn() },
  globalShortcut: { register: mocks.register, unregister: vi.fn() },
  powerMonitor: { on: (name: string, fn: () => void) => mocks.events.set(name, fn), removeListener: vi.fn() },
}));
vi.mock("./computerUse", () => ({
  stopCuaTask: mocks.stop, pauseCuaTask: mocks.pause, resumeCuaTask: mocks.resume, recoverCua: mocks.recover,
  selfTestCua: mocks.selfTest, clearCuaHistory: mocks.clear, getCuaRuntime: () => mocks.runtime,
  setCuaShortcutAvailable: mocks.shortcut,
  onCuaRuntime: (listener: any) => { mocks.listener = listener; return () => {}; },
  suspendCua: vi.fn().mockResolvedValue(undefined), cancelCuaPermissionRequest: vi.fn(),
  ensureCuaOnBoot: vi.fn().mockResolvedValue(undefined),
  getCuaStatus: vi.fn(), getCuaHelperAppPath: vi.fn(() => "/owned/Nuwax Computer Use.app"),
  setCuaEnabled: vi.fn(), requestCuaPermissions: vi.fn(), installCuaHelper: vi.fn(),
  getVlmConfig: vi.fn(), setVlmConfig: vi.fn(), testVlm: vi.fn(),
  getCuaDiagnostics: vi.fn(), listCuaWindows: vi.fn(), setCuaScope: vi.fn(),
  getCuaTasks: vi.fn().mockReturnValue([]), bindWindowTask: vi.fn(), pauseWindowTask: mocks.taskPause,
  resumeWindowTask: mocks.taskResume, stopWindowTask: mocks.taskStop, setWindowTaskMode: mocks.taskMode, setMultiwindowEnabled: vi.fn(),
  onCuaWindowFrames: () => () => {}, setCuaPreviewSuspended: vi.fn(),
  getCuaPreviewIdentity: vi.fn(), captureCuaTaskPreview: vi.fn(), takeOverWindowTask: vi.fn(),
}));
vi.mock("./controlWindow", () => ({ createCuaControlWindow: () => () => {} }));
import { computerUseFeature } from "./index";
import { createTrustedIpc } from "../_kit/trustedIpc";

beforeEach(() => {
  vi.clearAllMocks(); mocks.handlers.clear(); mocks.events.clear(); mocks.activities.length = 0;
  mocks.stop.mockResolvedValue({ success: true }); mocks.pause.mockResolvedValue({ success: true });
  mocks.taskPause.mockResolvedValue({ success: true }); mocks.taskStop.mockResolvedValue({ success: true });
  mocks.register.mockReturnValue(false); mocks.runtime = { phase: "running" };
});

function register(loggedIn = true, permissions?: unknown) {
  const ipcMain = {
    handle: (name: string, fn: any) => mocks.handlers.set(name, fn),
    removeHandler: (name: string) => void mocks.handlers.delete(name),
  };
  const noop = () => () => {};
  const ctx = {
    product: "nuwax",
    ipc: createTrustedIpc(ipcMain as never, () => true),
    hostIpc: createTrustedIpc(ipcMain as never, (event: any) => event?.trusted === true),
    lifecycle: {
      onSessionInvalidated: noop, onServicesStarting: noop,
      onServicesStopping: noop, onSessionEnd: noop, onQuit: noop,
    },
    scratch: { root: "/tmp/cua", isValidId: () => true, create: (id: string) => `/tmp/cua/${id}`, resolve: () => null, remove: () => {}, sweep: () => {} },
    dataDir: "/tmp/cua",
    permissions,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    translate: (key: string) => key,
    settings: { read: () => null, write: () => true },
    session: { isAuthenticated: () => loggedIn },
    windows: { getMain: () => ({ isDestroyed: () => false, webContents: { send: mocks.send } }) as any },
    activities: { set: (activity: any) => { mocks.activities.push(activity); } },
    agent: {
      setLocalMcpServer: async () => undefined,
      hasLocalMcpServer: () => false,
      resolveNodeBinary: () => null,
      registerSessionParticipant: () => () => {},
    },
  } as never;
  return computerUseFeature.register(ctx);
}

describe("Computer Use trusted controls", () => {
  it("registers the helper identity without requesting permission or enabling CU, and disposes it", async () => {
    const cua = await import("./computerUse");
    const unregister = vi.fn();
    const subject = vi.fn((_adapter: unknown) => unregister);
    const handle = register(true, { registerExternalSubject: subject });
    expect(cua.requestCuaPermissions).not.toHaveBeenCalled();
    expect(cua.ensureCuaOnBoot).not.toHaveBeenCalled();
    const adapter = subject.mock.calls[0][0] as any;
    vi.mocked(cua.getCuaStatus).mockResolvedValueOnce({ accessibility: true, screenRecording: null } as any);
    expect(await adapter.check()).toEqual({ accessibility: "granted", screen_recording: "unknown" });
    expect(adapter.appPath()).toBe("/owned/Nuwax Computer Use.app");
    vi.mocked(cua.requestCuaPermissions).mockResolvedValueOnce({ accessibility: true, screenRecording: false } as any);
    expect(await adapter.request("screen_recording")).toBe(false);
    await handle.dispose();
    expect(unregister).toHaveBeenCalledOnce();
  });
  it("protects task controls and permits trusted pause/stop after login expires", async () => {
    register(false);
    for (const name of ["bindTarget", "pauseTask", "resumeTask", "stopTask", "setTaskMode", "stopAll", "setMultiwindowEnabled", "showTaskPreview", "takeOverTask"])
      expect((await mocks.handlers.get("cua:" + name)!({}, "A", "foreground")).success).toBe(false);
    for (const name of ["bindTarget", "resumeTask", "setTaskMode", "showTaskPreview", "takeOverTask"])
      expect((await mocks.handlers.get("cua:" + name)!({ trusted: true }, "A", "foreground")).error).toBe("loginRequired");
    expect((await mocks.handlers.get("cua:pauseTask")!({ trusted: true }, "A", { forgedReason: true })).success).toBe(true);
    expect(mocks.taskPause).toHaveBeenCalledWith("A");
    expect((await mocks.handlers.get("cua:stopTask")!({ trusted: true }, "A")).success).toBe(true);
  });
  it("rejects foreign callers before any control, observation or clear action", async () => {
    register();
    for (const name of ["pause", "resume", "stop", "recover", "selfTest", "clearHistory"]) {
      expect((await mocks.handlers.get(`cua:${name}`)!({})).success).toBe(false);
    }
    expect(mocks.handlers.get("cua:getRuntime")!({})).toBeNull();
    expect(mocks.stop).not.toHaveBeenCalled(); expect(mocks.pause).not.toHaveBeenCalled();
  });
  it("requires login for resuming/recovering but always permits a trusted emergency stop", async () => {
    register(false);
    expect((await mocks.handlers.get("cua:resume")!({ trusted: true })).error).toBe("loginRequired");
    expect((await mocks.handlers.get("cua:recover")!({ trusted: true })).error).toBe("loginRequired");
    expect((await mocks.handlers.get("cua:stop")!({ trusted: true })).success).toBe(true);
  });
  it("reports unavailable shortcuts and pauses on lock without auto-resuming on unlock", () => {
    register();
    expect(mocks.shortcut).toHaveBeenCalledWith(false);
    mocks.events.get("lock-screen")!();
    expect(mocks.pause).toHaveBeenCalledWith("screenLocked");
    mocks.events.get("unlock-screen")!();
    expect(mocks.resume).not.toHaveBeenCalled();
  });
  it("pushes runtime to the host window without broadcasting to guests", () => {
    register(); mocks.listener!({ phase: "paused" });
    expect(mocks.send).toHaveBeenCalledWith("cua:runtime", { phase: "paused" });
  });
  it("keeps the task center in the tray after tasks finish and limits emergency stop to live work", () => {
    register();
    mocks.listener!({ phase: "running" });
    const active = mocks.activities.at(-1);
    expect(active?.actions.map((action) => action.id)).toEqual(["center", "preview", "stop"]);
    active?.actions.find(action => action.id === "stop")?.run();
    expect(mocks.stop).toHaveBeenCalledOnce();
    mocks.listener!({ phase: "idle" });
    expect(mocks.activities.at(-1)?.actions.map(action => action.id)).toEqual(["center"]);
    mocks.listener!({ phase: "stopped", controlPending: true, reason: "userStopped" });
    expect(mocks.activities.at(-1)?.actions.map(action => action.id)).toEqual(["center", "preview", "stop"]);
  });
  it("prompts target setup once inside the client, leaving bound tasks in the floating preview", () => {
    register(); mocks.send.mockClear();
    const state = { multiwindow: true, tasks: [{ taskId: "new", phase: "paused", scope: { kind: "window", pid: 0, windowId: 0 } }] };
    mocks.listener!(state); mocks.listener!(state);
    expect(mocks.send.mock.calls.filter(([name]) => name === "cua:openCenter")).toHaveLength(1);
    mocks.listener!({ ...state, tasks: [{ ...state.tasks[0], taskId: "bound", scope: { kind: "window", pid: 5, windowId: 6 } }] });
    expect(mocks.send.mock.calls.filter(([name]) => name === "cua:openCenter")).toHaveLength(1);
  });

});
