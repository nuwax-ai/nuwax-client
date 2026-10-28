import { h264BitrateArguments, type CaptureEncodingProfile } from "./types";

export const macOSCaptureEncodingProfile: CaptureEncodingProfile = {
  binaryName: "ffmpeg",
  h264Encoder: "h264_videotoolbox",
  pixelFormat: "yuv420p",
  requiredSources: [],
  probeH264Arguments: () => ["-c:v", "h264_videotoolbox", "-allow_sw", "0", "-pix_fmt", "yuv420p"],
  h264Arguments: bitrate => ["-c:v", "h264_videotoolbox", "-allow_sw", "0", ...h264BitrateArguments(bitrate, "yuv420p")],
  validateMp4Geometry: () => {},
};
