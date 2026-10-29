import type { Size } from "../geometry";

export type CaptureEncodingMode = "preferred" | "software";

export interface CaptureEncodingSourceRequirement {
  readonly id: string;
  readonly version: string;
  readonly sha256: string;
}

/** Platform policies contain codec details only; crop, quality and IO stay shared. */
export interface CaptureEncodingProfile {
  readonly binaryName: "ffmpeg" | "ffmpeg.exe";
  readonly h264Encoder: string;
  readonly pixelFormat: "yuv420p" | "nv12";
  readonly requiredSources: readonly CaptureEncodingSourceRequirement[];
  readonly probeH264Arguments: () => string[];
  readonly h264Arguments: (bitrate: number, mode: CaptureEncodingMode) => string[];
  readonly validateMp4Geometry: (geometry: Size) => void;
  /** Only profiles with a bounded, known software fallback implement this. */
  readonly softwareRetry?: { accepts(error: unknown): boolean };
}

export function h264BitrateArguments(bitrate: number, pixelFormat: CaptureEncodingProfile["pixelFormat"]): string[] {
  return ["-b:v", String(bitrate), "-maxrate", String(bitrate * 2), "-bufsize", String(bitrate * 4), "-pix_fmt", pixelFormat];
}
