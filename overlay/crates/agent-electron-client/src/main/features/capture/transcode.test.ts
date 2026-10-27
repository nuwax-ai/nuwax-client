import { afterEach, describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CAPTURE_QUALITIES } from "@shared/features/capture/contract";
import { recordingFormats, transcodeGeometry, transcodeArguments, runCaptureFfmpeg, transcodeRecording, type CaptureFfmpegResource } from "./transcode";

const processFixture = vi.hoisted(() => ({ spawn: undefined as ((args: string[]) => unknown) | undefined }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: (file: string, args: string[], options: unknown) => processFixture.spawn
    ? processFixture.spawn(args) : actual.spawn(file, args, options as import("node:child_process").SpawnOptions) };
});
const directories: string[] = [];
afterEach(async () => {
  processFixture.spawn = undefined;
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fakeTranscoder(outcomes: Array<string | null>, controller?: AbortController) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "capture-transcode-")); directories.push(directory);
  const input = path.join(directory, "source.webm"), output = path.join(directory, "result.mp4");
  await writeFile(input, "unchanged source");
  const calls: string[][] = [], initialSizes: number[] = [];
  processFixture.spawn = (args) => {
    calls.push([...args]);
    const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill(): boolean };
    child.stderr = new EventEmitter(); child.kill = () => true;
    const outcome = outcomes.shift();
    setImmediate(async () => {
      try {
        initialSizes.push((await readFile(output)).length);
        await writeFile(output, outcome ? "partial failed output" : "complete software MP4");
        if (outcome) child.stderr.emit("data", Buffer.from(outcome));
        controller?.abort();
        child.emit("close", outcome ? 1 : 0);
      } catch (error) { child.emit("error", error); }
    });
    return child;
  };
  const run = (platform: NodeJS.Platform = "win32", outputFormat: "mp4" | "webm" = "mp4") => transcodeRecording(
    { ...resource, encoders: [...resource.encoders, "h264_mf"] }, platform, input, output,
    { width: 640, height: 480 }, { x: 20, y: 10, width: 128, height: 96 }, { output: outputFormat, fps: 15 },
    controller?.signal ?? new AbortController().signal);
  return { run, input, output, calls, initialSizes };
}

const resource: CaptureFfmpegResource = {
  path: "/private/capture/ffmpeg", version: "test", configuration: "--disable-gpl",
  encoders: ["h264_videotoolbox", "libvpx-vp9", "gif"],
  filters: ["crop", "format", "pad", "fps", "split", "palettegen", "paletteuse"],
  formats: { mp4: true, webm: true, gif: true },
};

