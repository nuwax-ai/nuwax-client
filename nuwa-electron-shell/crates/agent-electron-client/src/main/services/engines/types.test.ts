/**
 * 引擎 id 归一化契约：平台可下发 `codex` / `codex-cli` / `nuwax-harness` 三种写法，
 * 内部统一成一种实现；这三个 id 与其它引擎必须判然有别，否则会误触发 harness 专用
 * 逻辑（CODEX_HOME 注入、适配器解析等）。
 */
import { describe, expect, it } from "vitest";
import { isHarnessEngineId, normalizeEngineId } from "./types";

describe("normalizeEngineId", () => {
  it.each([
    ["codex", "codex-cli"],
    ["codex-cli", "codex-cli"],
    ["nuwax-harness", "codex-cli"],
    // 大小写与空白容错（平台配置人手填写的可能性很高）
    ["  NUWAX-HARNESS  ", "codex-cli"],
    ["CODEX-CLI", "codex-cli"],
  ])("maps %j to %j", (input, expected) => {
    expect(normalizeEngineId(input)).toBe(expected);
  });

  it.each(["nuwaxcode", "claude-code"])("leaves %j untouched", (input) => {
    expect(normalizeEngineId(input)).toBe(input);
  });
});

describe("isHarnessEngineId", () => {
  it.each(["codex", "codex-cli", "nuwax-harness", "NUWAX-HARNESS"])(
    "recognizes %j as the harness family",
    (input) => expect(isHarnessEngineId(input)).toBe(true),
  );

  it.each(["nuwaxcode", "claude-code", "opencode", "", "  "])(
    "rejects %j",
    (input) => expect(isHarnessEngineId(input)).toBe(false),
  );

  it("treats missing values as non-harness", () => {
    expect(isHarnessEngineId(undefined)).toBe(false);
    expect(isHarnessEngineId(null)).toBe(false);
  });
});
