import { describe, expect, it, vi } from "vitest";
import { createDockVisibility } from "./dockVisibility";

function fixture(platform = "darwin") {
  let quitting = false;
  let visible = false;
  const app = {
    setActivationPolicy: vi.fn(),
    dock: { isVisible: vi.fn(() => visible), show: vi.fn(async () => { visible = true; }) },
  };
  const log = { info: vi.fn(), warn: vi.fn() };
  const api = createDockVisibility({ app, platform, isQuitting: () => quitting, log });
  return { app, log, api, quit: () => { quitting = true; } };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("macOS Dock visibility recovery", () => {
  it("coalesces lifecycle recovery without changing the foreground window", async () => {
    const { app, api } = fixture();
    api.ensure("window-hide");
    api.ensure("resume");
    await settle();
    expect(app.dock.show).toHaveBeenCalledOnce();
    expect(app.setActivationPolicy).toHaveBeenCalledWith("regular");
    api.ensure("window-show");
    await settle();
    expect(app.dock.show).toHaveBeenCalledOnce();
  });

  it("handles asynchronous OS rejection and allows recovery on the next event", async () => {
    const { app, log, api } = fixture();
    app.dock.show.mockRejectedValueOnce(new Error("OS failure"));
    api.ensure("resume");
    await settle();
    expect(log.warn).toHaveBeenCalledWith("[Dock] Visibility recovery failed", { reason: "resume" });
    api.ensure("unlock-screen");
    await settle();
    expect(app.dock.show).toHaveBeenCalledTimes(2);
  });

  it("does not resurrect the Dock after quitting starts", async () => {
    const { app, api, quit } = fixture();
    api.ensure("window-hide");
    quit();
    await settle();
    api.ensure("resume");
    expect(app.dock.show).not.toHaveBeenCalled();
  });

  it.each(["win32", "linux"])("does not change platform policy on %s", (platform) => {
    const { app, api } = fixture(platform);
    api.ensure("window-hide");
    expect(app.setActivationPolicy).not.toHaveBeenCalled();
    expect(app.dock.show).not.toHaveBeenCalled();
  });

  it("records a refused recovery without spinning or retrying automatically", async () => {
    const { app, log, api } = fixture();
    app.dock.show.mockImplementationOnce(async () => {});
    api.ensure("window-hide");
    await settle();
    expect(log.warn).toHaveBeenCalledOnce();
    expect(app.dock.show).toHaveBeenCalledOnce();
  });
});
