import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { revealWhenReady } from "./revealWhenReady";

class FakeWindow extends EventEmitter {
  readonly webContents = new EventEmitter();
  private destroyed = false;
  isDestroyed() { return this.destroyed; }
  close() { this.destroyed = true; this.emit("closed"); }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("revealWhenReady", () => {
  it("shows the window once on ready-to-show and ignores the later fallbacks", () => {
    const win = new FakeWindow();
    const reveal = vi.fn();
    const onFallback = vi.fn();
    revealWhenReady(win, reveal, { onFallback });
    win.emit("ready-to-show");
    win.webContents.emit("did-finish-load");
    vi.advanceTimersByTime(5000);
    expect(reveal).toHaveBeenCalledOnce();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("shows the window after the page loaded when ready-to-show never comes (Wayland)", () => {
    const win = new FakeWindow();
    const reveal = vi.fn();
    const onFallback = vi.fn();
    revealWhenReady(win, reveal, { onFallback });
    win.webContents.emit("did-finish-load");
    vi.advanceTimersByTime(149);
    expect(reveal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reveal).toHaveBeenCalledOnce();
    expect(onFallback).toHaveBeenCalledWith("did-finish-load");
    win.emit("ready-to-show");
    vi.advanceTimersByTime(5000);
    expect(reveal).toHaveBeenCalledOnce();
  });

  it("keeps the first-paint path when ready-to-show arrives within the grace period", () => {
    const win = new FakeWindow();
    const reveal = vi.fn();
    const onFallback = vi.fn();
    revealWhenReady(win, reveal, { onFallback });
    win.webContents.emit("did-finish-load");
    vi.advanceTimersByTime(100);
    win.emit("ready-to-show");
    vi.advanceTimersByTime(5000);
    expect(reveal).toHaveBeenCalledOnce();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("shows the window at the hard deadline when neither event arrives", () => {
    const win = new FakeWindow();
    const reveal = vi.fn();
    const onFallback = vi.fn();
    revealWhenReady(win, reveal, { onFallback, timeoutMs: 3000 });
    vi.advanceTimersByTime(2999);
    expect(reveal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reveal).toHaveBeenCalledOnce();
    expect(onFallback).toHaveBeenCalledWith("timeout");
  });

  it("starts the grace period immediately when the page is already loaded", () => {
    const win = new FakeWindow();
    const reveal = vi.fn();
    const onFallback = vi.fn();
    revealWhenReady(win, reveal, { onFallback, pageLoaded: true, loadGraceMs: 150 });
    vi.advanceTimersByTime(149);
    expect(reveal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reveal).toHaveBeenCalledOnce();
    expect(onFallback).toHaveBeenCalledWith("did-finish-load");
    expect(win.webContents.listenerCount("did-finish-load")).toBe(0);
  });

  it("does nothing after the window was closed", () => {
    const win = new FakeWindow();
    const reveal = vi.fn();
    revealWhenReady(win, reveal, { timeoutMs: 3000 });
    vi.advanceTimersByTime(500);
    win.close();
    vi.advanceTimersByTime(5000);
    expect(reveal).not.toHaveBeenCalled();
    expect(win.listenerCount("closed")).toBe(0);
    expect(win.webContents.listenerCount("did-finish-load")).toBe(0);
  });
});
