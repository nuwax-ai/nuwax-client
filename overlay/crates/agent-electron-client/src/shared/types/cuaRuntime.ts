export type CuaPhase = "idle" | "running" | "paused" | "stopped" | "failed" | "completed";
export type CuaScope = { kind: "desktop" } | { kind: "window"; pid: number; windowId: number; label: string };
export type CuaWindow = { pid: number; windowId: number; label: string };

/** Deliberately excludes arguments, screenshots, window titles and user content. */
export interface CuaStep {
  sequence: number;
  tool: string;
  startedAt: number;
  durationMs?: number;
  outcome: "running" | "ok" | "error" | "cancelled";
}

export interface CuaRuntime {
  revision: number;
  phase: CuaPhase;
  taskId: string | null;
  startedAt: number | null;
  updatedAt: number;
  steps: CuaStep[];
  stepCount: number;
  reason: string | null;
  needsObservation: boolean;
  /** An observation is evidence of a refreshed screen, not proof of business success. */
  resultObserved: boolean;
  shortcutAvailable?: boolean;
  controlPending?: boolean;
  scope?: CuaScope;
}

export interface CuaCheck {
  name: "helper" | "permissions" | "driver" | "policy" | "gateway" | "model";
  status: "passed" | "failed" | "manual";
  reason?: string;
}

export interface CuaControlResult {
  success: boolean;
  error?: string;
  runtime: CuaRuntime;
}
