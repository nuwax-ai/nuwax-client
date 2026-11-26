/**
 * 单元测试: sessionSetupDiagnostics — 会话建立结果的诊断缓冲
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  SESSION_SETUP_DIAGNOSTICS_MAX_RECORDS,
  clearSessionSetupDiagnosticsForTests,
  getSessionSetupDiagnostics,
  isNotableSessionSetupOutcome,
  recordSessionSetupOutcome,
  type SessionSetupDiagnosticInput,
} from "./sessionSetupDiagnostics";

function makeInput(
  overrides: Partial<SessionSetupDiagnosticInput> = {},
): SessionSetupDiagnosticInput {
  return {
    engineKey: "p1",
    projectId: "p1",
    sessionId: "ses_x",
    ok: false,
    reason: "engine_env_hang",
    setupPath: "new",
    loadMs: null,
    newAttemptsMs: [40_000, 40_000],
    recycled: ["new_timeout", "give_up"],
    quarantined: false,
    slowRestore: false,
    breakerOpened: true,
    totalMs: 85_000,
    ...overrides,
  };
}

describe("sessionSetupDiagnostics", () => {
  beforeEach(() => {
    clearSessionSetupDiagnosticsForTests();
  });

  it("健康的建立过程不进缓冲", () => {
    const healthy = makeInput({
      ok: true,
      reason: undefined,
      newAttemptsMs: [1_200],
      recycled: [],
      breakerOpened: false,
      totalMs: 1_200,
    });
    expect(isNotableSessionSetupOutcome(healthy)).toBe(false);
    recordSessionSetupOutcome(healthy);
    expect(getSessionSetupDiagnostics().records).toEqual([]);
  });

  it("失败、重建、隔离、慢恢复都留档，并带记录时间", () => {
    const at = new Date("2026-11-25T06:20:39.000Z");
    recordSessionSetupOutcome(makeInput(), at);
    recordSessionSetupOutcome(
      makeInput({ ok: true, reason: undefined, recycled: ["load_timeout"], fallbackReason: "load_timeout" }),
      at,
    );
    recordSessionSetupOutcome(
      makeInput({ ok: true, reason: undefined, quarantined: true, fallbackReason: "engine_env_reset" }),
      at,
    );
    recordSessionSetupOutcome(
      makeInput({ ok: true, reason: undefined, slowRestore: true }),
      at,
    );

    const { records, maxRecords } = getSessionSetupDiagnostics();
    expect(maxRecords).toBe(SESSION_SETUP_DIAGNOSTICS_MAX_RECORDS);
    expect(
      records.map((record) => [record.ok, record.reason ?? record.fallbackReason]),
    ).toEqual([
      [false, "engine_env_hang"],
      [true, "load_timeout"],
      [true, "engine_env_reset"],
      [true, undefined],
    ]);
    expect(records[0].at).toBe("2026-11-25T06:20:39.000Z");
    expect(records[0].recycled).toEqual(["new_timeout", "give_up"]);
  });

  it("只保留最近若干条", () => {
    for (let i = 0; i < SESSION_SETUP_DIAGNOSTICS_MAX_RECORDS + 5; i++) {
      recordSessionSetupOutcome(makeInput({ sessionId: `ses_${i}` }));
    }
    const { records } = getSessionSetupDiagnostics();
    expect(records).toHaveLength(SESSION_SETUP_DIAGNOSTICS_MAX_RECORDS);
    expect(records[0].sessionId).toBe("ses_5");
    expect(records.at(-1)!.sessionId).toBe(
      `ses_${SESSION_SETUP_DIAGNOSTICS_MAX_RECORDS + 4}`,
    );
  });

  it("快照与入参都是副本，事后改动不影响已留档的记录", () => {
    const attempts = [40_000];
    recordSessionSetupOutcome(makeInput({ newAttemptsMs: attempts }));
    attempts.push(99_999);
    const snapshot = getSessionSetupDiagnostics();
    snapshot.records[0].newAttemptsMs.push(1);
    expect(getSessionSetupDiagnostics().records[0].newAttemptsMs).toEqual([40_000]);
  });
});
