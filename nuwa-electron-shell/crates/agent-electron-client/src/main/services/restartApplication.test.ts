import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ relaunch: vi.fn(), quit: vi.fn(), dev: true, packaged: false }));
vi.mock("electron", () => ({ app: { relaunch: mocks.relaunch, quit: mocks.quit, get isPackaged() { return mocks.packaged; } } }));
vi.mock("@shared/constants", () => ({ get IS_DEV_PROFILE() { return mocks.dev; } }));

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); mocks.dev = true; mocks.packaged = false; });
afterEach(() => vi.unstubAllEnvs());

describe("application restart", () => {
  it("requests a supervised restart and waits for normal cleanup", async () => {
    vi.stubEnv("NUWAX_DEV_SUPERVISED", "1");
    const { restartApplication, applicationExitCode } = await import("./restartApplication");
    expect(applicationExitCode()).toBe(0);
    restartApplication();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(mocks.quit).toHaveBeenCalledOnce();
    expect(applicationExitCode()).toBe(75);
  });
  it.each(["standalone development", "packaged application"])("relaunches normally for %s", async (mode) => {
    vi.stubEnv("NUWAX_DEV_SUPERVISED", mode === "packaged application" ? "1" : "");
    mocks.packaged = mode === "packaged application";
    const { restartApplication, applicationExitCode } = await import("./restartApplication");
    restartApplication();
    expect(mocks.relaunch).toHaveBeenCalledOnce();
    expect(mocks.quit).toHaveBeenCalledOnce();
    expect(applicationExitCode()).toBe(0);
  });
});
