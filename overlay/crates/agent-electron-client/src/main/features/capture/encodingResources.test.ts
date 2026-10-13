import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const behavior = vi.hoisted(() => ({ calls: [] as string[][], configuration: "--disable-gpl --disable-nonfree --enable-videotoolbox", failMp4: false, rejectSmallMfFrames: false }));
vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => "/host/client" } }));
vi.mock("node:child_process", () => {
  const execFile = vi.fn();
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), { value: async (file: string, args: string[]) => {
    behavior.calls.push([file, ...args]);
    if (args[0] === "-version") return { stdout: `ffmpeg version 8.1.3 test\nconfiguration: ${behavior.configuration}\n`, stderr: "" };
    if (args.includes("-encoders")) return { stdout: " V..... = Video\n V....D h264_videotoolbox\n V....D libvpx-vp9\n V....D gif\n", stderr: "" };
    if (args.includes("-filters")) return { stdout: " T.. = Timeline\n .. crop V->V\n .. palettegen V->V\n .. paletteuse VV->V\n", stderr: "" };
    if (behavior.failMp4 && args.includes("h264_videotoolbox")) throw Object.assign(new Error("codec unavailable"), { stderr: "VideoToolbox hardware unavailable" });
    if (behavior.rejectSmallMfFrames && args.includes("h264_mf")) {
      const size = /:s=(\d+)x(\d+):/.exec(args[args.indexOf("-i") + 1]);
      if (!size || Number(size[1]) < 320 || Number(size[2]) < 240) {
        throw Object.assign(new Error("codec rejected probe dimensions"), { stderr: "MF_E_INVALIDMEDIATYPE" });
      }
    }
    return { stdout: "", stderr: "" };
  } });
  return { execFile };
});
import { resolveCaptureFfmpeg } from "./encodingResources";

const temporary: string[] = [];
afterEach(async () => {
  for (const directory of temporary.splice(0)) await fs.rm(directory, { recursive: true, force: true });
  behavior.calls = []; behavior.configuration = "--disable-gpl --disable-nonfree --enable-videotoolbox"; behavior.failMp4 = false; behavior.rejectSmallMfFrames = false;
});
async function fixture(platform: "darwin" | "win32" = "darwin") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "capture-encoding-")); temporary.push(root);
  const directory = path.join(root, `${platform}-arm64`); await fs.mkdir(directory);
  const binary = path.join(directory, platform === "win32" ? "ffmpeg.exe" : "ffmpeg"); await fs.writeFile(binary, "verified fixture");
  const record = { schema: 1, platform, arch: "arm64", version: "8.1.3", sha256: createHash("sha256").update("verified fixture").digest("hex"), configuration: behavior.configuration,
    sources: { ffmpeg: { sha256: "7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3" }, libvpx: { sha256: "073bd6202e4c55c8cb759abbb123aecd4cc8d99f52ba27af790178cfb1108423" } } };
  const save = () => fs.writeFile(path.join(directory, "resource.json"), JSON.stringify(record)); await save();
  const resolve = () => resolveCaptureFfmpeg({ resourceRoot: root, platform, arch: "arm64" });
  return { root, record, binary, save, resolve };
}

describe("capture encoding resources", () => {
  it("missing, hashless or tampered resource has no fallback to system ffmpeg", async () => {
    const f = await fixture();
    f.record.sha256 = ""; await f.save(); expect(await f.resolve()).toBeNull();
    expect(behavior.calls).toEqual([]);
    f.record.sha256 = createHash("sha256").update("verified fixture").digest("hex"); await f.save();
    await fs.appendFile(f.binary, "tampered"); expect(await f.resolve()).toBeNull();
    expect(behavior.calls).toEqual([]);
  });
  it("GPL or nonfree configuration is rejected before executing a resource", async () => {
    const f = await fixture();
    for (const flag of ["--enable-gpl", "--enable-nonfree"]) {
      f.record.configuration = flag; await f.save(); expect(await f.resolve()).toBeNull();
    }
    expect(behavior.calls).toEqual([]);
  });
  it("checks live configuration, lists real codec names and performs short encode probes", async () => {
    const f = await fixture();
    const resolved = await f.resolve();
    expect(resolved?.formats).toEqual({ mp4: true, webm: true, gif: true });
    expect(resolved?.encoders).toEqual(["h264_videotoolbox", "libvpx-vp9", "gif"]);
    expect(resolved?.filters).toEqual(["crop", "palettegen", "paletteuse"]);
    expect(behavior.calls.filter((args) => args.includes("-frames:v"))).toHaveLength(3);
    expect(behavior.calls.every((args) => args[0] === f.binary)).toBe(true);
    behavior.configuration = "--enable-gpl";
    expect(await f.resolve()).toBeNull();
  });
  it("an advertised but unusable H264 codec removes MP4 capability and retains the error summary", async () => {
    const f = await fixture(); behavior.failMp4 = true;
    const resolved = await f.resolve();
    expect(resolved?.formats).toEqual({ mp4: false, webm: true, gif: true });
    expect(resolved?.probeErrors.mp4).toContain("VideoToolbox hardware unavailable");
  });
  it("Linux never probes capture resources", async () => {
    expect(await resolveCaptureFfmpeg({ platform: "linux" })).toBeNull();
    expect(behavior.calls).toEqual([]);
  });
  it("Windows H264 probes hardware MediaFoundation with NV12 input", async () => {
    const f = await fixture("win32"); await f.resolve();
    const probe = behavior.calls.find((args) => args.includes("h264_mf"));
    expect(probe).toContain("nv12"); expect(probe).toContain("-hw_encoding");
    expect(probe?.[0]).toBe(f.binary);
  });
  it("Windows hardware that rejects tiny frames retains its usable MP4 capability", async () => {
    const f = await fixture("win32"); behavior.rejectSmallMfFrames = true;
    const resolved = await f.resolve();
    expect(resolved?.formats).toEqual({ mp4: true, webm: true, gif: true });
    expect(resolved?.probeErrors.mp4).toBeUndefined();
    const probe = behavior.calls.find((args) => args.includes("h264_mf"));
    expect(probe).toContain("color=c=black:s=320x240:r=15:d=0.15");
    expect(probe).toContain("nv12"); expect(probe).toContain("-hw_encoding");
  });
});
