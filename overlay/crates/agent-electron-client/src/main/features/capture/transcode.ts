import { spawn } from "node:child_process";
import { chmod, stat, unlink, writeFile } from "node:fs/promises";
import type { CaptureQuality, RecordOptions, RecordOutput } from "@shared/features/capture/contract";
import { toEvenSize, type Rect, type Size } from "./geometry";
import { fitToMaxBytes, getTierParams } from "./tiers";
import { CaptureRecordingError } from "./captureErrors";
import { resolveCaptureEncodingProfile, validateCaptureEncodingGeometry, type CaptureEncodingMode } from "./encoding";

export { CaptureRecordingError } from "./captureErrors";
export { resolveCaptureEncodingProfile, validateCaptureEncodingGeometry } from "./encoding";

export interface CaptureFfmpegResource {
  path: string;
  version: string;
  configuration: string;
  encoders: string[];
  filters: string[];
  formats: { mp4: boolean; webm: boolean; gif: boolean };
}

export function recordingFormats(resource: CaptureFfmpegResource | null, platform: NodeJS.Platform) {
  const video: Array<"mp4" | "webm"> = [];
  const profile = resolveCaptureEncodingProfile(platform);
  if (!resource || !profile) return { video, gif: false };
  const hasFilters = ["crop", "format", "fps"].every(name => resource.filters.includes(name));
  if (!hasFilters) return { video, gif: false };
  if (resource.formats.mp4 && resource.filters.includes("pad") && resource.encoders.includes(profile.h264Encoder)) video.push("mp4");
  if (resource.formats.webm && resource.encoders.includes("libvpx-vp9")) video.push("webm");
  const gif = resource.formats.gif && resource.encoders.includes("gif") &&
    ["fps", "split", "palettegen", "paletteuse"].every(name => resource.filters.includes(name));
  return { video, gif };
}

export interface TranscodeGeometry {
  crop: Rect;
  width: number;
  height: number;
  paddedForEvenSize: boolean;
  filter: string;
}

export function transcodeGeometry(crop: Rect, source: Size, output: RecordOutput): TranscodeGeometry {
  if (![crop.x, crop.y, crop.width, crop.height, source.width, source.height].every(Number.isSafeInteger) ||
    crop.x < 0 || crop.y < 0 || crop.width < 1 || crop.height < 1 ||
    crop.x + crop.width > source.width || crop.y + crop.height > source.height) {
    throw new Error("capture crop is outside the actual video frame");
  }
  const even = output === "mp4" ? toEvenSize(crop, source) : null;
  const rect = even?.rect ?? crop;
  const width = rect.width + (even?.padRight ? 1 : 0);
  const height = rect.height + (even?.padBottom ? 1 : 0);
  const filter = `crop=${rect.width}:${rect.height}:${rect.x}:${rect.y}:exact=1` +
    (even?.padRight || even?.padBottom ? `,pad=${width}:${height}:0:0:color=black` : "");
  return { crop: rect, width, height, paddedForEvenSize: !!(even?.padRight || even?.padBottom), filter };
}

/** Builds argv only: never a shell command; no scaling at any quality level. */
export function transcodeArguments(input: string, output: string, options: RecordOptions,
  quality: CaptureQuality, geometry: TranscodeGeometry, platform: NodeJS.Platform, mode: CaptureEncodingMode = "preferred"): string[] {
  const tier = getTierParams(quality);
  const fps = options.fps ?? 30;
  const common = ["-hide_banner", "-nostdin", "-y", "-i", input, "-an"];
  if (options.output === "gif") {
    const dither = quality === "low" ? "bayer:bayer_scale=3" : quality === "medium" ? "bayer:bayer_scale=2" : "sierra2_4a";
    return [...common, "-filter_complex",
      `${geometry.filter},fps=${Math.min(fps, tier.gifMaxFps)},split[a][b];[a]palettegen=max_colors=${tier.gifColors}:stats_mode=diff[p];[b][p]paletteuse=dither=${dither}:diff_mode=rectangle[out]`,
      "-map", "[out]", "-c:v", "gif", "-loop", "0", "-f", "gif", output];
  }
  const color = ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"];
  if (options.output === "webm") {
    return [...common, "-map", "0:v:0", "-vf", `${geometry.filter},fps=${fps},format=yuv420p`, "-c:v", "libvpx-vp9",
      "-b:v", "0", "-crf", String(tier.vp9Crf), "-deadline", "good", "-cpu-used", "4", "-row-mt", "1",
      ...color, "-f", "webm", output];
  }
  const bitrate = Math.max(64000, Math.round(geometry.width * geometry.height * fps * tier.videoBitsPerPixel));
  const profile = resolveCaptureEncodingProfile(platform);
  if (!profile) throw new CaptureRecordingError("encoder-unavailable", `Recording on ${platform} is unavailable`);
  return [...common, "-map", "0:v:0", "-vf", `${geometry.filter},fps=${fps},format=${profile.pixelFormat}`,
    ...profile.h264Arguments(bitrate, mode), ...color, "-movflags", "+faststart", "-f", "mp4", output];
}

