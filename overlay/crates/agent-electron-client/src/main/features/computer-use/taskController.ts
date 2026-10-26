import { createHash, randomUUID } from "node:crypto";
import type { CuaRuntime, CuaStats, CuaStep } from "@shared/features/computer-use/contract";
import {
  CUA_ANY, CUA_EXEMPT, CUA_LIFECYCLE, CUA_OBSERVATIONS, CUA_READS,
  observationDigest, observedTargets, writeTarget, type CuaOutcome,
} from "./cuaOutcome";

/** Pauses that resuming must not reset: budgets and repeated policy violations. */
export const CUA_FINAL_REASONS = ["stepLimit", "timeLimit", "repeatedAction", "violationLimit"];
/** Limits `begin` can hit; each pauses the task and needs the user to look. */
export const CUA_PAUSING_LIMITS = ["stepLimit", "timeLimit", "noProgress"];
/** Model guidance quotes this number; keep them in one place. */
export const CUA_WRITES_PER_OBSERVATION = 3;
/** Gateway-level refusals that count towards the violation limit. */
export const CUA_VIOLATIONS = new Set(["scopeViolation", "toolNotAllowed", "profileAttachRequiresWindowScope"]);

export interface CuaPermit { epoch: number; sequence: number; owner: string; tool: string }
type Decision = { permit: CuaPermit; error?: never } | { error: string; permit?: never };

/** Single desktop ownership across MCP connections. Arguments live only while a call is in flight. */
export class CuaTaskController {
  private owner: string | null = null;
  private epoch = 0;
  private revision = 0;
  private enabled = false;
  private inFlight: (CuaPermit & { args: unknown; target: string }) | null = null;
  /** Writes still allowed per observed target before the model must look again. */
  private quota = new Map<string, number>();
  private digests = new Map<string, string>();
  private lastFingerprint = "";
  private lastDigest = "";
  private identical = 0;
  private stalled = 0;
  private violations = 0;
  private blockedOwners = new Set<string>();
  private listeners = new Set<(state: CuaRuntime) => void>();
  private state: CuaRuntime;

