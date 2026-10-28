import type { RecordOutput } from "@shared/features/capture/contract";
import { CaptureRecordingError } from "../captureErrors";
import type { Size } from "../geometry";
import { linuxCaptureEncodingProfile } from "./linux";
import { macOSCaptureEncodingProfile } from "./macos";
import { windowsCaptureEncodingProfile } from "./windows";
import type { CaptureEncodingProfile } from "./types";

export type { CaptureEncodingProfile, CaptureEncodingMode } from "./types";

const profiles: ReadonlyMap<NodeJS.Platform, CaptureEncodingProfile> = new Map([
  ["darwin", macOSCaptureEncodingProfile],
  ["win32", windowsCaptureEncodingProfile],
  ["linux", linuxCaptureEncodingProfile],
]);

export function resolveCaptureEncodingProfile(platform: NodeJS.Platform): CaptureEncodingProfile | null {
  return profiles.get(platform) ?? null;
}

/** Validate final physical dimensions, after the shared even-pixel crop/pad calculation. */
export function validateCaptureEncodingGeometry(platform: NodeJS.Platform, output: RecordOutput, geometry: Size): void {
  if (output !== "mp4") return;
  const profile = resolveCaptureEncodingProfile(platform);
  if (!profile) throw new CaptureRecordingError("encoder-unavailable", `Recording on ${platform} is unavailable`);
  profile.validateMp4Geometry(geometry);
}
