import { describe, expect, it } from "vitest";
import { normalizeComputerSandboxId, parseComputerServiceStateCommand } from "./computerServiceState";

describe("电脑状态脱敏协议", () => {
  it.each([[31, "31"], ["0031", "31"], ["9007199254740993123", "9007199254740993123"]])(
    "本机配置 ID %j 归一为字符串",
    (value, expected) => expect(normalizeComputerSandboxId(value)).toBe(expected),
  );
  it.each([0, -1, 1.5, NaN, Infinity, 9007199254740992, "-1", "0", "000", "", "31.1", "user-31", null, {}])(
    "非法配置 ID %j 不暴露",
    (value) => expect(normalizeComputerSandboxId(value)).toBeUndefined(),
  );
  it("只保留 phase 和本机配置 ID，丢弃凭据和错误对象", () => {
    expect(parseComputerServiceStateCommand({
      type: "computer-service-state", phase: "ready", sandboxId: "31",
      ticket: "secret", configKey: "secret", error: { secret: true }, userId: 99,
    })).toEqual({ type: "computer-service-state", phase: "ready", sandboxId: "31" });
  });
  it.each([null, "ready", {}, { type: "new-task", phase: "ready" },
    { type: "computer-service-state", phase: "" }, { type: "computer-service-state", phase: 1 },
    { type: "computer-service-state", phase: "ready", sandboxId: -1 },
    { type: "computer-service-state", phase: "ready", sandboxId: "-1" }])(
    "异常状态 %j 不覆盖最近有效快照",
    (value) => expect(parseComputerServiceStateCommand(value)).toBeNull(),
  );
});
