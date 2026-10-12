import { describe, it, expect } from "vitest";
import { CAPTURE_QUALITIES } from "@shared/features/capture/contract";
import { recordingFormats, transcodeGeometry, transcodeArguments, runCaptureFfmpeg, type CaptureFfmpegResource } from "./transcode";

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
    expect(recordingFormats(resource, "linux")).toEqual({ video: [], gif: false });
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

  it("terminates the independent process on cancel and bounds failure output", async () => {
    const controller = new AbortController();
    const task = runCaptureFfmpeg(process.execPath, ["-e", "setInterval(() => {},1000)"], controller.signal);
    controller.abort();
    await expect(task).rejects.toThrow("canceled");
    const failed = runCaptureFfmpeg(process.execPath, ["-e", "process.stderr.write('e'.repeat(20000)); process.exit(2)"], new AbortController().signal);
    await expect(failed).rejects.toMatchObject({ code:"failed" });
    try { await failed; } catch (error) { expect((error as Error).message.length).toBeLessThan(16100); }
  });
});
