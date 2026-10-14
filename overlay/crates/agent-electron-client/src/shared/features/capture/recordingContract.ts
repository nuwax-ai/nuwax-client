/** Private capture-window protocol. Never expose this bridge to business pages. */
export const RECORDING_IPC = {
  CONFIG: "capture:recording:config",
  EVENT: "capture:recording:event",
  CHUNK: "capture:recording:chunk",
  SNAPSHOT: "capture:recording:snapshot",
  COMMAND: "capture:recording:command",
} as const;

export const RECORDING_CHUNK_LIMIT = 8 * 1024 * 1024;
export const RECORDING_SNAPSHOT_LIMIT = 96 * 1024 * 1024;
export { DEFAULT_RECORDING_DURATION_MS } from './recordingPreferences';

export interface RecordingConfig {
  sourceId: string;
  sourceKind: "screen" | "window";
  sourceSize: { width: number; height: number };
  fps: number;
  mode: "record" | "snapshot";
  acquisition?: 'portal';
  /** Keep the granted stream after its first frame; the recording command reuses it. */
  preview?: boolean;
  /** Repeat decoded native pixels at the requested rate for damage-driven sources. */
  framePipeline?: 'source' | 'guarded-source' | 'repeat-last-frame';
  /** Minimum refresh requested only after the user has authorized the source. */
  sourceFrameRateFloor?: number;
}

export type RecordingCommand = "arm" | "start" | "pause" | "resume" | "stop" | "cancel";
export type RecordingEvent =
  | { type: "ready"; width: number; height: number; mime: string }
  | { type: "armed" | "started" | "paused" | "resumed" | "stopped" }
  | { type: "error"; message: string; permissionDenied?: boolean; canceled?: boolean };

export interface RecordingWindowBridge {
  config(): Promise<RecordingConfig>;
  event(event: RecordingEvent): Promise<void>;
  chunk(sequence: number, data: ArrayBuffer): Promise<void>;
  snapshot(data: ArrayBuffer, width: number, height: number): Promise<void>;
  onCommand(listener: (command: RecordingCommand) => void): () => void;
}
