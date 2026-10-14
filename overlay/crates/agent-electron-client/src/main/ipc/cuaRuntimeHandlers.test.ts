import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  events: new Map<string, () => void>(),
  stop: vi.fn(), pause: vi.fn(), resume: vi.fn(), recover: vi.fn(), selfTest: vi.fn(), clear: vi.fn(),
  runtime: { phase: "running" }, register: vi.fn(), shortcut: vi.fn(), send: vi.fn(),
  listener: undefined as ((state: any) => void) | undefined,
}));
vi.mock("electron", () => ({
  ipcMain: { handle: (name: string, fn: any) => mocks.handlers.set(name, fn) },
  app: { isReady: () => true, once: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  globalShortcut: { register: mocks.register, unregister: vi.fn() },
  powerMonitor: { on: (name: string, fn: () => void) => mocks.events.set(name, fn), removeListener: vi.fn() },
}));
vi.mock("../services/cua/computerUse", () => ({
  stopCuaTask: mocks.stop, pauseCuaTask: mocks.pause, resumeCuaTask: mocks.resume, recoverCua: mocks.recover,
  selfTestCua: mocks.selfTest, clearCuaHistory: mocks.clear, getCuaRuntime: () => mocks.runtime,
  setCuaShortcutAvailable: mocks.shortcut,
  onCuaRuntime: (listener: any) => { mocks.listener = listener; return () => {}; },
}));
vi.mock("../window/trayManager", () => ({ getTrayManager: () => ({ setComputerUseStopAction: vi.fn() }) }));
vi.mock("../services/i18n", () => ({ t: (key: string) => key }));
import { registerCuaRuntimeHandlers } from "./cuaRuntimeHandlers";
beforeEach(() => {
  vi.clearAllMocks(); mocks.handlers.clear(); mocks.events.clear();
  mocks.stop.mockResolvedValue({ success: true }); mocks.pause.mockResolvedValue({ success: true });
  mocks.register.mockReturnValue(false); mocks.runtime = { phase: "running" };
});
function register(loggedIn = true) {
  registerCuaRuntimeHandlers({ trusted: (event: any) => event.trusted === true, authenticated: () => loggedIn,
    getWindow: () => ({ isDestroyed: () => false, webContents: { send: mocks.send } }) as any,
  });
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
});
