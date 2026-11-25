/**
 * 单元测试: acpSessionRecovery — 会话建立阶段的恢复链路
 *
 * 覆盖 specs/session-setup-ha.md 的恢复链路与失败分支：
 * - 内存命中 / load 成功 / load 报错回退 / 形态不兼容跳过 load
 * - 慢恢复（软超时后成功，保留上下文）
 * - load 硬超时 → 重建进程 → 建新会话；该 session_id 进黑名单
 * - session/new 超时 → 重建后重试；新进程仍超时 → 隔离 home → 仍失败 → 熔断
 * - 链路总时限、非超时错误、重建失败
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ComputerChatRequest } from "@shared/types/computerTypes";
import {
  ACP_SETUP_DEFAULT_BUDGETS,
  type AcpSetupBudgets,
} from "./acpSetupBudgets";
import type { NewSessionOpts } from "./acpNewSessionParams";
import {
  SessionSetupRecoveryState,
  classifyLoadError,
  resolveSessionWithRecovery,
  type AcpSessionLike,
  type SessionRecoveryDeps,
} from "./acpSessionRecovery";

function defaultBudgets(): AcpSetupBudgets {
  return ACP_SETUP_DEFAULT_BUDGETS;
}

function makeSession(
  id: string,
  overrides: Partial<AcpSessionLike> = {},
): AcpSessionLike {
  return {
    id,
    acpSessionId: id,
    createdAt: Date.now(),
    status: "idle",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<SessionRecoveryDeps> = {}) {
  const sessions = new Map<string, AcpSessionLike>();
  const state = new SessionSetupRecoveryState();
  const deps: SessionRecoveryDeps = {
    logTag: "[test]",
    // 默认按 nuwaxcode 测 load；跨引擎用例会覆盖 engineName
    engineKey: "p1",
    engineName: "nuwaxcode",
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { resume: {} },
    },
    budgets: { ...ACP_SETUP_DEFAULT_BUDGETS } as AcpSetupBudgets,
    workspaceDir: "/workspace",
    state,
    now: Date.now,
    getSession: (id) => sessions.get(id),
    findSessionByProjectId: (pid) => {
      for (const s of sessions.values()) {
        if (s.projectId === pid || s.id === pid) return s;
      }
      return null;
    },
    loadSession: vi.fn(async (sessionId, opts) => {
      const s = makeSession(sessionId, {
        title: opts.title,
        cwd: opts.cwd,
        projectId: opts.title,
      });
      sessions.set(sessionId, s);
      return s;
    }),
    createSession: vi.fn(async (opts) => {
      const id = "new-session-id";
      sessions.set(id, makeSession(id, { title: opts.title, cwd: opts.cwd }));
      return { id };
    }),
    getSessionRecord: (id) => sessions.get(id)!,
    recycle: vi.fn(async () => ({ ok: true as const })),
    ...overrides,
  };
  return deps;
}

function request(
  overrides: Partial<ComputerChatRequest> = {},
): ComputerChatRequest {
  return { user_id: "u1", project_id: "p1", prompt: "hi", ...overrides };
}

/** 永不 settle 的 promise，模拟引擎无响应 */
function hang(): Promise<never> {
  return new Promise<never>(() => {});
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const OPENCODE_SES = "ses_010f31944ffe3OywvJ8AmMo0lT";
const CLAUDE_UUID = "41c20e6b-f7df-4a9f-beea-cd375bc320eb";

describe("resolveSessionWithRecovery · 健康路径", () => {
  it.each(["new", "load", "memory"])(
    "%s 路径按 conversationId 归一 session.projectId，绝对路径 agent_work_dir 不再覆盖",
    async (mode) => {
      // A2：session.projectId 主维度为 conversationId(project_id)。
      const existing = makeSession("ses_current", {
        projectId: "1694106",
        cwd: "/workspace/current",
      });
      const deps = makeDeps({
        ...(mode === "memory" ? { getSession: () => existing } : {}),
      });
      const result = await resolveSessionWithRecovery(
        deps,
        request({
          project_id: "1694106",
          agent_work_dir: "/workspace/current",
          ...(mode !== "new" ? { session_id: "ses_current" } : {}),
        }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.restoredVia).toBe(mode);
      expect(result.session.projectId).toBe("1694106");
      expect(result.session).toHaveProperty("requestProjectIds", ["1694106"]);
      expect(result.fallbackReason).toBeUndefined();
      expect(deps.recycle).not.toHaveBeenCalled();
    },
  );

  it("reuses session from memory by session_id", async () => {
    const existing = makeSession("sess-1");
    const deps = makeDeps({ getSession: () => existing });

    const result = await resolveSessionWithRecovery(
      deps,
      request({ session_id: "sess-1" }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.restoredVia).toBe("memory");
    expect(result.isNewSession).toBe(false);
    expect(deps.loadSession).not.toHaveBeenCalled();
    expect(deps.createSession).not.toHaveBeenCalled();
    expect(deps.recycle).not.toHaveBeenCalled();
  });

  it("calls loadSession when memory miss and agent supports load (nuwaxcode ses_*)", async () => {
    const deps = makeDeps();

    const result = await resolveSessionWithRecovery(
      deps,
      request({ session_id: OPENCODE_SES }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.restoredVia).toBe("load");
    expect(result.isNewSession).toBe(false);
    expect(deps.loadSession).toHaveBeenCalledWith(
      OPENCODE_SES,
      expect.objectContaining({ cwd: expect.any(String) }),
    );
    expect(deps.createSession).not.toHaveBeenCalled();
  });

  it("skips loadSession when Claude UUID is passed to nuwaxcode", async () => {
    const deps = makeDeps({ engineName: "nuwaxcode" });

    const result = await resolveSessionWithRecovery(
      deps,
      request({ session_id: CLAUDE_UUID }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.restoredVia).toBe("new");
    expect(result.isNewSession).toBe(true);
    expect(result.setupPath).toBe("skip_load→new");
    // 形态已知不可恢复：不是「没能恢复」，不算降级
    expect(result.fallbackReason).toBeUndefined();
    expect(deps.loadSession).not.toHaveBeenCalled();
    expect(deps.createSession).toHaveBeenCalled();
  });

  it("skips loadSession when OpenCode ses_* is passed to claude-code", async () => {
    const deps = makeDeps({ engineName: "claude-code" });

    const result = await resolveSessionWithRecovery(
      deps,
      request({ session_id: OPENCODE_SES }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.restoredVia).toBe("new");
    expect(result.isNewSession).toBe(true);
    expect(deps.loadSession).not.toHaveBeenCalled();
    expect(deps.createSession).toHaveBeenCalled();
  });

  it("falls back to newSession when agent does not support loadSession", async () => {
    const deps = makeDeps({
      agentCapabilities: { sessionCapabilities: { resume: {} } },
    });

    const result = await resolveSessionWithRecovery(
      deps,
      request({ session_id: "ses_supported-but-caps-off" }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.restoredVia).toBe("new");
    expect(result.isNewSession).toBe(true);
    expect(result.setupPath).toBe("no_load_cap→new");
    expect(deps.loadSession).not.toHaveBeenCalled();
    expect(deps.createSession).toHaveBeenCalled();
  });

  it("creates new session when no session_id", async () => {
    const deps = makeDeps();

    const result = await resolveSessionWithRecovery(deps, request());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.restoredVia).toBe("new");
    expect(result.isNewSession).toBe(true);
    expect(deps.loadSession).not.toHaveBeenCalled();
    expect(deps.createSession).toHaveBeenCalled();
  });
});

describe("resolveSessionWithRecovery · load 失败", () => {
  it("loadSession 报错时回退新会话，并带上 load_error", async () => {
    const deps = makeDeps({
      agentCapabilities: { loadSession: true },
      loadSession: vi.fn(async () => {
        throw new Error("load failed");
      }),
    });

    const result = await resolveSessionWithRecovery(
      deps,
      request({ session_id: "ses_old-sess" }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.restoredVia).toBe("new");
    expect(result.isNewSession).toBe(true);
    expect(result.setupPath).toBe("load_fail→new");
    expect(result.fallbackReason).toBe("load_error");
    expect(deps.recycle).not.toHaveBeenCalled();
  });

  it("会话不存在（Resource not found）时回退新会话，fallback_reason 为 session_not_found", async () => {
    const notFound = Object.assign(new Error("Resource not found"), {
      code: -32002,
    });
    const deps = makeDeps({
      loadSession: vi.fn(async () => {
        throw notFound;
      }),
    });

    const result = await resolveSessionWithRecovery(
      deps,
      request({ session_id: "ses_missing" }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.restoredVia).toBe("new");
    expect(result.fallbackReason).toBe("session_not_found");
  });

  it("classifyLoadError 只把明确的 not found 归为 session_not_found", () => {
    expect(classifyLoadError({ code: -32002 })).toBe("session_not_found");
    expect(classifyLoadError(new Error("Session not found: ses_x"))).toBe(
      "session_not_found",
    );
    expect(
      classifyLoadError(new Error("Internal error: OpenCode service failure")),
    ).toBe("load_error");
    expect(classifyLoadError("boom")).toBe("load_error");
  });
});

describe("resolveSessionWithRecovery · 慢恢复与健康阈值（S1）", () => {
  it("load 超过软超时只告警并继续等；硬上限内返回则保留上下文", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      deps.onSlowRestore = vi.fn();
      deps.loadSession = vi.fn(
        (_id: string, opts: NewSessionOpts) =>
          new Promise((resolve) => {
            setTimeout(
              () => resolve(makeSession("ses_slow", { cwd: opts.cwd })),
              deps.budgets.loadSoftMs + 10_000,
            );
          }),
      );

      const pending = resolveSessionWithRecovery(
        deps,
        request({ session_id: "ses_slow" }),
      );
      await vi.advanceTimersByTimeAsync(deps.budgets.loadSoftMs + 1);

      expect(deps.onSlowRestore).toHaveBeenCalledTimes(1);
      expect(deps.onSlowRestore).toHaveBeenCalledWith({
        sessionId: "ses_slow",
        softMs: deps.budgets.loadSoftMs,
      });

      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.restoredVia).toBe("load");
      expect(result.session.id).toBe("ses_slow");
      expect(result.fallbackReason).toBeUndefined();
      expect(result.report.slowRestore).toBe(true);
      expect(deps.recycle).not.toHaveBeenCalled();
      expect(deps.createSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("软超时之前返回不告警", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      deps.onSlowRestore = vi.fn();
      deps.loadSession = vi.fn(
        (_id: string, opts: NewSessionOpts) =>
          new Promise((resolve) => {
            setTimeout(
              () => resolve(makeSession("ses_fast", { cwd: opts.cwd })),
              deps.budgets.loadSoftMs - 1,
            );
          }),
      );

      const pending = resolveSessionWithRecovery(
        deps,
        request({ session_id: "ses_fast" }),
      );
      await vi.advanceTimersByTimeAsync(deps.budgets.loadSoftMs);
      const result = await pending;

      expect(result.ok).toBe(true);
      expect(deps.onSlowRestore).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("resolveSessionWithRecovery · 卡死与恢复（S3/S4/S6）", () => {
  it("load 硬超时：重建进程后建新会话，该 session_id 进黑名单", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps({ loadSession: vi.fn(hang) });

      const pending = resolveSessionWithRecovery(
        deps,
        request({ session_id: "ses_hung" }),
      );
      await vi.advanceTimersByTimeAsync(deps.budgets.loadHardMs - 1);
      // 硬上限之前不做任何处置
      expect(deps.recycle).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;

      expect(deps.recycle).toHaveBeenCalledTimes(1);
      expect(deps.recycle).toHaveBeenCalledWith("load_timeout", {
        respawn: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.restoredVia).toBe("new");
      expect(result.isNewSession).toBe(true);
      expect(result.setupPath).toBe("load_timeout→new");
      expect(result.fallbackReason).toBe("load_timeout");
      expect(deps.state!.isRestoreBlacklisted("ses_hung")).toBe(true);
      expect(deps.state!.getOpenBreaker("p1", Date.now())).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("进黑名单的 session_id 不再 load，直接建新会话", async () => {
    const deps = makeDeps({ loadSession: vi.fn(hang) });
    deps.state!.blacklistRestore("ses_hung");

    const result = await resolveSessionWithRecovery(
      deps,
      request({ session_id: "ses_hung", project_id: "p-other" }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.setupPath).toBe("blacklisted_load→new");
    expect(result.fallbackReason).toBe("load_timeout");
    expect(deps.loadSession).not.toHaveBeenCalled();
    expect(deps.createSession).toHaveBeenCalledTimes(1);
    expect(deps.recycle).not.toHaveBeenCalled();
  });

  it("session/new 超时：重建进程后重试一次，成功则继续", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps({
        createSession: vi
          .fn()
          .mockImplementationOnce(hang)
          .mockImplementationOnce(async () => ({ id: "new-after-recycle" })),
        getSessionRecord: () => makeSession("new-after-recycle"),
      });

      const pending = resolveSessionWithRecovery(deps, request());
      await vi.advanceTimersByTimeAsync(deps.budgets.newSessionHardMs);
      await flush();
      const result = await pending;

      expect(deps.recycle).toHaveBeenCalledTimes(1);
      expect(deps.recycle).toHaveBeenCalledWith("new_timeout", {
        respawn: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.session.id).toBe("new-after-recycle");
      expect(result.report.recycleReasons).toEqual(["new_timeout"]);
      // 全新会话本来就没有可恢复的上下文，不算降级
      expect(result.fallbackReason).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("新进程里仍建不出会话：收掉进程、开熔断，返回 engine_env_hang", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps({ createSession: vi.fn(hang) });

      const pending = resolveSessionWithRecovery(deps, request());
      await vi.advanceTimersByTimeAsync(deps.budgets.newSessionHardMs);
      await flush();
      await vi.advanceTimersByTimeAsync(deps.budgets.newSessionHardMs);
      const result = await pending;

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("engine_env_hang");
      expect(result.report.breakerOpened).toBe(true);
      expect(deps.recycle).toHaveBeenCalledTimes(2);
      expect(deps.recycle).toHaveBeenNthCalledWith(1, "new_timeout", {
        respawn: true,
      });
      expect(deps.recycle).toHaveBeenNthCalledWith(2, "give_up", {
        respawn: false,
      });
      expect(deps.createSession).toHaveBeenCalledTimes(2);
      expect(deps.state!.getOpenBreaker("p1", Date.now())).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("熔断期内不进链路；到期后自动再试", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps({ createSession: vi.fn(hang) });
      const first = resolveSessionWithRecovery(deps, request());
      await vi.advanceTimersByTimeAsync(2 * deps.budgets.newSessionHardMs);
      expect((await first).ok).toBe(false);
      expect(deps.createSession).toHaveBeenCalledTimes(2);

      const blocked = await resolveSessionWithRecovery(deps, request());
      expect(blocked.ok).toBe(false);
      if (blocked.ok) return;
      expect(blocked.reason).toBe("engine_env_hang");
      expect(blocked.report.setupPath).toBe("breaker_open");
      expect(deps.createSession).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(deps.state!.getOpenBreaker("p1", Date.now())).toBeNull();
      const retried = resolveSessionWithRecovery(deps, request());
      await vi.advanceTimersByTimeAsync(2 * deps.budgets.newSessionHardMs);
      expect((await retried).ok).toBe(false);
      expect(deps.createSession).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("引擎不支持隔离时，load 硬超时后的新建再超时直接判环境卡死", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps({
        loadSession: vi.fn(hang),
        createSession: vi.fn(hang),
      });

      const pending = resolveSessionWithRecovery(
        deps,
        request({ session_id: "ses_hung" }),
      );
      await vi.advanceTimersByTimeAsync(deps.budgets.loadHardMs);
      await flush();
      await vi.advanceTimersByTimeAsync(deps.budgets.newSessionHardMs);
      const result = await pending;

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("engine_env_hang");
      // load 超时已重建过一次，新进程里再超时不再重复重建
      expect(deps.recycle).toHaveBeenNthCalledWith(1, "load_timeout", {
        respawn: true,
      });
      expect(deps.recycle).toHaveBeenNthCalledWith(2, "give_up", {
        respawn: false,
      });
      expect(deps.recycle).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("隔离 home 后重启再试一次，成功则标记 engine_env_reset", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps({
        createSession: vi
          .fn()
          .mockImplementationOnce(hang)
          .mockImplementationOnce(hang)
          .mockImplementationOnce(async () => ({ id: "new-after-reset" })),
        quarantineHome: vi.fn(() => ({
          ok: true as const,
          home: "/run/projects/u1/p1/nuwaxcode/home",
          backupPath:
            "/run/projects/u1/p1/nuwaxcode/home.quarantine-20261125120000",
        })),
        getSessionRecord: () => makeSession("new-after-reset"),
      });

      const pending = resolveSessionWithRecovery(deps, request());
      await vi.advanceTimersByTimeAsync(deps.budgets.newSessionHardMs);
      await flush();
      await vi.advanceTimersByTimeAsync(deps.budgets.newSessionHardMs);
      const result = await pending;

      expect(deps.quarantineHome).toHaveBeenCalledTimes(1);
      expect(deps.recycle).toHaveBeenNthCalledWith(2, "home_quarantined", {
        respawn: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.session.id).toBe("new-after-reset");
      expect(result.fallbackReason).toBe("engine_env_reset");
      expect(result.report.quarantined).toBe(true);
      expect(
        deps.state!.isHomeQuarantined(
          "/run/projects/u1/p1/nuwaxcode/home",
        ),
      ).toBe(true);
      expect(deps.state!.getOpenBreaker("p1", Date.now())).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("隔离改名失败：返回 quarantine_failed 并熔断", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps({
        createSession: vi.fn(hang),
        quarantineHome: vi.fn(() => ({
          ok: false as const,
          reason: "rename_failed" as const,
          error: "EPERM: operation not permitted, rename",
        })),
      });

      const pending = resolveSessionWithRecovery(deps, request());
      await vi.advanceTimersByTimeAsync(deps.budgets.newSessionHardMs);
      await flush();
      await vi.advanceTimersByTimeAsync(deps.budgets.newSessionHardMs);
      const result = await pending;

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("quarantine_failed");
      expect(result.message).toBe("EPERM: operation not permitted, rename");
      expect(result.report.breakerOpened).toBe(true);
      expect(deps.recycle).toHaveBeenLastCalledWith("give_up", {
        respawn: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("home 被其他引擎共用等原因不能隔离时，按环境卡死处理", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps({
        createSession: vi.fn(hang),
        quarantineHome: vi.fn(() => ({
          ok: false as const,
          reason: "shared" as const,
        })),
      });

      const pending = resolveSessionWithRecovery(deps, request());
      await vi.advanceTimersByTimeAsync(deps.budgets.newSessionHardMs);
      await flush();
      await vi.advanceTimersByTimeAsync(deps.budgets.newSessionHardMs);
      const result = await pending;

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("engine_env_hang");
      expect(deps.recycle).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("createSession 返回非超时错误：不重建、不熔断", async () => {
    const deps = makeDeps({
      createSession: vi.fn(async () => {
        throw new Error("Invalid params: mcpServers");
      }),
    });

    const result = await resolveSessionWithRecovery(deps, request());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("setup_failed");
    expect(result.message).toBe("Invalid params: mcpServers");
    expect(deps.recycle).not.toHaveBeenCalled();
    expect(deps.state!.getOpenBreaker("p1", Date.now())).toBeNull();
  });

  it("重建失败：返回 engine_recycle_failed，不熔断", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps({
        createSession: vi.fn(hang),
        recycle: vi.fn(async () => ({
          ok: false as const,
          error: "engine destroy did not finish",
        })),
      });

      const pending = resolveSessionWithRecovery(deps, request());
      await vi.advanceTimersByTimeAsync(deps.budgets.newSessionHardMs);
      const result = await pending;

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("engine_recycle_failed");
      expect(result.message).toBe("engine destroy did not finish");
      expect(deps.state!.getOpenBreaker("p1", Date.now())).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("resolveSessionWithRecovery · 链路总时限", () => {
  it("时限已过：不发任何 RPC，直接返回 setup_timeout", async () => {
    const deps = makeDeps({
      chainStartedAtMs: Date.now() - defaultBudgets().chainDeadlineMs - 1,
    });

    const result = await resolveSessionWithRecovery(
      deps,
      request({ session_id: OPENCODE_SES }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("setup_timeout");
    expect(deps.loadSession).not.toHaveBeenCalled();
    expect(deps.createSession).not.toHaveBeenCalled();
    expect(deps.recycle).not.toHaveBeenCalled();
  });

  it("load 预算被时限截短后超时：收掉进程，但不拉黑、不熔断", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      const deps = makeDeps({
        loadSession: vi.fn(hang),
        chainStartedAtMs:
          now - (defaultBudgets().chainDeadlineMs - 10_000),
      });

      const pending = resolveSessionWithRecovery(
        deps,
        request({ session_id: "ses_clipped" }),
      );
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("setup_timeout");
      expect(deps.recycle).toHaveBeenCalledWith("give_up", { respawn: false });
      expect(deps.recycle).toHaveBeenCalledTimes(1);
      expect(deps.state!.isRestoreBlacklisted("ses_clipped")).toBe(false);
      expect(deps.state!.getOpenBreaker("p1", Date.now())).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("首次 new 超时后剩余不足以再跑一次：不再重试", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      const budgets = defaultBudgets();
      const deps = makeDeps({
        createSession: vi.fn(hang),
        chainStartedAtMs: now - (budgets.chainDeadlineMs - 55_000),
      });

      const pending = resolveSessionWithRecovery(deps, request());
      await vi.advanceTimersByTimeAsync(budgets.newSessionHardMs);
      await flush();
      const result = await pending;

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("setup_timeout");
      expect(deps.createSession).toHaveBeenCalledTimes(1);
      expect(deps.recycle).toHaveBeenCalledTimes(1);
      expect(deps.state!.getOpenBreaker("p1", Date.now())).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("resolveSessionWithRecovery · 同项目多对话并行（A2 回归）", () => {
  function makeParallelDeps() {
    const sessions = new Map<string, AcpSessionLike>();
    let seq = 0;
    return makeDeps({
      getSession: (id) => sessions.get(id),
      findSessionByProjectId: (pid) => {
        for (const s of sessions.values()) {
          if (s.projectId === pid || s.id === pid) return s;
        }
        return null;
      },
      createSession: vi.fn(async (opts: { title?: string; cwd?: string }) => {
        const id = `sess-${++seq}`;
        sessions.set(id, makeSession(id, { title: opts.title, cwd: opts.cwd }));
        return { id };
      }),
      getSessionRecord: (id) => sessions.get(id)!,
    });
  }

  const npRequest = (projectId: string) =>
    request({
      project_id: projectId,
      agent_work_dir: "272",
      service_type: "computer-normal-project",
    });

  it("同 agent_work_dir、不同 conversationId → 各自独立 session，不跨对话复用", async () => {
    const deps = makeParallelDeps();

    const a = await resolveSessionWithRecovery(deps, npRequest("1728392"));
    const b = await resolveSessionWithRecovery(deps, npRequest("1728395"));

    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.isNewSession).toBe(true);
    expect(b.isNewSession).toBe(true);
    expect(a.session.id).not.toBe(b.session.id);
    expect(a.session.projectId).toBe("1728392");
    expect(b.session.projectId).toBe("1728395");
    // cwd 仍按 agent_work_dir 共享同一工作目录（同项目共享目录是正确语义）
    expect(a.session.cwd).toBe(b.session.cwd);
    expect(deps.createSession).toHaveBeenCalledTimes(2);
  });

  it("同对话（同 conversationId）二次请求复用既有 session，不新建", async () => {
    const deps = makeParallelDeps();

    const first = await resolveSessionWithRecovery(
      deps,
      npRequest("1728392"),
    );
    const second = await resolveSessionWithRecovery(
      deps,
      npRequest("1728392"),
    );

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.isNewSession).toBe(true);
    expect(second.restoredVia).toBe("memory");
    expect(second.session.id).toBe(first.session.id);
    expect(deps.createSession).toHaveBeenCalledTimes(1);
  });
});

describe("SessionSetupRecoveryState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("熔断到期后自动解除", () => {
    const state = new SessionSetupRecoveryState({ breakerTtlMs: 1_000 });
    state.openBreaker("p1", "engine_env_hang", Date.now());
    expect(state.getOpenBreaker("p1", Date.now())?.reason).toBe(
      "engine_env_hang",
    );
    vi.advanceTimersByTime(999);
    expect(state.getOpenBreaker("p1", Date.now())).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(state.getOpenBreaker("p1", Date.now())).toBeNull();
  });

  it("只有别的引擎也超时过，才算机器级变慢", () => {
    const state = new SessionSetupRecoveryState();
    expect(state.hasSetupTimeoutForOtherEngine("p1")).toBe(false);
    state.noteSetupTimeout("p1");
    expect(state.hasSetupTimeoutForOtherEngine("p1")).toBe(false);
    state.noteSetupTimeout("p2");
    expect(state.hasSetupTimeoutForOtherEngine("p1")).toBe(true);
  });

  it("reset 清空全部运行期状态", () => {
    const state = new SessionSetupRecoveryState();
    state.blacklistRestore("ses_x");
    state.openBreaker("p1", "engine_env_hang", Date.now());
    state.markHomeQuarantined("/h");
    state.noteSetupTimeout("p1");
    state.reset();
    expect(state.isRestoreBlacklisted("ses_x")).toBe(false);
    expect(state.getOpenBreaker("p1", Date.now())).toBeNull();
    expect(state.isHomeQuarantined("/h")).toBe(false);
    expect(state.hasSetupTimeoutForOtherEngine("p2")).toBe(false);
  });
});
