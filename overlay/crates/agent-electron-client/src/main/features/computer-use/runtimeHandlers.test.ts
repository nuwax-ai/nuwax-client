import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  events: new Map<string, () => void>(),
  stop: vi.fn(), pause: vi.fn(), resume: vi.fn(), recover: vi.fn(), selfTest: vi.fn(), clear: vi.fn(),
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
  suspendCua: vi.fn().mockResolvedValue(undefined),
  ensureCuaOnBoot: vi.fn().mockResolvedValue(undefined),
  getCuaStatus: vi.fn(), setCuaEnabled: vi.fn(), requestCuaPermissions: vi.fn(), installCuaHelper: vi.fn(),
  getVlmConfig: vi.fn(), setVlmConfig: vi.fn(), testVlm: vi.fn(),
  getCuaDiagnostics: vi.fn(), listCuaWindows: vi.fn(), setCuaScope: vi.fn(),
}));
vi.mock("./controlWindow", () => ({ createCuaControlWindow: () => () => {} }));
import { computerUseFeature } from "./index";
import { createTrustedIpc } from "../_kit/trustedIpc";

beforeEach(() => {
  vi.clearAllMocks(); mocks.handlers.clear(); mocks.events.clear(); mocks.activities.length = 0;
  mocks.stop.mockResolvedValue({ success: true }); mocks.pause.mockResolvedValue({ success: true });
  mocks.register.mockReturnValue(false); mocks.runtime = { phase: "running" };
});

function register(loggedIn = true) {
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
    expect(mocks.events.has("unlock-screen")).toBe(false);
  });
  it("pushes runtime to the host window without broadcasting to guests", () => {
    register(); mocks.listener!({ phase: "paused" });
    expect(mocks.send).toHaveBeenCalledWith("cua:runtime", { phase: "paused" });
  });
  it("registers the emergency stop as a tray activity only while a task exists", () => {
    register();
    mocks.listener!({ phase: "running" });
    const active = mocks.activities.at(-1);
    expect(active?.actions.map((action) => action.id)).toEqual(["stop"]);
    active?.actions[0].run();
    expect(mocks.stop).toHaveBeenCalledOnce();
    mocks.listener!({ phase: "idle" });
    expect(mocks.activities.at(-1)).toBeNull();
  });
});
