/**
 * 调用参数校验（来自渲染进程的参数一律视为不可信输入）。
 *
 * 严格模式：未知字段、类型不符、越界值都显式报错（`invalid-argument`），
 * 不做静默纠正，避免调用方以为某个选项生效了其实没有。
 */

import type {
  CaptureCompression,
  RecordOptions,
  RecordOutput,
  ScreenshotOptions,
  StillFormat,
} from "@shared/features/capture/contract";
import { isCaptureQuality } from "./tiers";
import { MAX_RECORDING_DURATION_MINUTES } from "@shared/features/capture/recordingPreferences";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const STILL_FORMATS: readonly StillFormat[] = ["png", "jpeg", "webp"];
const RECORD_OUTPUTS: readonly RecordOutput[] = ["mp4", "webm", "gif"];

export const MAX_BYTES_LIMIT = 2 * 1024 * 1024 * 1024;
export const MIN_FPS = 1;
export const MAX_FPS = 60;
export const MIN_DURATION_MS = 1_000;
export const MAX_DURATION_MS = MAX_RECORDING_DURATION_MINUTES * 60_000;

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKey(obj: Record<string, unknown>, allowed: readonly string[]): string | null {
  return Object.keys(obj).find((k) => !allowed.includes(k)) ?? null;
}

function parseCompression(raw: unknown): Parsed<CaptureCompression> {
  if (!isPlainObject(raw)) return fail("compression must be an object");
  const extra = unknownKey(raw, ["quality", "maxBytes"]);
  if (extra) return fail(`unknown compression option: ${extra}`);
  if (!isCaptureQuality(raw.quality)) {
    return fail("compression.quality must be one of lossless | high | medium | low");
  }
  const value: CaptureCompression = { quality: raw.quality };
  if (raw.maxBytes !== undefined) {
    const n = raw.maxBytes;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1 || n > MAX_BYTES_LIMIT) {
      return fail(`compression.maxBytes must be an integer in [1, ${MAX_BYTES_LIMIT}]`);
    }
    value.maxBytes = n;
  }
  return { ok: true, value };
}

export function parseScreenshotOptions(raw: unknown): Parsed<ScreenshotOptions> {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (!isPlainObject(raw)) return fail("options must be an object");
  const extra = unknownKey(raw, ["format", "compression"]);
  if (extra) return fail(`unknown option: ${extra}`);

  const value: ScreenshotOptions = {};
  if (raw.format !== undefined) {
    if (typeof raw.format !== "string" || !STILL_FORMATS.includes(raw.format as StillFormat)) {
      return fail("format must be one of png | jpeg | webp");
    }
    value.format = raw.format as StillFormat;
  }
  if (raw.compression !== undefined) {
    const c = parseCompression(raw.compression);
    if (!c.ok) return c;
    value.compression = c.value;
  }
  return { ok: true, value };
}

export function parseRecordOptions(raw: unknown): Parsed<RecordOptions> {
  if (!isPlainObject(raw)) return fail("options must be an object");
  const extra = unknownKey(raw, ["output", "fps", "compression", "maxDurationMs"]);
  if (extra) return fail(`unknown option: ${extra}`);
  if (typeof raw.output !== "string" || !RECORD_OUTPUTS.includes(raw.output as RecordOutput)) {
    return fail("output must be one of mp4 | webm | gif");
  }
  const value: RecordOptions = { output: raw.output as RecordOutput };

  if (raw.fps !== undefined) {
    const n = raw.fps;
    if (typeof n !== "number" || !Number.isInteger(n) || n < MIN_FPS || n > MAX_FPS) {
      return fail(`fps must be an integer in [${MIN_FPS}, ${MAX_FPS}]`);
    }
    value.fps = n;
  }
  if (raw.maxDurationMs !== undefined) {
    const n = raw.maxDurationMs;
    if (
      typeof n !== "number" ||
      !Number.isInteger(n) ||
      n < MIN_DURATION_MS ||
      n > MAX_DURATION_MS
    ) {
      return fail(`maxDurationMs must be an integer in [${MIN_DURATION_MS}, ${MAX_DURATION_MS}]`);
    }
    value.maxDurationMs = n;
  }
  if (raw.compression !== undefined) {
    const c = parseCompression(raw.compression);
    if (!c.ok) return c;
    value.compression = c.value;
  }
  return { ok: true, value };
}
