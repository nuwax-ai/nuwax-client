import { createHash, randomUUID } from "node:crypto";
import type { CuaRuntime, CuaStep } from "@shared/types/cuaRuntime";

const OBSERVATIONS = new Set([
  "get_window_state", "get_desktop_state", "get_accessibility_tree", "get_browser_state", "zoom",
]);
const READS = new Set([
  ...OBSERVATIONS, "check_permissions", "get_agent_cursor_state", "get_config", "get_cursor_position",
  "get_recording_state", "get_screen_size", "get_session", "get_session_state", "health_report",
  "list_apps", "list_sessions", "list_windows", "debug_window_info", "verify_state",
]);
const LIFECYCLE = new Set(["start_session", "end_session"]);

export interface CuaPermit { epoch: number; sequence: number; owner: string; tool: string }
type Decision = { permit: CuaPermit; error?: never } | { error: string; permit?: never };

/** Single desktop ownership across MCP connections. Never stores tool arguments. */
export class CuaTaskController {
  private owner: string | null = null;
  private epoch = 0;
  private revision = 0;
  private enabled = false;
  private inFlight: CuaPermit | null = null;
  private lastFingerprint = "";
  private repetitions = 0;
  private blockedOwners = new Set<string>();
  private listeners = new Set<(state: CuaRuntime) => void>();
  private state: CuaRuntime;

  constructor(private options: {
    now?: () => number; maxSteps?: number; maxTaskMs?: number; maxRepeated?: number;
  } = {}) {
    this.state = this.empty();
  }
  private now() { return (this.options.now ?? Date.now)(); }
  private empty(): CuaRuntime {
    return { revision: this.revision, phase: "idle", taskId: null, startedAt: null, updatedAt: this.now(), steps: [],
      stepCount: 0, reason: null, needsObservation: true, resultObserved: false };
  }
  snapshot(): CuaRuntime { return structuredClone(this.state); }
  subscribe(listener: (state: CuaRuntime) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  notify() { this.emit(); }
  private emit() {
    this.state.revision = ++this.revision;
    this.state.updatedAt = this.now();
    for (const listener of this.listeners) {
      try { listener(this.snapshot()); } catch { /* A closed UI must never interrupt capability revocation. */ }
    }
  }
  setAvailable(available: boolean) { this.enabled = available; }
  owns(owner: string) { return this.owner === owner; }
  hasPending(owner: string) { return this.owner === owner && this.inFlight !== null; }
  complete(owner: string) {
    if (this.owner !== owner || this.inFlight || this.state.phase !== "running") return;
    this.owner = null; this.state.phase = "completed"; this.emit();
  }

  begin(owner: string, tool: string, args: unknown): Decision {
    if (!this.enabled) return { error: "unavailable" };
    if (this.blockedOwners.has(owner)) return { error: "taskStopped" };
    if (this.state.phase === "paused" || this.state.phase === "failed") return { error: this.state.reason ?? "paused" };
    if (this.owner && this.owner !== owner) return { error: "desktopBusy" };
    if (this.inFlight) return { error: "operationInProgress" };
    if (!this.owner) {
      this.owner = owner;
      this.epoch++;
      this.state = { ...this.empty(), taskId: randomUUID(), startedAt: this.now(), phase: "running" };
      this.lastFingerprint = "";
      this.repetitions = 0;
      this.emit();
    }
    if (this.state.stepCount >= (this.options.maxSteps ?? 100)) return this.limit("stepLimit");
    if (this.now() - this.state.startedAt! >= (this.options.maxTaskMs ?? 15 * 60_000)) return this.limit("timeLimit");
    const write = !READS.has(tool) && !LIFECYCLE.has(tool);
    if (write && this.state.needsObservation) return { error: "observationRequired" };
    if (write) {
      const fingerprint = createHash("sha256").update(JSON.stringify([tool, args])).digest("hex");
      this.repetitions = fingerprint === this.lastFingerprint ? this.repetitions + 1 : 1;
      this.lastFingerprint = fingerprint;
      if (this.repetitions > (this.options.maxRepeated ?? 3)) return this.limit("repeatedAction");
      this.state.resultObserved = false;
      this.state.needsObservation = true;
    }
    const step: CuaStep = { sequence: ++this.state.stepCount, tool, startedAt: this.now(), outcome: "running" };
    this.state.steps = [...this.state.steps, step].slice(-100);
    this.inFlight = { epoch: this.epoch, sequence: step.sequence, owner, tool };
    this.emit();
    return { permit: { ...this.inFlight } };
  }
  checkDeadline(): string | null {
    if (!this.owner || this.state.phase !== "running") return null;
    const reason = this.now() - this.state.startedAt! >= (this.options.maxTaskMs ?? 15 * 60_000) ? "timeLimit" :
      !this.inFlight && this.now() - this.state.updatedAt >= 5 * 60_000 ? "idleTimeout" : null;
    if (reason) this.pause(reason);
    return reason;
  }
  private limit(reason: string): Decision { this.pause(reason); return { error: reason }; }

  finish(permit: CuaPermit, success: boolean): boolean {
    if (permit.epoch !== this.epoch || this.inFlight?.sequence !== permit.sequence || permit.owner !== this.owner) return false;
    const step = this.state.steps.find((item) => item.sequence === permit.sequence)!;
    step.outcome = success ? "ok" : "error";
    step.durationMs = this.now() - step.startedAt;
    this.inFlight = null;
    if (!success) {
      this.state.phase = "paused";
      this.state.reason = "toolFailed";
      this.state.needsObservation = true;
    } else if (OBSERVATIONS.has(permit.tool)) {
      this.state.needsObservation = false;
      this.state.resultObserved = true;
    } else if (permit.tool === "end_session") {
      this.state.phase = "completed";
      this.owner = null;
    }
    this.emit();
    return true;
  }
  pause(reason = "userPaused") {
    if (!this.owner) return;
    this.cancelFlight();
    this.state.phase = "paused";
    this.state.reason = reason;
    this.state.needsObservation = true;
    this.emit();
  }
  resume(): boolean {
    if (!this.enabled || !this.owner || this.state.phase !== "paused") return false;
    // Budgets cannot be reset by repeatedly pressing resume.
    if (["stepLimit", "timeLimit", "repeatedAction"].includes(this.state.reason ?? "")) return false;
    this.state.phase = "running";
    this.state.reason = null;
    this.state.needsObservation = true;
    this.emit();
    return true;
  }
  stop(reason = "userStopped") {
    if (this.owner) this.blockedOwners.add(this.owner);
    this.cancelFlight();
    this.owner = null;
    this.state.phase = "stopped";
    this.state.reason = reason;
    this.state.needsObservation = true;
    this.emit();
  }
  fail(reason: string) {
    this.stop(reason);
    this.state.phase = "failed";
    this.emit();
  }
  reset() {
    this.cancelFlight();
    this.owner = null;
    this.state = this.empty();
    this.emit();
  }
  retire(owner: string) { this.blockedOwners.delete(owner); }
  disconnect(owner: string, forget = true) {
    if (this.owner === owner) this.stop("connectionClosed");
    if (forget) this.retire(owner);
  }
  clearHistory() {
    if (this.owner) return false;
    this.state = this.empty();
    this.emit();
    return true;
  }
  private cancelFlight() {
    this.epoch++;
    if (this.inFlight) {
      const step = this.state.steps.find((item) => item.sequence === this.inFlight!.sequence);
      if (step) { step.outcome = "cancelled"; step.durationMs = this.now() - step.startedAt; }
    }
    this.inFlight = null;
  }
}
