import { CaptureRecordingError } from "../captureErrors";
import { h264BitrateArguments, type CaptureEncodingProfile } from "./types";

export const linuxCaptureEncodingProfile: CaptureEncodingProfile = {
  binaryName: "ffmpeg",
  h264Encoder: "libopenh264",
  pixelFormat: "yuv420p",
  requiredSources: [{
    id: "openh264",
    version: "2.6.0",
    sha256: "7a060916a9fcb63ba51d83a4f2388660c0b58797be547c4fa5c52e8d65660a85",
  }],
  probeH264Arguments: () => ["-c:v", "libopenh264", "-b:v", "128000", "-rc_mode", "bitrate", "-pix_fmt", "yuv420p"],
  h264Arguments: bitrate => ["-c:v", "libopenh264", "-rc_mode", "bitrate", ...h264BitrateArguments(bitrate, "yuv420p")],
  validateMp4Geometry: ({ width, height }) => {
    if (width < 16 || height < 16) {
      throw new CaptureRecordingError("failed", "The selected area is too small for MP4 recording. Choose an area of at least 16 × 16 physical pixels.");
    }
  },
};
