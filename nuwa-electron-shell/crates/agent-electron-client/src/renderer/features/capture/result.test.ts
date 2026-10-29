import { describe, it, expect, vi } from "vitest";
import type { CaptureBridge, CaptureSuccess } from "@shared/features/capture/contract";
import { MAX_PREVIEW_BYTES, readCaptureBlob } from "./result";

const result = (bytes: number): CaptureSuccess => ({
  success: true, resultId: "opaque", bytes, mime: "image/png", width: 20, height: 10,
  qualityUsed: "lossless", hdrToneMapped: false,
});

describe("capture preview transport", () => {
  it("reads exact bounded chunks, including the final partial chunk", async () => {
    const readChunk = vi.fn(async (_id, _offset, length) => new ArrayBuffer(length));
    const blob = await readCaptureBlob({ readChunk } as unknown as CaptureBridge, result(4 * 1024 * 1024 + 7));
    expect(blob?.size).toBe(4 * 1024 * 1024 + 7);
    expect(readChunk.mock.calls.map((call) => call.slice(1))).toEqual([[0, 4 * 1024 * 1024], [4 * 1024 * 1024, 7]]);
  });

  it("does not transfer a large video to the renderer for preview", async () => {
    const readChunk = vi.fn();
    expect(await readCaptureBlob({ readChunk } as unknown as CaptureBridge, result(MAX_PREVIEW_BYTES + 1))).toBeNull();
    expect(readChunk).not.toHaveBeenCalled();
  });

  it("rejects an expired or truncated result instead of previewing corrupted data", async () => {
    for (const part of [null, new ArrayBuffer(2)]) {
      await expect(readCaptureBlob({ readChunk: async () => part } as unknown as CaptureBridge, result(3)))
        .rejects.toThrow("expired");
    }
  });
});
