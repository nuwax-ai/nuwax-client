import { CaptureRecordingError } from "../captureErrors";
import { h264BitrateArguments, type CaptureEncodingProfile } from "./types";

export const windowsCaptureEncodingProfile: CaptureEncodingProfile = {
  binaryName: "ffmpeg.exe",
  h264Encoder: "h264_mf",
  // MediaFoundation hardware transforms commonly require NV12 for system-memory input.
  pixelFormat: "nv12",
  requiredSources: [],
  probeH264Arguments: () => ["-c:v", "h264_mf", "-hw_encoding", "1", "-pix_fmt", "nv12"],
  h264Arguments: (bitrate, mode) => ["-c:v", "h264_mf", "-hw_encoding", mode === "software" ? "0" : "1", ...h264BitrateArguments(bitrate, "nv12")],
  validateMp4Geometry: () => {},
  softwareRetry: {
    accepts: error => error instanceof CaptureRecordingError && error.code === "failed" &&
      /\[h264_mf\b[^\]\r\n]*\][^\r\n]*\bMF_E_INVALIDMEDIATYPE\b/.test(error.message),
  },
};
