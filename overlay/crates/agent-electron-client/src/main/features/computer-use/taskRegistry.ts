import { randomUUID } from "node:crypto";
import type { CuaExecutionMode, CuaRuntime, CuaScope, CuaTaskRuntime, CuaWindow } from "@shared/features/computer-use/contract";
import { CuaTaskController, CUA_FINAL_REASONS, type CuaPermit } from "./taskController";
import type { CuaOutcome } from "./cuaOutcome";

type Task = {
  id: string; bindingId: string; owner: string; controller: CuaTaskController; epoch: number;
  target?: CuaWindow; mode: CuaExecutionMode; color: string; queued: boolean; pending: boolean;
};
const COLORS = ["#4f8cff", "#ba68e8", "#00a896", "#ef8f38"];
const TERMINAL = new Set(["stopped", "failed", "completed"]);

/** Task identities come exclusively from host grants. No model-provided session labels are trusted. */
export class CuaTaskRegistry {
  private tasks = new Map<string, Task>();
  private listeners = new Set<(state: CuaRuntime) => void>();
  private enabled = false;
  private revision = 0;
  private foreground: string | null = null;
  private locks = new Map<number, { owner: string; release: () => void }>();
  private waiters: Array<{ task: Task; resolve: (release: () => void) => void; reject: (error: Error) => void }> = [];
  private deadlineHandler?: (id: string, reason: string) => void;