describe("capture encoding", () => {
  it("reports only encoders that passed this platform's probes", () => {
    expect(recordingFormats(resource, "darwin")).toEqual({ video: ["mp4","webm"], gif: true });
    expect(recordingFormats(resource, "win32")).toEqual({ video: ["webm"], gif: true });
    expect(recordingFormats(null, "darwin")).toEqual({ video: [], gif: false });
    expect(recordingFormats(resource, "linux")).toEqual({ video: ["webm"], gif: true });
    expect(recordingFormats({ ...resource, encoders: [...resource.encoders, "libopenh264"] }, "linux")).toEqual({ video: ["mp4", "webm"], gif: true });
    expect(recordingFormats(resource, "freebsd")).toEqual({ video: [], gif: false });
    expect(recordingFormats({ ...resource, filters: [] }, "darwin")).toEqual({ video: [], gif: false });
    expect(recordingFormats({ ...resource, formats: { mp4: false, webm: false, gif: false } }, "darwin")).toEqual({ video: [], gif: false });
  });

  it("keeps physical dimensions across all quality tiers without resampling", () => {
    for (const output of ["mp4","webm","gif"] as const) {
      const geometry = transcodeGeometry({ x: 20, y: 10, width: 301, height: 201 }, { width: 1920, height: 1080 }, output);
      for (const quality of CAPTURE_QUALITIES) {
        const args = transcodeArguments("in.webm", `out.${output}`, { output, fps: 30 }, quality, geometry, "darwin");
        expect(geometry.width).toBe(output === "mp4" ? 302 : 301);
        expect(geometry.height).toBe(output === "mp4" ? 202 : 201);
        expect(args.join(" ")).not.toMatch(/(?:(?:^|[,;\s])scale=|\s-s\s)/);
        expect(args.join(" ")).toContain(`crop=${geometry.width}:${geometry.height}:20:10:exact=1`);
        expect(args).toContain("-an");
      }
    }
  });

  it("expands odd H264 crops into real pixels before resorting to padding", () => {
    const edge = transcodeGeometry({ x: 1, y: 1, width: 99, height: 99 }, { width: 100, height: 100 }, "mp4");
    expect(edge.crop).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(edge.filter).not.toContain("pad");
    expect(edge.paddedForEvenSize).toBe(false);
    const full = transcodeGeometry({ x: 0, y: 0, width: 101, height: 99 }, { width: 101, height: 99 }, "mp4");
    expect(full).toMatchObject({ width: 102, height: 100, paddedForEvenSize: true });
    expect(full.filter).toContain("pad=102:100:0:0");
  });

  it("Linux encodes MP4 with software OpenH264 and preserves odd selection pixels at every quality", () => {
    const geometry = transcodeGeometry({ x: 20, y: 10, width: 301, height: 201 }, { width: 1920, height: 1080 }, "mp4");
    for (const quality of CAPTURE_QUALITIES) {
      const args = transcodeArguments("in.webm", "out.mp4", { output: "mp4", fps: 30 }, quality, geometry, "linux");
      expect(args[args.indexOf("-c:v") + 1]).toBe("libopenh264");
      expect(args[args.indexOf("-pix_fmt") + 1]).toBe("yuv420p");
      expect(args[args.indexOf("-rc_mode") + 1]).toBe("bitrate");
      expect(args[args.indexOf("-vf") + 1]).toContain("crop=302:202:20:10:exact=1");
      expect(args).not.toContain("-hw_encoding"); expect(args).not.toContain("-allow_sw");
      expect(args.join(" ")).not.toMatch(/(?:[,;\s])scale=|libx264/);
      expect(args).toContain("+faststart");
    }
  });

  it("rejects an unusably narrow Linux MP4 before spawning or writing an output", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "capture-transcode-")); directories.push(directory);
    const output = path.join(directory, "small.mp4");
    const calls: string[][] = [];
    processFixture.spawn = args => { calls.push(args); throw new Error("encoder must not launch"); };
    await expect(transcodeRecording({ ...resource, encoders: [...resource.encoders, "libopenh264"] }, "linux", "source.webm", output,
      { width: 640, height: 480 }, { x: 0, y: 0, width: 14, height: 32 }, { output: "mp4" }, new AbortController().signal))
      .rejects.toMatchObject({ code: "failed", message: expect.stringContaining("16 × 16 physical pixels") });
    expect(calls).toEqual([]);
    await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects invalid geometry without interpolating it into encoder filters", () => {
    for (const crop of [ {x:-1,y:0,width:10,height:10}, {x:0,y:0,width:101,height:10}, {x:0,y:0,width:0,height:10}, {x:0.5,y:0,width:10,height:10} ]) {
      expect(() => transcodeGeometry(crop, { width:100,height:100 }, "webm")).toThrow("outside");
    }
  });

  it("lowers bitrate, VP9 quality and GIF frame/palette settings at lower tiers", () => {
    const geometry = transcodeGeometry({ x:0,y:0,width:1920,height:1080 }, { width:1920,height:1080 }, "mp4");
    const mp4high = transcodeArguments("in", "out", {output:"mp4",fps:30}, "high", geometry, "darwin");
    const mp4low = transcodeArguments("in", "out", {output:"mp4",fps:30}, "low", geometry, "darwin");
    expect(Number(mp4high[mp4high.indexOf("-b:v")+1])).toBeGreaterThan(Number(mp4low[mp4low.indexOf("-b:v")+1]));
    expect(mp4high).toContain("h264_videotoolbox");
    const windowsMp4 = transcodeArguments("in","out",{output:"mp4"},"high",geometry,"win32");
    expect(windowsMp4).toContain("h264_mf");
    expect(windowsMp4[windowsMp4.indexOf("-pix_fmt")+1]).toBe("nv12");
    expect(windowsMp4).toContain("-hw_encoding");
    const webm = transcodeArguments("in","out",{output:"webm"},"low",geometry,"darwin");
    expect(webm[webm.indexOf("-crf")+1]).toBe("37");
    expect(webm[webm.indexOf("-vf")+1]).toContain("fps=30");
    const gif = transcodeArguments("in","out",{output:"gif",fps:60},"low",geometry,"darwin").join(" ");
    expect(gif).toContain("fps=10"); expect(gif).toContain("max_colors=128");
    expect(gif).toContain("paletteuse=dither=bayer");
  });

  it('reads an immutable recording independently for the palette so GIF frames need not queue behind it', () => {
    const geometry = transcodeGeometry({ x: 20, y: 10, width: 301, height: 201 }, { width: 1920, height: 1080 }, 'gif');
    const args = transcodeArguments('source.webm', 'result.gif', { output: 'gif', fps: 30 }, 'high', geometry, 'win32');
    expect(args.filter(value => value === '-i')).toHaveLength(2);
    expect(args[args.lastIndexOf('-i') + 1]).toBe('source.webm');
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toContain('[0:v:0]crop=301:201:20:10:exact=1,fps=15,palettegen=max_colors=256:stats_mode=diff[p]');
    expect(graph).toContain('[1:v:0]crop=301:201:20:10:exact=1,fps=15[b]');
    expect(graph).toContain('[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle[out]');
    expect(graph).not.toContain('split');
    expect(args.slice(-5)).toEqual(['-loop', '0', '-f', 'gif', 'result.gif']);
  });

  it("terminates the independent process on cancel and bounds failure output", async () => {
    const controller = new AbortController();
    const task = runCaptureFfmpeg(process.execPath, ["-e", "setInterval(() => {},1000)"], controller.signal);
    controller.abort();
    await expect(task).rejects.toThrow("canceled");
    const failed = runCaptureFfmpeg(process.execPath, ["-e", "process.stderr.write('e'.repeat(20000)); process.exit(2)"], new AbortController().signal);
    await expect(failed).rejects.toMatchObject({ code:"failed" });
    try { await failed; } catch (error) { expect((error as Error).message.length).toBeLessThan(16100); }
  });

  it("retries a Windows hardware frame-size rejection with system software MF without resizing", async () => {
    const fixture = await fakeTranscoder(["[h264_mf @ 0001] could not set output type (MF_E_INVALIDMEDIATYPE)", null]);
    const result = await fixture.run();
    expect(result).toMatchObject({ width: 128, height: 96, mime: "video/mp4", paddedForEvenSize: false });
    expect(fixture.calls).toHaveLength(2);
    const hardware = fixture.calls[0], software = fixture.calls[1];
    expect(hardware[hardware.indexOf("-hw_encoding") + 1]).toBe("1");
    expect(software[software.indexOf("-hw_encoding") + 1]).toBe("0");
    const normalized = [...software]; normalized[normalized.indexOf("-hw_encoding") + 1] = "1";
    expect(normalized).toEqual(hardware);
    expect(software[software.indexOf("-vf") + 1]).toContain("crop=128:96:20:10:exact=1");
    expect(fixture.initialSizes).toEqual([0, 0]);
    expect(await readFile(fixture.input, "utf8")).toBe("unchanged source");
    expect(await readFile(fixture.output, "utf8")).toBe("complete software MP4");
  });

  it.each([
    ["win32", "mp4", "[h264_mf @ 0001] encoder initialization failed (MF_E_TRANSFORM_TYPE_NOT_SET)"],
    ["win32", "mp4", "[other_decoder @ 0001] failed (MF_E_INVALIDMEDIATYPE)"],
    ["darwin", "mp4", "[h264_mf @ 0001] failed (MF_E_INVALIDMEDIATYPE)"],
    ["win32", "webm", "[h264_mf @ 0001] failed (MF_E_INVALIDMEDIATYPE)"],
  ] as const)("preserves unrelated %s %s errors instead of starting a software retry", async (platform, format, error) => {
    const fixture = await fakeTranscoder([error]);
    await expect(fixture.run(platform, format)).rejects.toMatchObject({ code: "failed", message: expect.stringContaining(error) });
    expect(fixture.calls).toHaveLength(1);
  });

  it("cancellation after the hardware error never launches a software retry", async () => {
    const fixture = await fakeTranscoder(["[h264_mf @ 0001] failed (MF_E_INVALIDMEDIATYPE)"], new AbortController());
    await expect(fixture.run()).rejects.toThrow("canceled");
    expect(fixture.calls).toHaveLength(1);
  });

  it("reports a failed system software retry without looping or hiding its error", async () => {
    const fixture = await fakeTranscoder(["[h264_mf @ 0001] failed (MF_E_INVALIDMEDIATYPE)", "[h264_mf @ 0002] software transform unavailable"]);
    await expect(fixture.run()).rejects.toMatchObject({ code: "failed", message: expect.stringContaining("software transform unavailable") });
    expect(fixture.calls).toHaveLength(2);
  });
});