/** Kill the independent encoder on abort; bound stderr and never inherit a terminal. */
export function runCaptureFfmpeg(path: string, args: readonly string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("capture was canceled")); return; }
    const child = spawn(path, [...args], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"], shell: false });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16000); });
    const abort = () => { child.kill("SIGKILL"); };
    signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => { stderr += "\nEncoder exceeded the 30 minute limit"; child.kill("SIGKILL"); }, 30 * 60 * 1000);
    child.once("error", error => { clearTimeout(timeout); signal.removeEventListener("abort", abort); reject(error); });
    child.once("close", code => {
      clearTimeout(timeout); signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(new Error("capture was canceled"));
      else if (code === 0) resolve();
      else reject(new CaptureRecordingError("failed", `Video encoding failed (${code}): ${stderr.trim()}`));
    });
    if (signal.aborted) abort();
  });
}

export async function transcodeRecording(resource: CaptureFfmpegResource, platform: NodeJS.Platform,
  input: string, output: string, source: Size, crop: Rect, options: RecordOptions, signal: AbortSignal) {
  const formats = recordingFormats(resource, platform);
  const profile = resolveCaptureEncodingProfile(platform);
  if (!profile || (options.output === "gif" ? !formats.gif : !formats.video.includes(options.output))) {
    throw new CaptureRecordingError("encoder-unavailable", `${options.output} encoder is unavailable`);
  }
  const geometry = transcodeGeometry(crop, source, options.output);
  validateCaptureEncodingGeometry(platform, options.output, geometry);
  let mode: CaptureEncodingMode = "preferred";
  const fitted = await fitToMaxBytes(options.compression?.quality ?? "high", options.compression?.maxBytes,
    async quality => {
      if (signal.aborted) throw new Error("capture was canceled");
      const resetOutput = async () => {
        await unlink(output).catch(() => {});
        // ffmpeg truncates this existing file and preserves the private mode while writing.
        await writeFile(output, Buffer.alloc(0), { flag: "wx", mode: 0o600 });
      };
      let args = transcodeArguments(input, output, options, quality, geometry, platform, mode);
      await resetOutput();
      try {
        await runCaptureFfmpeg(resource.path, args, signal);
      } catch (error) {
        // Profiles admit only their known compatibility error. Keep the same crop
        // and dimensions, retry at most once, and preserve cancellation/other failures.
        if (signal.aborted || options.output !== "mp4" || mode === "software" || !profile.softwareRetry?.accepts(error)) throw error;
        mode = "software";
        args = transcodeArguments(input, output, options, quality, geometry, platform, mode);
        await resetOutput();
        await runCaptureFfmpeg(resource.path, args, signal);
      }
      await chmod(output, 0o600);
      const encoded = await stat(output);
      if (!encoded.size) throw new CaptureRecordingError("failed", "Video encoder produced an empty output");
      return { value: output, bytes: encoded.size };
    });
  return { filePath: fitted.value, mime: options.output === "mp4" ? "video/mp4" : options.output === "webm" ? "video/webm" : "image/gif",
    width: geometry.width, height: geometry.height, qualityUsed: fitted.quality, exceedsMaxBytes: fitted.exceedsMaxBytes,
    paddedForEvenSize: geometry.paddedForEvenSize };
}