  constructor(private maxActive = 4) {}
  onDeadline(handler: (id: string, reason: string) => void) { this.deadlineHandler = handler; }
  /** Keep the ACP tool call alive while the human chooses a target or holds control. */
  waitReady(owner: string, signal: AbortSignal): Promise<void> {
    const task = this.ensure(owner);
    return new Promise((resolve, reject) => {
      let done = false;
      let off = () => {};
      const finish = (error?: Error) => {
        if (done) return; done = true; clearTimeout(timer); off(); signal.removeEventListener("abort", aborted);
        if (error) reject(error); else resolve();
      };
      const aborted = () => finish(new Error("operationCancelled"));
      const check = () => {
        const state = task.controller.snapshot();
        if (!this.enabled || TERMINAL.has(state.phase) || CUA_FINAL_REASONS.includes(state.reason ?? "")) finish(new Error("taskStopped"));
        else if (state.phase === "running" && task.target && !task.pending && !task.queued) finish();
      };
      const remaining = 15 * 60_000 - (Date.now() - (task.controller.snapshot().startedAt ?? Date.now()));
      const timer = setTimeout(() => { this.pauseTask(task.id, "timeLimit"); finish(new Error("timeLimit")); }, Math.max(1, remaining));
      timer.unref();
      off = this.subscribe(check);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted(); else check();
    });
  }
  subscribe(listener: (state: CuaRuntime) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  notify() {
    this.revision++;
    for (const listener of this.listeners) { try { listener(this.snapshot()); } catch { /* UI cannot delay revocation. */ } }
  }
  private view(task: Task): CuaTaskRuntime {
    return { ...task.controller.snapshot(), taskId: task.id, bindingId: task.bindingId, epoch: task.epoch, mode: task.mode, color: task.color,
      queued: task.queued, controlPending: task.pending,
      scope: task.target ? { kind: "window", ...task.target } : { kind: "window", pid: 0, windowId: 0, label: "" } };
  }
  list(): CuaTaskRuntime[] { return [...this.tasks.values()].map((task) => this.view(task)); }
  snapshot(): CuaRuntime {
    const tasks = this.list();
    const focus = tasks.find((task) => task.phase === "running") ?? tasks.find((task) => task.phase === "paused") ?? tasks.at(-1);
    return { ...(focus ?? new CuaTaskController().snapshot()), revision: this.revision, multiwindow: true, tasks };
  }
  private forOwner(owner: string) { return [...this.tasks.values()].find((task) => task.owner === owner); }
  byId(id: string) { return this.tasks.get(id); }
  stateForOwner(owner: string) { const task = this.forOwner(owner); return task ? this.view(task) : undefined; }
  setColor(id: string, color: unknown) {
    const task = this.tasks.get(id);
    if (task && typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color) && task.color !== color) {
      task.color = color; this.notify();
    }
  }
  releaseDrained(owner: string) {
    for (const lock of this.locks.values()) if (lock.owner === owner) lock.release();
  }
  scopeFor(owner: string): CuaScope { const task = this.forOwner(owner); return task?.target
    ? { kind: "window", ...task.target } : { kind: "window", pid: 0, windowId: 0, label: "" }; }
  ensure(owner: string): Task {
    const existing = this.forOwner(owner);
    if (existing) return existing;
    // Keep bounded terminal history without ever evicting a live authorization.
    if (this.tasks.size >= 32) {
      const old = [...this.tasks.values()].find((task) => TERMINAL.has(task.controller.snapshot().phase) && !task.pending);
      if (!old) throw new Error("taskCapacity");
      this.tasks.delete(old.id);
    }
    const controller = new CuaTaskController({ writesPerObservation: 1 });
    controller.setAvailable(this.enabled);
    const task: Task = { id: randomUUID(), bindingId: randomUUID(), owner, controller, epoch: 1, mode: "background",
      color: COLORS[this.tasks.size % COLORS.length], queued: false, pending: false };
    this.tasks.set(task.id, task);
    controller.open(owner, task.id);
    controller.pause("targetRequired");
    controller.subscribe(() => this.notify());
    this.notify();
    return task;
  }
  setAvailable(available: boolean) {
    this.enabled = available;
    for (const task of this.tasks.values()) task.controller.setAvailable(available);
  }
  bind(id: string, target: CuaWindow) {
    const task = this.tasks.get(id);
    if (!task || task.pending || TERMINAL.has(task.controller.snapshot().phase)) throw new Error("taskUnavailable");
    if ([...this.tasks.values()].some((other) => other !== task && other.target?.pid === target.pid &&
        other.target.windowId === target.windowId && (!TERMINAL.has(other.controller.snapshot().phase) || other.pending))) throw new Error("windowBusy");
    task.target = structuredClone(target);
    task.bindingId = randomUUID();
    if (this.foreground === id) this.foreground = null;
    task.epoch++;
    task.mode = "background";
    task.controller.pause("userPaused");
    this.notify();
  }
  nativeContext(owner: string) {
    const task = this.forOwner(owner);
    if (!task?.target) throw new Error("targetRequired");
    return { task_id: task.id, binding_id: task.bindingId, host_pid: process.pid,
      epoch: task.epoch, pid: task.target.pid, window_id: task.target.windowId, mode: task.mode };
  }
  owns(owner: string) { return !!this.forOwner(owner); }
  hasPending(owner: string) { return this.forOwner(owner)?.controller.hasPending(owner) ?? false; }
  begin(owner: string, tool: string, args: unknown) {
    const task = this.ensure(owner);
    if (!task.target) return { error: "targetRequired" };
    if (task.pending || task.queued) return { error: task.queued ? "taskQueued" : "handoffPending" };
    if (this.foreground && this.foreground !== task.id) return { error: "desktopBusy" };
    return task.controller.begin(owner, tool, args);
  }
  valid(permit: CuaPermit) { return this.forOwner(permit.owner)?.controller.valid(permit) === true; }
  finish(permit: CuaPermit, outcome: CuaOutcome, structured?: unknown) {
    const task = this.forOwner(permit.owner);
    if (!task?.controller.finish(permit, outcome, structured)) return false;
    const code = (structured as { code?: unknown } | null)?.code;
    if (["background_unavailable", "same_pid_keyboard_ambiguity", "foreground_required"].includes(String(code))) this.pauseTask(task.id, "foregroundRequired");
    if (code === "user_in_control") this.pauseTask(task.id, "userTakingControl");
    if (["target_identity_changed", "task_not_bound", "stale_task_epoch"].includes(String(code))) this.pauseTask(task.id, "targetClosed");
    return true;
  }
  recordRejection(owner: string, reason: string) { this.ensure(owner).controller.recordRejection(owner, reason); }
  pauseTask(id: string, reason = "userPaused") {
    const task = this.tasks.get(id);
    if (!task || TERMINAL.has(task.controller.snapshot().phase)) return false;
    task.epoch++;
    task.queued = false;
    task.controller.pause(reason);
    this.rejectWaiters(task);
    this.promote();
    return true;
  }
  pause(reason = "userPaused") { for (const task of this.tasks.values()) this.pauseTask(task.id, reason); }
  resumeTask(id: string) {
    const task = this.tasks.get(id);
    if (!task?.target || task.pending || (this.foreground && this.foreground !== id)) return false;
    if (task.controller.snapshot().phase !== "paused" || CUA_FINAL_REASONS.includes(task.controller.snapshot().reason ?? "")) return false;
    if ([...this.tasks.values()].filter((other) => other !== task && other.controller.snapshot().phase === "running").length >= this.maxActive) {
      task.queued = true; this.notify(); return true;
    }
    task.epoch++;
    task.queued = false;
    return task.controller.resume();
  }
  resume() { const live = this.list().filter((task) => !TERMINAL.has(task.phase)); return live.length === 1 && this.resumeTask(live[0].taskId); }
  stopTask(id: string, reason = "userStopped") {
    const task = this.tasks.get(id);
    if (!task) return false;
    task.epoch++;
    task.queued = false;
    task.controller.stop(reason);
    this.rejectWaiters(task);
    if (this.foreground === id) this.foreground = null;
    this.promote();
    return true;
  }
  stop(reason = "userStopped") { for (const task of this.tasks.values()) this.stopTask(task.id, reason); }
  fail(reason: string) { for (const task of this.tasks.values()) { this.stopTask(task.id, reason); task.controller.fail(reason); } }
  complete(owner: string) { const task = this.forOwner(owner); if (task) { task.controller.complete(owner); this.promote(); } }
  retire(owner: string) { this.forOwner(owner)?.controller.retire(owner); }
  disconnect(owner: string, _forget = true) { const task = this.forOwner(owner); if (task) this.stopTask(task.id, "connectionClosed"); }
  checkDeadline(): string | null {
    for (const task of this.tasks.values()) {
      const reason = task.controller.checkDeadline();
      if (reason) { this.pauseTask(task.id, reason); this.deadlineHandler?.(task.id, reason); }
    }
    return null;
  }
  clearHistory() {
    for (const [id, task] of this.tasks) if (TERMINAL.has(task.controller.snapshot().phase) && !task.pending) this.tasks.delete(id);
    this.notify(); return true;
  }
  reset() { this.stop("reset"); this.clearHistory(); }
  pending(id: string, value: boolean) { const task = this.tasks.get(id); if (task) { task.pending = value; this.notify(); if (!value) this.promote(); } }
  setMode(id: string, mode: CuaExecutionMode) {
    const task = this.tasks.get(id);
    if (!task || task.pending || task.controller.snapshot().phase !== "paused") throw new Error("cannotResume");
    if (mode === "foreground") {
      if (this.foreground && this.foreground !== id) throw new Error("desktopBusy");
      if ([...this.tasks.values()].some((other) => other !== task && (other.pending || other.controller.hasPending(other.owner)))) throw new Error("handoffPending");
      this.foreground = id;
    } else if (this.foreground === id) this.foreground = null;
    task.mode = mode; task.epoch++; this.notify();
  }
  private promote() {
    if (!this.enabled || this.foreground || [...this.tasks.values()].some((task) => task.mode === "foreground" && task.pending)) return;
    for (const task of this.tasks.values()) if (task.queued) {
      if ([...this.tasks.values()].filter((other) => other.controller.snapshot().phase === "running").length >= this.maxActive) break;
      task.queued = false; task.epoch++; task.controller.resume();
    }
    this.notify();
  }
  private rejectWaiters(task: Task) {
    this.waiters = this.waiters.filter((waiter) => {
      if (waiter.task !== task) return true;
      waiter.reject(new Error("operationCancelled")); return false;
    });
  }
  /** The lease spans native dispatch AND readback. Revocation never releases an in-flight lease early. */
  acquire(owner: string): Promise<() => void> {
    const task = this.forOwner(owner);
    if (!task?.target || task.controller.snapshot().phase !== "running") return Promise.reject(new Error("operationCancelled"));
    return new Promise((resolve, reject) => { this.waiters.push({ task, resolve, reject }); this.pump(); });
  }
  private pump() {
    for (const waiter of [...this.waiters]) {
      const pid = waiter.task.target!.pid;
      if (this.locks.has(pid)) continue;
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      let released = false;
      const release = () => { if (released) return; released = true; this.locks.delete(pid); this.pump(); };
      this.locks.set(pid, { owner: waiter.task.owner, release });
      waiter.resolve(release);
    }
  }
}
