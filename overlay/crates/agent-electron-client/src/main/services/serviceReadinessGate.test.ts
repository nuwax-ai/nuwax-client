import { describe, expect, it, vi } from "vitest";
import { createServiceReadinessGate } from "./serviceReadinessGate";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const ready = { ok: true, detail: [], elapsedMs: 1 };
const failed = { ok: false, detail: ["not-ready"], elapsedMs: 30_000 };

describe("main-process readiness gate", () => {
  it("coalesces startup and repeated retry requests into one probe", async () => {
    const probe = deferred<typeof ready>();
    const run = vi.fn(() => probe.promise);
    const publish = vi.fn();
    const gate = createServiceReadinessGate({ probe: run, publish, warn: vi.fn() });
    const first = gate.run();
    expect(gate.run()).toBe(first);
    expect(gate.result()).toBeNull();
    await Promise.resolve();
    expect(run).toHaveBeenCalledOnce();
    probe.resolve(ready);
    await first;
    expect(gate.result()).toEqual(ready);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(ready);
  });

  it("invalidates the previous failure synchronously before a new probe", async () => {
    const next = deferred<typeof ready>();
    const probe = vi.fn().mockResolvedValueOnce(failed).mockImplementationOnce(() => next.promise);
    const gate = createServiceReadinessGate({ probe, publish: vi.fn(), warn: vi.fn() });
    await gate.run();
    expect(gate.result()).toEqual(failed);
    const retry = gate.run();
    expect(gate.result()).toBeNull();
    next.resolve(ready);
    await retry;
    expect(gate.result()).toEqual(ready);
  });

  it("consumes probe rejection and publishes a safe recoverable failure", async () => {
    const warn = vi.fn();
    const publish = vi.fn();
    const probe = vi.fn().mockRejectedValueOnce(new Error("ticket=private URL payload")).mockResolvedValueOnce(ready);
    const gate = createServiceReadinessGate({ probe, publish, warn });
    await expect(gate.run()).resolves.toMatchObject({ ok: false, detail: ["gate-unavailable"] });
    expect(JSON.stringify([publish.mock.calls, warn.mock.calls])).not.toMatch(/private|ticket|payload/);
    await gate.run();
    expect(gate.result()).toEqual(ready);
  });

  it("retains the completed cache if the window closes before event delivery", async () => {
    const warn = vi.fn();
    let gate!: ReturnType<typeof createServiceReadinessGate>;
    gate = createServiceReadinessGate({
      probe: async () => ready,
      publish: () => { expect(gate.result()).toEqual(ready); throw new Error("destroyed window"); },
      warn,
    });
    await expect(gate.run()).resolves.toEqual(ready);
    expect(gate.result()).toEqual(ready);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("delivery-failed");
  });
});