  constructor(private options: {
    now?: () => number; maxSteps?: number; maxTaskMs?: number;
    writesPerObservation?: number; maxStalled?: number; maxIdentical?: number; maxViolations?: number;
  } = {}) {
    this.state = this.empty();
  }
  private now() { return (this.options.now ?? Date.now)(); }
  private emptyStats(): CuaStats { return { steps: 0, refused: 0, uncertain: 0, pauses: 0, resumes: 0, violations: 0 }; }
  private empty(): CuaRuntime {
    return { revision: this.revision, phase: "idle", taskId: null, startedAt: null, updatedAt: this.now(), steps: [],
      stepCount: 0, reason: null, needsObservation: true, resultObserved: false, stats: this.emptyStats() };
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
  open(owner: string, taskId: string = randomUUID()): void {
    if (this.owner) return;
    this.owner = owner;
    this.epoch++;
    this.state = { ...this.empty(), taskId, startedAt: this.now(), phase: "running" };
    this.forgetObservations();
    this.violations = 0;
    this.emit();
  }
  valid(permit: CuaPermit): boolean {
    return permit.epoch === this.epoch && this.inFlight?.sequence === permit.sequence &&
      this.owner === permit.owner && this.state.phase === "running";
  }
  owns(owner: string) { return this.owner === owner; }
  hasPending(owner: string) { return this.owner === owner && this.inFlight !== null; }
  complete(owner: string) {
    if (this.owner !== owner || this.inFlight || this.state.phase !== "running") return;
    this.owner = null; this.state.phase = "completed"; this.emit();
  }
  private forgetObservations() {
    this.quota.clear();
    this.digests.clear();
    this.lastFingerprint = "";
    this.lastDigest = "";
    this.identical = 0;
    this.stalled = 0;
    this.state.needsObservation = true;
  }

  begin(owner: string, tool: string, args: unknown): Decision {
    if (!this.enabled) return { error: "unavailable" };
    if (this.blockedOwners.has(owner)) return { error: "taskStopped" };
    if (this.state.phase === "paused" || this.state.phase === "failed") return { error: this.state.reason ?? "paused" };
    if (this.owner && this.owner !== owner) return { error: "desktopBusy" };
    if (this.inFlight) return { error: "operationInProgress" };
    if (!this.owner) {
      this.open(owner);
    }
    if (this.state.stepCount >= (this.options.maxSteps ?? 100)) return this.limit("stepLimit");
    if (this.now() - this.state.startedAt! >= (this.options.maxTaskMs ?? 15 * 60_000)) return this.limit("timeLimit");
    const write = !CUA_READS.has(tool) && !CUA_LIFECYCLE.has(tool);
    const target = write ? writeTarget(tool, args) : "";
    if (write && target !== CUA_EXEMPT) {
      const key = this.quotaKey(target);
      if (!key) return this.reject("observationRequired");
      const progress = this.progress(tool, args, key);
      if (progress) return this.limit(progress);
      this.quota.set(key, this.quota.get(key)! - 1);
      this.state.resultObserved = false;
      this.state.needsObservation = this.quota.get(key)! <= 0;
    }
    const step: CuaStep = { sequence: ++this.state.stepCount, tool, startedAt: this.now(), outcome: "running" };
    this.state.steps = [...this.state.steps, step].slice(-100);
    this.state.stats.steps++;
    const permit: CuaPermit = { epoch: this.epoch, sequence: step.sequence, owner, tool };
    this.inFlight = { ...permit, args, target };
    this.emit();
    return { permit };
  }

  /** Which observation entitles this write, or null when the model must look first. */
  private quotaKey(target: string): string | null {
    const has = (key: string) => (this.quota.get(key) ?? 0) > 0;
    if (target === CUA_ANY) return has(CUA_ANY) ? CUA_ANY : null;
    if (has(target)) return target;
    // A full-desktop observation covers native windows and apps, not browser refs.
    if (!target.startsWith("b:") && has("desktop")) return "desktop";
    return null;
  }

  /** Same write again with nothing observed to have changed is the signal, not repetition itself. */
  private progress(tool: string, args: unknown, key: string): string | null {
    const fingerprint = createHash("sha256").update(JSON.stringify([tool, args])).digest("hex");
    const digest = this.digests.get(key) ?? "";
    if (fingerprint === this.lastFingerprint) {
      this.identical++;
      this.stalled = digest === this.lastDigest ? this.stalled + 1 : 0;
    } else {
      this.identical = 1;
      this.stalled = 0;
    }
    this.lastFingerprint = fingerprint;
    this.lastDigest = digest;
    if (this.stalled >= (this.options.maxStalled ?? 3) || this.identical > (this.options.maxIdentical ?? 12)) return "noProgress";
    return null;
  }

  private reject(error: string): Decision {
    this.state.stats.refused++;
    this.emit();
    return { error };
  }

  /** A call the gateway refused before it reached the helper; repeated violations end the task. */
  recordRejection(owner: string, reason: string) {
    if (this.owner !== owner || this.state.phase !== "running") return;
    this.state.stats.refused++;
    if (CUA_VIOLATIONS.has(reason)) {
      this.state.stats.violations++;
      if (++this.violations >= (this.options.maxViolations ?? 3)) { this.stop("violationLimit"); return; }
    }
    this.emit();
  }

  checkDeadline(): string | null {
    if (!this.owner || this.state.phase !== "running") return null;
    const reason = this.now() - this.state.startedAt! >= (this.options.maxTaskMs ?? 15 * 60_000) ? "timeLimit" :
      !this.inFlight && this.now() - this.state.updatedAt >= 5 * 60_000 ? "idleTimeout" : null;
    if (reason) this.pause(reason);
    return reason;
  }
  private limit(reason: string): Decision { this.pause(reason); return { error: reason }; }

  finish(permit: CuaPermit, outcome: CuaOutcome, structured?: unknown): boolean {
    const flight = this.inFlight;
    if (!flight || permit.epoch !== this.epoch || flight.sequence !== permit.sequence || permit.owner !== this.owner) return false;
    const step = this.state.steps.find((item) => item.sequence === permit.sequence)!;
    step.outcome = outcome === "ok" ? "ok" : outcome === "refused" ? "refused" : "error";
    step.durationMs = this.now() - step.startedAt;
    this.inFlight = null;
    if ((structured as { sensitive?: boolean } | null)?.sensitive === true) this.forgetObservations();
    if (outcome === "uncertain") {
      this.state.stats.uncertain++;
      this.state.stats.pauses++;
      this.state.phase = "paused";
      this.state.reason = "uncertainResult";
      this.forgetObservations();
    } else if (outcome === "refused") {
      this.state.stats.refused++;
    } else if (CUA_OBSERVATIONS.has(permit.tool)) {
      const targets = observedTargets(permit.tool, flight.args, structured) ?? [];
      const digest = observationDigest(structured);
      const allowance = this.options.writesPerObservation ?? CUA_WRITES_PER_OBSERVATION;
      for (const target of [...targets, CUA_ANY]) { this.quota.set(target, allowance); this.digests.set(target, digest); }
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
    if (this.state.phase !== "paused") this.state.stats.pauses++;
    this.state.phase = "paused";
    this.state.reason = reason;
    this.forgetObservations();
    this.emit();
  }
  resume(): boolean {
    if (!this.enabled || !this.owner || this.state.phase !== "paused") return false;
    // Budgets cannot be reset by repeatedly pressing resume.
    if (CUA_FINAL_REASONS.includes(this.state.reason ?? "")) return false;
    this.state.phase = "running";
    this.state.reason = null;
    this.state.stats.resumes++;
    this.forgetObservations();
    this.emit();
    return true;
  }
  stop(reason = "userStopped") {
    if (this.owner) this.blockedOwners.add(this.owner);
    this.cancelFlight();
    this.owner = null;
    this.state.phase = "stopped";
    this.state.reason = reason;
    this.forgetObservations();
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
    this.forgetObservations();
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
