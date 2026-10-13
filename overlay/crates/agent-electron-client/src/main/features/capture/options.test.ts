/**
 * 单元测试: options - 调用参数严格校验
 *
 * 覆盖：缺省/空对象合法；未知字段、错误类型、越界值、非法枚举、非整数、非数组对象均被拒绝；
 * 合法组合原样透传；record 的 output 必填。
 */

import { describe, it, expect } from "vitest";
import {
  MAX_BYTES_LIMIT,
  MAX_DURATION_MS,
  parseRecordOptions,
  parseScreenshotOptions,
} from "./options";

const err = (r: { ok: boolean; error?: string }) => (r.ok ? null : r.error);

describe("parseScreenshotOptions", () => {
  it("undefined / null / 空对象都合法", () => {
    for (const raw of [undefined, null, {}]) {
      expect(parseScreenshotOptions(raw)).toEqual({ ok: true, value: {} });
    }
  });

  it("合法组合原样透传", () => {
    const raw = { format: "jpeg", compression: { quality: "medium", maxBytes: 500000 } };
    expect(parseScreenshotOptions(raw)).toEqual({ ok: true, value: raw });
  });

  it("拒绝非对象、数组、未知字段", () => {
    expect(err(parseScreenshotOptions("x"))).toMatch(/object/);
    expect(err(parseScreenshotOptions([]))).toMatch(/object/);
    expect(err(parseScreenshotOptions({ sourceId: "1" }))).toMatch(/unknown option: sourceId/);
  });

  it("拒绝非法格式与档位", () => {
    expect(err(parseScreenshotOptions({ format: "gif" }))).toMatch(/format/);
    expect(err(parseScreenshotOptions({ format: 1 }))).toMatch(/format/);
    expect(err(parseScreenshotOptions({ compression: { quality: "ultra" } }))).toMatch(/quality/);
    expect(err(parseScreenshotOptions({ compression: {} }))).toMatch(/quality/);
    expect(err(parseScreenshotOptions({ compression: "high" }))).toMatch(/object/);
  });

  it("maxBytes 必须是 [1, 上限] 内的整数；compression 内未知字段被拒绝", () => {
    for (const maxBytes of [0, -1, 1.5, NaN, Infinity, "10", MAX_BYTES_LIMIT + 1]) {
      expect(err(parseScreenshotOptions({ compression: { quality: "high", maxBytes } }))).toMatch(
        /maxBytes/,
      );
    }
    expect(parseScreenshotOptions({ compression: { quality: "high", maxBytes: MAX_BYTES_LIMIT } }).ok).toBe(true);
    expect(err(parseScreenshotOptions({ compression: { quality: "high", scale: 0.5 } }))).toMatch(
      /unknown compression option: scale/,
    );
  });
});

describe("parseRecordOptions", () => {
  it("output 必填且必须合法", () => {
    expect(err(parseRecordOptions(undefined))).toMatch(/object/);
    expect(err(parseRecordOptions({}))).toMatch(/output/);
    expect(err(parseRecordOptions({ output: "avi" }))).toMatch(/output/);
    for (const output of ["mp4", "webm", "gif"]) {
      expect(parseRecordOptions({ output })).toEqual({ ok: true, value: { output } });
    }
  });

  it("fps 与 maxDurationMs 做整数与范围校验", () => {
    for (const fps of [0, 61, 1.5, "30"]) {
      expect(err(parseRecordOptions({ output: "mp4", fps }))).toMatch(/fps/);
    }
    for (const maxDurationMs of [999, MAX_DURATION_MS + 1, 1.5, "5000"]) {
      expect(err(parseRecordOptions({ output: "mp4", maxDurationMs }))).toMatch(/maxDurationMs/);
    }
    const ok = { output: "gif", fps: 15, maxDurationMs: 30_000, compression: { quality: "low" } };
    expect(parseRecordOptions(ok)).toEqual({ ok: true, value: ok });
  });

  it("未知字段被拒绝", () => {
    expect(err(parseRecordOptions({ output: "mp4", audio: true }))).toMatch(/unknown option: audio/);
  });
});
