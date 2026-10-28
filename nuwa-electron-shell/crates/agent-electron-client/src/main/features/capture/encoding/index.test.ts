import { describe, expect, it } from "vitest";
import { CaptureRecordingError } from "../captureErrors";
import { transcodeGeometry } from "../transcode";
import { resolveCaptureEncodingProfile, validateCaptureEncodingGeometry } from "./index";

describe("capture encoding platform profiles", () => {
  it("selects one explicit profile and refuses unsupported platforms", () => {
    expect(resolveCaptureEncodingProfile("darwin")).toMatchObject({ h264Encoder: "h264_videotoolbox", pixelFormat: "yuv420p", binaryName: "ffmpeg" });
    expect(resolveCaptureEncodingProfile("win32")).toMatchObject({ h264Encoder: "h264_mf", pixelFormat: "nv12", binaryName: "ffmpeg.exe" });
    expect(resolveCaptureEncodingProfile("linux")).toMatchObject({ h264Encoder: "libopenh264", pixelFormat: "yuv420p", binaryName: "ffmpeg" });
    expect(resolveCaptureEncodingProfile("freebsd")).toBeNull();
    expect(resolveCaptureEncodingProfile("toString" as NodeJS.Platform)).toBeNull();
  });

  it("only Windows admits a bounded software retry for its specific H264 frame-size rejection", () => {
    const profile = resolveCaptureEncodingProfile("win32")!;
    const accepted = new CaptureRecordingError("failed", "[h264_mf @ 0001] could not set output type (MF_E_INVALIDMEDIATYPE)");
    expect(profile.softwareRetry?.accepts(accepted)).toBe(true);
    expect(profile.softwareRetry?.accepts(new Error(accepted.message))).toBe(false);
    expect(profile.softwareRetry?.accepts(new CaptureRecordingError("permission-denied", accepted.message))).toBe(false);
    expect(profile.softwareRetry?.accepts(new CaptureRecordingError("failed", "[other_decoder @ 1] MF_E_INVALIDMEDIATYPE"))).toBe(false);
    expect(profile.softwareRetry?.accepts(new CaptureRecordingError("failed", "[h264_mf @ 1] MF_E_TRANSFORM_TYPE_NOT_SET"))).toBe(false);
    expect(resolveCaptureEncodingProfile("darwin")?.softwareRetry).toBeUndefined();
    expect(resolveCaptureEncodingProfile("linux")?.softwareRetry).toBeUndefined();
    const hardware = profile.h264Arguments(64000, "preferred"), software = profile.h264Arguments(64000, "software");
    expect(hardware[hardware.indexOf("-hw_encoding") + 1]).toBe("1");
    expect(software[software.indexOf("-hw_encoding") + 1]).toBe("0");
    software[software.indexOf("-hw_encoding") + 1] = "1";
    expect(software).toEqual(hardware);
  });

  it("validates OpenH264 final dimensions without imposing its limit on GIF or other platforms", () => {
    for (const dimensions of [{ width: 14, height: 32 }, { width: 32, height: 14 }]) {
      expect(() => validateCaptureEncodingGeometry("linux", "mp4", dimensions)).toThrow("16 × 16 physical pixels");
      expect(() => validateCaptureEncodingGeometry("linux", "gif", dimensions)).not.toThrow();
      expect(() => validateCaptureEncodingGeometry("linux", "webm", dimensions)).not.toThrow();
      expect(() => validateCaptureEncodingGeometry("darwin", "mp4", dimensions)).not.toThrow();
      expect(() => validateCaptureEncodingGeometry("win32", "mp4", dimensions)).not.toThrow();
    }
    expect(() => validateCaptureEncodingGeometry("linux", "mp4", { width: 16, height: 16 })).not.toThrow();
    const aligned = transcodeGeometry({ x: 0, y: 0, width: 15, height: 17 }, { width: 64, height: 64 }, "mp4");
    expect(aligned).toMatchObject({ width: 16, height: 18 });
    expect(() => validateCaptureEncodingGeometry("linux", "mp4", aligned)).not.toThrow();
  });
});
