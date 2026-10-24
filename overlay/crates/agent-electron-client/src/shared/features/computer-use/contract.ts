export interface CuaPreviewFrame {
  taskId: string; bindingId: string; epoch: number; sequence: number; capturedAt: number;
  width: number; height: number; jpeg: string;
}
export interface CuaPreviewUpdate {
  taskId: string | null;
  status: "loading" | "ready" | "unavailable" | "minimized" | "permissionsRequired" | "helperUpgradeRequired" | "ended";
  frame?: CuaPreviewFrame;
}
export type CuaPhase = "idle" | "running" | "paused" | "stopped" | "failed" | "completed";
export type CuaScope = { kind: "desktop" } | { kind: "window"; pid: number; windowId: number; label: string };
export type CuaWindow = { pid: number; windowId: number; label: string };
export type CuaExecutionMode = "background" | "foreground";
export interface CuaTaskRuntime extends Omit<CuaRuntime, "tasks" | "multiwindow"> {
  taskId: string;
  bindingId: string;
  epoch: number;
  mode: CuaExecutionMode;
  color: string;
  queued: boolean;
}

/** Deliberately excludes arguments, screenshots, window titles and user content. */
export interface CuaStep {
  sequence: number;
  tool: string;
  startedAt: number;
  durationMs?: number;
  outcome: "running" | "ok" | "refused" | "error" | "cancelled";
}

/** Counts only; never arguments or content. */
export interface CuaStats {
  steps: number;
  /** Calls refused before taking effect, by the gateway or the helper. */
  refused: number;
  uncertain: number;
  pauses: number;
  resumes: number;
  violations: number;
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
  stats: CuaStats;
  shortcutAvailable?: boolean;
  controlPending?: boolean;
  scope?: CuaScope;
  /** Present only for the capability-negotiated multi-window executor. */
  multiwindow?: boolean;
  recoverable?: boolean;
  tasks?: CuaTaskRuntime[];
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

/** 宿主壳设置/状态接口（electronAPI.computerUse）；实现在 preload/features/computer-use。 */
export interface ComputerUseStatus {
  supported: boolean;
  installed: boolean;
  /** 随包 Resources 有 helper 但未安装（首用安装流输入）。 */
  installable?: boolean;
  running: boolean;
  enabled: boolean;
  /** 一次性确认已接受，待系统授权后可在设置页继续。 */
  consentPending?: boolean;
  /** `cua` MCP 条目已写入 mcp_local_config（功能闭环就绪标志）。 */
  mcpInjected?: boolean;
  /** 模拟光标 overlay；缺省开。与 Background 投递独立。 */
  agentCursor?: boolean;
  authMode?: "ask" | "unrestricted";
  blacklist?: string[];
  screenshotHome?: string;
  socketPath?: string;
  helperPath?: string | null;
  accessibility?: boolean | null;
  screenRecording?: boolean | null;
  error?: string | null;
}

/** User-visible local task summaries; deliberately not a replay or a native authorization. */
export interface CuaTaskHistory {
  taskId: string; label: string; phase: CuaPhase; startedAt: number; endedAt: number; stepCount: number;
  scopeKind?: CuaScope["kind"];
  mode?: CuaExecutionMode;
}

export interface ComputerUseAPI {
  getTaskHistory: () => Promise<CuaTaskHistory[]>;
  clearTaskHistory: () => Promise<{ success: boolean }>;

  showTaskPreview: (taskId: string) => Promise<{ success: boolean; error?: string }>;
  takeOver: () => Promise<CuaControlResult>;
  takeOverTask: (taskId: string) => Promise<CuaControlResult>;
  getTasks: () => Promise<CuaTaskRuntime[]>;
  bindTarget: (taskId: string, target: Pick<CuaWindow, "pid" | "windowId">) => Promise<CuaControlResult>;
  pauseTask: (taskId: string) => Promise<CuaControlResult>;
  resumeTask: (taskId: string) => Promise<CuaControlResult>;
  stopTask: (taskId: string) => Promise<CuaControlResult>;
  setTaskMode: (taskId: string, mode: CuaExecutionMode) => Promise<CuaControlResult>;
  stopAll: () => Promise<CuaControlResult>;
  setMultiwindowEnabled: (enabled: boolean) => Promise<CuaControlResult>;
  getRuntime: () => Promise<CuaRuntime>;
  pause: () => Promise<CuaControlResult>;
  resume: () => Promise<CuaControlResult>;
  stop: () => Promise<CuaControlResult>;
  recover: () => Promise<CuaControlResult>;
  selfTest: () => Promise<{ success: boolean; checks?: CuaCheck[]; error?: string }>;
  exportDiagnostics: () => Promise<{ success: boolean; cancelled?: boolean }>;
  clearHistory: () => Promise<{ success: boolean }>;
  listWindows: () => Promise<{ success: boolean; windows?: CuaWindow[]; error?: string }>;
  setScope: (scope: { kind: "desktop" } | { kind: "window"; pid: number; windowId: number }) => Promise<CuaControlResult>;
  getStatus: () => Promise<ComputerUseStatus>;
  setEnabled: (
    enabled: boolean,
  ) => Promise<{
    success: boolean;
    error?: string;
    status?: ComputerUseStatus;
  }>;
  setAgentCursor: (enabled: boolean) => Promise<{
    success: boolean;
    error?: string;
    status?: ComputerUseStatus;
  }>;
  setAuthMode: (mode: "ask" | "unrestricted") => Promise<{
    success: boolean;
    error?: string;
    status?: ComputerUseStatus;
  }>;
  setBlacklist: (apps: string[]) => Promise<{
    success: boolean;
    error?: string;
    status?: ComputerUseStatus;
  }>;
  listInstalledApps: () => Promise<{ id: string; label: string }[]>;
  listScreenshots: () => Promise<string[]>;
  confirmSensitive: (allow: boolean) => Promise<{ success: boolean }>;
  requestPermissions: () => Promise<{
    success: boolean;
    error?: string;
    accessibility?: boolean | null;
    screenRecording?: boolean | null;
  }>;
  installHelper: () => Promise<{
    success: boolean;
    error?: string;
    installedPath?: string | null;
  }>;
  getVlmConfig: () => Promise<{
    baseUrl: string;
    model: string;
    apiKey: string;
    hasApiKey?: boolean;
  }>;
  setVlmConfig: (patch: {
    clearApiKey?: boolean;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  }) => Promise<{ success: boolean; error?: string }>;
  testVlm: () => Promise<{
    success: boolean;
    error?: string;
    latencyMs?: number;
  }>;
}
