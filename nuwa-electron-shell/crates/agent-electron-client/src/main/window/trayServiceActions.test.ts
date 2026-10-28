import { describe, expect, it, vi } from "vitest";
import { AuthLifecycle, type ServiceResult } from "@main/services/auth/lifecycle";
import { createTrayServiceActions } from "./trayServiceActions";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(commercial = true) {
  const adapter = {
    authenticated: vi.fn(() => true),
    register: vi.fn(async (_signal: AbortSignal) => "key"),
    commit: vi.fn(),
    start: vi.fn(async (_signal: AbortSignal): Promise<ServiceResult> => ({ success: true })),
    stop: vi.fn(async (): Promise<ServiceResult> => ({ success: true })),
  };
  const flow = new AuthLifecycle(adapter);
  const serviceManager = {
    restartAllServices: vi.fn(async (): Promise<ServiceResult> => ({ success: true })),
    stopAllServices: vi.fn(async (): Promise<ServiceResult> => ({ success: true })),
  };
  const updateServicesStatus = vi.fn();
  const setErrorStatus = vi.fn();
  let lifecycle: AuthLifecycle<string> | undefined = commercial ? flow : undefined;
  const actions = createTrayServiceActions({
    getCommercialLifecycle: () => lifecycle,
    serviceManager,
    updateServicesStatus,
    setErrorStatus,
  });
  return {
    adapter, flow, serviceManager, updateServicesStatus, setErrorStatus, actions,
    setLifecycle(value: AuthLifecycle<string> | undefined) { lifecycle = value; },
  };
}

describe("tray service actions", () => {
  it("stops the commercial lifecycle during registration before stale data can commit or start", async () => {
    const { adapter, flow, actions, serviceManager, updateServicesStatus } = fixture();
    const registration = deferred<string>();
    adapter.register.mockReturnValueOnce(registration.promise);
    const pendingStart = flow.start();
    await vi.waitFor(() => expect(adapter.register).toHaveBeenCalledTimes(1));

    const stopping = actions.onStopServices();
    expect(adapter.register.mock.calls[0][0].aborted).toBe(true);
    registration.resolve("stale-key");
    expect((await pendingStart).success).toBe(false);
    await stopping;

    expect(adapter.commit).not.toHaveBeenCalled();
    expect(adapter.start).not.toHaveBeenCalled();
    expect(adapter.stop).toHaveBeenCalledTimes(1);
    expect(serviceManager.stopAllServices).not.toHaveBeenCalled();
    expect(updateServicesStatus.mock.calls).toEqual([[false]]);
  });

  it("recovers by registering and starting a new lifecycle generation after tray stop", async () => {
    const { actions, adapter, updateServicesStatus, serviceManager } = fixture();
    await actions.onRestartServices();
    await actions.onStopServices();
    await actions.onRestartServices();
    expect(adapter.register).toHaveBeenCalledTimes(2);
    expect(adapter.start).toHaveBeenCalledTimes(2);
    expect(adapter.stop).toHaveBeenCalledTimes(1);
    expect(updateServicesStatus.mock.calls).toEqual([[true], [false], [true]]);
    expect(serviceManager.restartAllServices).not.toHaveBeenCalled();
    expect(serviceManager.stopAllServices).not.toHaveBeenCalled();
  });

  it("looks up the commercial lifecycle when invoked, including one injected after tray creation", async () => {
    const { actions, setLifecycle, flow, adapter, serviceManager } = fixture(false);
    setLifecycle(flow);
    await actions.onRestartServices();
    await actions.onStopServices();
    expect(adapter.register).toHaveBeenCalledTimes(1);
    expect(adapter.stop).toHaveBeenCalledTimes(1);
    expect(serviceManager.restartAllServices).not.toHaveBeenCalled();
    expect(serviceManager.stopAllServices).not.toHaveBeenCalled();
  });

  it("uses the community service manager when no commercial lifecycle is configured", async () => {
    const { actions, setLifecycle, serviceManager, adapter, updateServicesStatus } = fixture();
    setLifecycle(undefined);
    await actions.onRestartServices();
    await actions.onStopServices();
    expect(serviceManager.restartAllServices).toHaveBeenCalledTimes(1);
    expect(serviceManager.stopAllServices).toHaveBeenCalledTimes(1);
    expect(adapter.register).not.toHaveBeenCalled();
    expect(adapter.stop).not.toHaveBeenCalled();
    expect(updateServicesStatus.mock.calls).toEqual([[true], [false]]);
  });

  it("retains the commercial login gate without falling back to community startup", async () => {
    const { actions, adapter, serviceManager, updateServicesStatus, setErrorStatus } = fixture();
    adapter.authenticated.mockReturnValue(false);
    await expect(actions.onRestartServices()).rejects.toThrow("Login required");
    expect(adapter.register).not.toHaveBeenCalled();
    expect(adapter.start).not.toHaveBeenCalled();
    expect(serviceManager.restartAllServices).not.toHaveBeenCalled();
    expect(updateServicesStatus).not.toHaveBeenCalled();
    expect(setErrorStatus).toHaveBeenCalledTimes(1);
  });

  it.each(["onRestartServices", "onStopServices"] as const)("reports a failed commercial %s without marking it successful", async (action) => {
    const { actions, adapter, updateServicesStatus, setErrorStatus } = fixture();
    const failure = { success: false, error: "service failed" };
    if (action === "onRestartServices") adapter.start.mockResolvedValue(failure);
    else adapter.stop.mockResolvedValue(failure);
    await expect(actions[action]()).rejects.toThrow("service failed");
    if (action === "onRestartServices") adapter.start.mockRejectedValueOnce(new Error("operation rejected"));
    else adapter.stop.mockRejectedValueOnce(new Error("operation rejected"));
    await expect(actions[action]()).rejects.toThrow("operation rejected");
    expect(updateServicesStatus).not.toHaveBeenCalled();
    expect(setErrorStatus).toHaveBeenCalledTimes(2);
  });

  it.each(["onRestartServices", "onStopServices"] as const)("reports an unsuccessful or thrown community %s without marking it successful", async (action) => {
    const { actions, setLifecycle, serviceManager, updateServicesStatus, setErrorStatus } = fixture();
    setLifecycle(undefined);
    const operation = action === "onRestartServices"
      ? serviceManager.restartAllServices
      : serviceManager.stopAllServices;
    operation.mockResolvedValueOnce({ success: false });
    await expect(actions[action]()).rejects.toThrow("failed");
    operation.mockRejectedValueOnce(new Error("stop rejected"));
    await expect(actions[action]()).rejects.toThrow("stop rejected");
    expect(updateServicesStatus).not.toHaveBeenCalled();
    expect(setErrorStatus).toHaveBeenCalledTimes(2);
  });

  it("keeps a newer stop status when it cancels a pending tray restart", async () => {
    const { actions, adapter, updateServicesStatus, setErrorStatus } = fixture();
    const registration = deferred<string>();
    adapter.register.mockReturnValueOnce(registration.promise);
    const restarting = actions.onRestartServices();
    const rejected = expect(restarting).rejects.toThrow("Session changed");
    await vi.waitFor(() => expect(adapter.register).toHaveBeenCalledTimes(1));
    const stopping = actions.onStopServices();
    registration.resolve("stale-key");
    await rejected;
    await stopping;
    expect(updateServicesStatus.mock.calls).toEqual([[false]]);
    expect(setErrorStatus).not.toHaveBeenCalled();
  });
});
