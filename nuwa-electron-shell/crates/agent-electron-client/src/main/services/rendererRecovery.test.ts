import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron-log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { attachRendererRecovery } from "./rendererRecovery";

const RELOAD_DELAY = 100;

function setup(options: { quitting?: boolean; maxCrashes?: number } = {}) {
  const emitter = new EventEmitter();
  const state = { destroyed: false, quitting: options.quitting ?? false, clock: 0 };
  const contents = Object.assign(emitter, {
    reload: vi.fn(),
    forcefullyCrashRenderer: vi.fn(),
    isDestroyed: () => state.destroyed,
  });
  const onGiveUp = vi.fn();
  attachRendererRecovery(contents as unknown as WebContents, {
    isQuitting: () => state.quitting,
    onGiveUp,
    maxCrashes: options.maxCrashes,
    windowMs: 1000,
    unresponsiveGraceMs: 500,
    reloadDelayMs: RELOAD_DELAY,
    now: () => state.clock,
  });
  const gone = (reason = "crashed") =>
    emitter.emit("render-process-gone", {}, { reason, exitCode: 1 });
  const settle = () => vi.advanceTimersByTime(RELOAD_DELAY);
  return { emitter, contents, state, onGiveUp, gone, settle };
}

describe("renderer recovery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reloads after a crash, but never synchronously inside the crash callback", () => {
    const { contents, gone, settle, onGiveUp } = setup();
    gone("oom");
    expect(contents.reload).not.toHaveBeenCalled();
    settle();
    expect(contents.reload).toHaveBeenCalledTimes(1);
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it("ignores clean exits, quitting apps and destroyed contents", () => {
    const clean = setup();
    clean.gone("clean-exit");
    clean.settle();
    expect(clean.contents.reload).not.toHaveBeenCalled();

    const quitting = setup({ quitting: true });
    quitting.gone();
    quitting.settle();
    expect(quitting.contents.reload).not.toHaveBeenCalled();

    const destroyed = setup();
    destroyed.state.destroyed = true;
    destroyed.gone();
    destroyed.settle();
    expect(destroyed.contents.reload).not.toHaveBeenCalled();
  });

  it("skips the pending reload if the app starts quitting or the window is destroyed meanwhile", () => {
    const quitting = setup();
    quitting.gone();
    quitting.state.quitting = true;
    quitting.settle();
    expect(quitting.contents.reload).not.toHaveBeenCalled();

    const destroyed = setup();
    destroyed.gone();
    destroyed.state.destroyed = true;
    destroyed.settle();
    expect(destroyed.contents.reload).not.toHaveBeenCalled();
  });

  it("stops reloading and gives up once after exceeding the crash budget", () => {
    const { contents, gone, settle, onGiveUp } = setup({ maxCrashes: 2 });
    gone();
    settle();
    gone();
    settle();
    expect(contents.reload).toHaveBeenCalledTimes(2);
    gone();
    settle();
    expect(contents.reload).toHaveBeenCalledTimes(2);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    gone();
    settle();
    expect(contents.reload).toHaveBeenCalledTimes(2);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
  });

  it("drops a still-pending reload once recovery has given up", () => {
    const { contents, gone, settle, onGiveUp } = setup({ maxCrashes: 1 });
    gone();
    gone();
    settle();
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(contents.reload).not.toHaveBeenCalled();
  });

  it("forgets crashes that fall outside the window", () => {
    const { contents, gone, settle, onGiveUp, state } = setup({ maxCrashes: 1 });
    gone();
    settle();
    state.clock = 5000;
    gone();
    settle();
    expect(contents.reload).toHaveBeenCalledTimes(2);
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it("gives up when reload itself throws", () => {
    const { contents, gone, settle, onGiveUp } = setup();
    contents.reload.mockImplementation(() => {
      throw new Error("boom");
    });
    gone();
    settle();
    expect(onGiveUp).toHaveBeenCalledTimes(1);
  });

  it("forces a restart only if the renderer stays unresponsive past the grace period", () => {
    const { emitter, contents } = setup();
    emitter.emit("unresponsive");
    vi.advanceTimersByTime(499);
    expect(contents.forcefullyCrashRenderer).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(contents.forcefullyCrashRenderer).toHaveBeenCalledTimes(1);
  });

  it("cancels the pending restart when the renderer recovers or is destroyed", () => {
    const recovered = setup();
    recovered.emitter.emit("unresponsive");
    recovered.emitter.emit("responsive");
    vi.advanceTimersByTime(1000);
    expect(recovered.contents.forcefullyCrashRenderer).not.toHaveBeenCalled();

    const destroyed = setup();
    destroyed.emitter.emit("unresponsive");
    destroyed.emitter.emit("destroyed");
    vi.advanceTimersByTime(1000);
    expect(destroyed.contents.forcefullyCrashRenderer).not.toHaveBeenCalled();
  });

  it("does not stack timers on repeated unresponsive events", () => {
    const { emitter, contents } = setup();
    emitter.emit("unresponsive");
    emitter.emit("unresponsive");
    vi.advanceTimersByTime(1000);
    expect(contents.forcefullyCrashRenderer).toHaveBeenCalledTimes(1);
  });
});
