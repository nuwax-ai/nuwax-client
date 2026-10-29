import { open } from "node:fs/promises";
import { RECORDING_CHUNK_LIMIT } from "@shared/features/capture/recordingContract";

// Bounds transport and intermediate disk use independently of the requested final maxBytes.
export const MAX_RECORDING_INPUT_BYTES = 8 * 1024 * 1024 * 1024;

export interface RecordingSink {
  readonly bytes: number;
  append(sequence: unknown, data: unknown): Promise<void>;
  close(): Promise<void>;
}

export function payloadBuffer(data: unknown, maxBytes: number): Buffer {
  if (!(data instanceof ArrayBuffer) && !(data instanceof Uint8Array)) {
    throw new Error("capture payload must be binary");
  }
  const bytes = data.byteLength;
  if (bytes < 1 || bytes > maxBytes) throw new Error("capture payload size is out of bounds");
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(data);
}

/** Only the main process chooses the file; renderers send bounded ordered byte chunks. */
export async function createRecordingSink(path: string): Promise<RecordingSink> {
  return recordingSinkForHandle(await open(path, "wx", 0o600));
}

export interface RecordingFileWriter {
  write(buffer: Buffer, offset: number, length: number, position: null): Promise<{ bytesWritten: number }>;
  close(): Promise<void>;
}

export function recordingSinkForHandle(file: RecordingFileWriter): RecordingSink {
  let nextSequence = 0;
  let bytes = 0;
  let closed = false;
  let writing: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  return {
    get bytes() { return bytes; },
    async append(sequence, data) {
      if (closed || writing) throw new Error("recording writer is closed or busy");
      if (!Number.isSafeInteger(sequence) || sequence !== nextSequence) {
        throw new Error("recording chunk is out of sequence");
      }
      const buffer = payloadBuffer(data, RECORDING_CHUNK_LIMIT);
      if (bytes + buffer.length > MAX_RECORDING_INPUT_BYTES) throw new Error("recording exceeds disk safety limit");
      nextSequence++;
      writing = (async () => {
        let offset = 0;
        while (offset < buffer.length) {
          const result = await file.write(buffer, offset, buffer.length - offset, null);
          if (!result.bytesWritten) throw new Error("recording disk write made no progress");
          offset += result.bytesWritten;
        }
        bytes += buffer.length;
      })();
      try { await writing; } finally { writing = undefined; }
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        try { await writing; } finally { await file.close(); }
      })();
      return closePromise;
    },
  };
}
