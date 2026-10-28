import { app } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveCaptureEncodingProfile, type CaptureEncodingProfile } from "./encoding";

const runFile = promisify(execFile);

export interface CaptureFfmpegResource {
  path: string;
  version: string;
  configuration: string;
  encoders: string[];
  filters: string[];
  formats: { mp4: boolean; webm: boolean; gif: boolean };
  /** Codec probes can fail even when an encoder appears in -encoders. */
  probeErrors: Partial<Record<"mp4" | "webm" | "gif", string>>;
}

interface ResourceRecord {
  schema: number;
  platform: string;
  arch: string;
  version: string;
  sha256: string;
  configuration: string;
  sources: Record<string, { version: string; url: string; sha256: string; license: string }>;
}

export interface CaptureEncodingResourceOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  /** Directory containing the per-platform directories, never a PATH lookup. */
  resourceRoot?: string;
}

/** Real short encodes, rather than trusting codec names in configuration. */
async function probeCodec(binary: string, format: "mp4" | "webm" | "gif", profile: CaptureEncodingProfile): Promise<string | null> {
  // Some usable MediaFoundation hardware encoders reject tiny 128×96 frames.
  // Probe a conventional frame size so that a size limit does not hide the codec.
  const args = ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=320x240:r=15:d=0.15", "-an", "-frames:v", "2"];
  if (format === "mp4") args.push(...profile.probeH264Arguments());
  if (format === "webm") args.push("-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-pix_fmt", "yuv420p");
  if (format === "gif") args.push("-filter_complex", "split[a][b];[a]palettegen[p];[b][p]paletteuse", "-c:v", "gif");
  args.push("-f", format === "gif" ? "gif" : "null", "pipe:1");
  try { await runFile(binary, args, { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true }); return null; }
  catch (error) {
    const detail = error as Error & { stderr?: string | Buffer };
    return String(detail.stderr || detail.message).trim().slice(-1200);
  }
}

/**
 * Only the commercial resource is admitted. Missing files, an unverified hash,
 * an unexpected source lock or GPL/nonfree configuration yield no video formats.
 */
export async function resolveCaptureFfmpeg(options: CaptureEncodingResourceOptions = {}): Promise<CaptureFfmpegResource | null> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const profile = resolveCaptureEncodingProfile(platform);
  if (!profile || !["x64", "arm64"].includes(arch)) return null;
  const resourceRoot = options.resourceRoot ?? (app.isPackaged
    ? path.join(process.resourcesPath, "capture")
    : path.resolve(app.getAppPath(), "../../../resources/capture"));
  const directory = path.join(resourceRoot, `${platform}-${arch}`);
  const binary = path.join(directory, profile.binaryName);
  try {
    const record = JSON.parse(await fs.readFile(path.join(directory, "resource.json"), "utf8")) as ResourceRecord;
    if (record.schema !== 1 || record.platform !== platform || record.arch !== arch || !/^[a-f0-9]{64}$/.test(record.sha256)) return null;
    if (record.version !== "8.1.3" || record.sources?.ffmpeg?.sha256 !== "7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3" || record.sources?.libvpx?.sha256 !== "073bd6202e4c55c8cb759abbb123aecd4cc8d99f52ba27af790178cfb1108423") return null;
    if (!profile.requiredSources.every(({ id, version, sha256 }) => record.sources?.[id]?.version === version && record.sources[id].sha256 === sha256)) return null;
    if (/--enable-(?:gpl|nonfree)\b/.test(record.configuration)) return null;
    const hash = createHash("sha256").update(await fs.readFile(binary)).digest("hex");
    if (hash !== record.sha256) return null;
    const version = await runFile(binary, ["-version"], { timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true });
    const configuration = /^configuration:\s*(.*)$/m.exec(version.stdout)?.[1]?.trim();
    if (!version.stdout.startsWith(`ffmpeg version ${record.version} `) || configuration !== record.configuration || /--enable-(?:gpl|nonfree)\b/.test(configuration)) return null;
    const [encoderOutput, filterOutput] = await Promise.all([
      runFile(binary, ["-hide_banner", "-encoders"], { timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true }),
      runFile(binary, ["-hide_banner", "-filters"], { timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true }),
    ]);
    const encoders = [...encoderOutput.stdout.matchAll(/^\s*[VAS][A-Z.]{5}\s+([a-z][a-z0-9_-]*)/gm)].map((match) => match[1]);
    const filters = [...filterOutput.stdout.matchAll(/^\s*[TSC.]{2,3}\s+([a-z][a-z0-9_-]*)/gm)].map((match) => match[1]);
    const formats = { mp4: false, webm: false, gif: false };
    const probeErrors: CaptureFfmpegResource["probeErrors"] = {};
    for (const format of ["mp4", "webm", "gif"] as const) {
      const error = await probeCodec(binary, format, profile);
      if (error) probeErrors[format] = error;
      else formats[format] = true;
    }
    return { path: binary, version: record.version, configuration, encoders, filters, formats, probeErrors };
  } catch { return null; }
}
