import { describe, it, expect, vi } from "vitest";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRecordingSink, payloadBuffer, recordingSinkForHandle } from "./recordingSink";
import { RECORDING_CHUNK_LIMIT } from "@shared/features/capture/recordingContract";

describe("recording chunk writer", () => {
  it("writes a long stream in ordered chunks and closes without retaining its recording", async () => {
    const dir = await mkdtemp(join(tmpdir(), "capture-sink-"));
    try {
      const path = join(dir, "source.webm");
      const sink = await createRecordingSink(path);
      await sink.append(0, Uint8Array.from([1,2,3]));
      await sink.append(1, Uint8Array.from([4,5]).buffer);
      expect(sink.bytes).toBe(5);
      await sink.close();
      await sink.close();
      expect(await readFile(path)).toEqual(Buffer.from([1,2,3,4,5]));
      if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
      await expect(sink.append(2, new Uint8Array([6]))).rejects.toThrow("closed");
      await expect(createRecordingSink(path)).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("rejects gaps, repeats, oversized messages and nonbinary payloads before writing", async () => {
    const file = { write: vi.fn(async () => ({ bytesWritten: 1, buffer: Buffer.alloc(1) })), close: vi.fn(async () => {}) };
    const sink = recordingSinkForHandle(file);
    await expect(sink.append(1, new Uint8Array([1]))).rejects.toThrow("sequence");
    await expect(sink.append(0, "arbitrary-file-path")).rejects.toThrow("binary");
    await expect(sink.append(0, new Uint8Array(RECORDING_CHUNK_LIMIT+1))).rejects.toThrow("bounds");
    await sink.append(0, new Uint8Array([1]));
    await expect(sink.append(0, new Uint8Array([2]))).rejects.toThrow("sequence");
    expect(file.write).toHaveBeenCalledTimes(1);
    await sink.close();
  });

  it("handles partial writes, enforces backpressure and waits for outstanding disk IO on close", async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const file = { write: vi.fn(async () => { await pending; return { bytesWritten: 1, buffer: Buffer.alloc(1) }; }), close: vi.fn(async () => {}) };
    const sink = recordingSinkForHandle(file);
    const write = sink.append(0, new Uint8Array([1,2,3]));
    await expect(sink.append(1, new Uint8Array([4]))).rejects.toThrow("busy");
    const close = sink.close();
    expect(file.close).not.toHaveBeenCalled();
    finish();
    await write; await close;
    expect(file.write).toHaveBeenCalledTimes(3);
    expect(file.close).toHaveBeenCalledOnce();
  });

  it("preserves the byteOffset of a typed-array slice", () => {
    const data = Uint8Array.from([9,1,2,9]);
    expect(payloadBuffer(data.subarray(1,3), 4)).toEqual(Buffer.from([1,2]));
  });
});
