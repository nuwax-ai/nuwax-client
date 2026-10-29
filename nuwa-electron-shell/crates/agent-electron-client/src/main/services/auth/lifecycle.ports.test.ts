import { describe, expect, it, vi } from "vitest";
import { AuthLifecycle } from "./lifecycle";

describe("endpoint registration lifecycle", () => {
  it("discards a late endpoint generation and commits only the latest registration", async () => {
    let generation = 1;
    let finish!: (value: number) => void;
    const first = new Promise<number>((resolve) => { finish = resolve; });
    const commit = vi.fn();
    const register = vi.fn().mockReturnValueOnce(first).mockImplementation(async () => generation);
    const flow = new AuthLifecycle({ authenticated: () => true, register, commit,
      registrationCurrent: (value: number) => value === generation,
      start: async () => ({ success: true }), stop: async () => ({ success: true }) });
    const result = flow.sync();
    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    generation = 2; finish(1);
    expect(await result).toBe(2);
    expect(commit.mock.calls).toEqual([[2]]);
  });

  it("reconciles inline before the tunnel without queueing recursively", async () => {
    let generation = 1;
    const order: string[] = [];
    let flow!: AuthLifecycle<number>;
    flow = new AuthLifecycle({ authenticated: () => true,
      register: async () => generation,
      registrationCurrent: (value) => value === generation,
      commit: (value) => { order.push(`registered:${value}`); },
      start: async (signal) => {
        order.push("local-ready"); generation++;
        await flow.reconcileRegistration(signal);
        order.push("tunnel-ready"); return { success: true };
      }, stop: async () => ({ success: true }) });
    expect((await flow.start()).success).toBe(true);
    expect(order).toEqual(["registered:1", "local-ready", "registered:2", "tunnel-ready"]);
  });

  it("updates registration and reconnects the tunnel after a single-service port change", async () => {
    let generation = 1;
    const order: string[] = [];
    const flow = new AuthLifecycle({ authenticated: () => true,
      register: async () => generation,
      registrationCurrent: (value) => value === generation,
      commit: (value) => { order.push(`registered:${value}`); },
      reconnect: async () => { order.push("reconnect"); },
      start: async () => ({ success: true }), stop: async () => ({ success: true }) });
    await flow.start();
    await flow.run(async () => { generation++; return { success: true }; });
    expect(order).toEqual(["registered:1", "registered:2", "reconnect"]);
  });

  it("stops the old tunnel when a single-service port change cannot be registered", async () => {
    let generation = 1; const failed = vi.fn(async () => {}); const reconnect = vi.fn();
    const register = vi.fn(async () => generation);
    const flow = new AuthLifecycle({ authenticated: () => true, register, commit: () => {},
      registrationCurrent: (value) => value === generation, failed, reconnect,
      start: async () => ({ success: true }), stop: async () => ({ success: true }) });
    await flow.start();
    register.mockRejectedValueOnce(new Error("Registration unavailable"));
    await expect(flow.run(async () => { generation++; return { success: true }; })).rejects.toThrow("Registration unavailable");
    expect(failed).toHaveBeenCalledTimes(1); expect(reconnect).not.toHaveBeenCalled();
  });

  it("does not register failed endpoints or reactivate a tunnel after a failed single-service bind", async () => {
    let generation = 1; const failed = vi.fn(async () => {}); const reconnect = vi.fn();
    const register = vi.fn(async () => generation);
    const flow = new AuthLifecycle({ authenticated: () => true, register, commit: () => {},
      registrationCurrent: (value) => value === generation, failed, reconnect,
      start: async () => ({ success: true }), stop: async () => ({ success: true }) });
    await flow.start();
    const result = await flow.run(async () => { generation++; return { success: false }; });
    expect(result.success).toBe(false); expect(register).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledTimes(1); expect(reconnect).not.toHaveBeenCalled();
  });

  it("does not skip a restart after a child exited even if the last start was ready", async () => {
    let ready = true;
    const start = vi.fn(async () => ({ success: true }));
    const flow = new AuthLifecycle({ authenticated: () => true, register: async () => 1,
      commit: () => {}, servicesReady: () => ready, start, stop: async () => ({ success: true }) });
    await flow.start(); ready = false;
    await flow.start();
    expect(start).toHaveBeenCalledTimes(2);
  });
});
