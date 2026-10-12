import type { CaptureBridge, CaptureSuccess } from "@shared/features/capture/contract";

/** 小产物用于应用内预览；大视频直接保存，避免再向 renderer 复制完整文件。 */
export const MAX_PREVIEW_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;

export async function readCaptureBlob(capture: CaptureBridge, result: CaptureSuccess): Promise<Blob | null> {
  if (result.bytes > MAX_PREVIEW_BYTES) return null;
  const parts: ArrayBuffer[] = [];
  for (let offset = 0; offset < result.bytes; offset += CHUNK_BYTES) {
    const length = Math.min(CHUNK_BYTES, result.bytes - offset);
    const part = await capture.readChunk(result.resultId, offset, length);
    if (!part || part.byteLength !== length) throw new Error("capture result expired");
    parts.push(part);
  }
  return new Blob(parts, { type: result.mime });
}
