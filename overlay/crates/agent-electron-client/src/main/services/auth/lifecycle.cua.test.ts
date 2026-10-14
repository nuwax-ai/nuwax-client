import { expect, it, vi } from "vitest";
import { AuthLifecycle } from "./lifecycle";

it("revokes capabilities immediately even when an earlier start still occupies the queue", async () => {
  let release!: () => void;
  let entered!: () => void;
  const entering = new Promise<void>((resolve) => { entered = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const invalidated = vi.fn();
  const stop = vi.fn().mockResolvedValue({ success: true });
  const flow = new AuthLifecycle({ authenticated: () => true, invalidated,
    register: async () => ({}), commit: () => {}, stop,
    start: async () => { entered(); await waiting; return { success: true }; },
  });
  const starting = flow.start();
  await entering;
  const stopping = flow.stop();
  expect(invalidated).toHaveBeenCalledTimes(1);
  expect(stop).not.toHaveBeenCalled();
  release();
  expect((await starting).success).toBe(false);
  expect((await stopping).success).toBe(true);
});
