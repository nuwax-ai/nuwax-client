/**
 * 会话建立阶段的恢复链路：memory → load → new，含插件隔离重试、进程重建与熔断。
 *
 * 纯逻辑：时钟、重建进程、隔离 home 与运行期状态全部经 deps 注入，各失败分支可用
 * 假计时器覆盖；真正的进程与文件操作在 AcpEngine 里实现（recycleForRecovery）。
 *
 * 超时只能做在宿主侧（SDK 待响应表私有，无法取消 RPC），所以硬超时后必须销毁
 * 引擎进程，再由新进程继续；在可能已卡死的连接上重试没有意义（2026-11-25 同事
 * 日志里 6 次回退 session/new 全部无响应）。
 *
 * 规格见 specs/session-setup-ha.md。
 */

import type { ComputerChatRequest } from "@shared/types/computerTypes";
import {
  isAcpSetupTimeoutError,
  withSetupTimeout,
  type AcpSetupBudgets,
} from "./acpSetupBudgets";
import { supportsLoadSession } from "./acpAgentCapabilities";
import type { NewSessionOpts } from "./acpNewSessionParams";
import {
  buildWorkDirAndProjectDir,
  isSessionIdCompatibleWithEngine,
  type AcpSessionLike,
  type SessionRestoredVia,
  type SessionSetupDeps,
} from "./acpSessionSetup";
import { rememberSessionRequestProject } from "./acpSessionWorkspace";

/** 建新会话继续时，说明为什么没能恢复原会话（随 /computer/chat 响应返回）。 */
export type SessionSetupFallbackReason =
  | "session_not_found"
  | "load_error"
  | "load_timeout"
  | "engine_env_reset";

/** 会话建立失败的原因（随 /computer/chat 响应的 fallback_reason 返回）。 */
export type SessionSetupFailureReason =
  | "engine_init_timeout"
  | "setup_timeout"
  | "engine_env_hang"
  | "quarantine_failed"
  | "setup_failed"
  | "engine_recycle_failed";

export type AcpEngineRecycleReason =
  | "load_timeout"
  | "new_timeout"
  | "home_quarantined"
  | "external_plugins_disabled"
  | "config_timeout"
  | "give_up";

export interface AcpEngineRecycleOptions {
  /** false = 只销毁（最终失败时收掉卡死的进程） */
  respawn: boolean;
  /** Retry in a fresh process without loading external plugins. */
  withoutExternalPlugins?: boolean;
  /**
   * 销毁之后、重启之前执行。隔离 home 必须放在这里：引擎进程还占着 home 里的文件
   * （Windows 上会让改名失败），而重启之后原路径又会被重新建出来。
   */
  beforeInit?: () => void | Promise<void>;
}

export type AcpEngineRecycleResult =
  | { ok: true }
  | { ok: false; error: string };

export type SessionHomeQuarantineFailure =
  | "disabled"
  | "not_persistent"
  | "unsupported_engine"
  | "shared"
  | "already_quarantined"
  | "machine_slow"
  | "rename_failed";

export type SessionHomeQuarantineResult =
  | { ok: true; home: string; backupPath: string }
  | { ok: false; reason: SessionHomeQuarantineFailure; error?: string };

/** 熔断时长：判为环境卡死后，该会话这段时间内直接返回错误。 */
export const SESSION_SETUP_BREAKER_MS = 5 * 60_000;

export interface SessionSetupBreaker {
  untilMs: number;
  reason: SessionSetupFailureReason;
}

/**
 * 恢复链路的进程内状态，重启清空。
 * - 恢复黑名单：硬超时过的 session_id 本次运行不再 load。
 * - 熔断：环境卡死的会话在到期前不再进链路。
 * - 隔离记录：每个 home 每次运行最多隔离一次。
 * - 超时记录：别的会话也超时过说明是机器级变慢，不隔离 home。
 */
export class SessionSetupRecoveryState {
  private readonly restoreBlacklist = new Set<string>();
  private readonly breakers = new Map<string, SessionSetupBreaker>();
  private readonly quarantinedHomes = new Set<string>();
  private readonly timeoutEngineKeys = new Set<string>();
  private readonly breakerTtlMs: number;

  constructor(options?: { breakerTtlMs?: number }) {
    this.breakerTtlMs = options?.breakerTtlMs ?? SESSION_SETUP_BREAKER_MS;
  }

  isRestoreBlacklisted(sessionId: string): boolean {
    return this.restoreBlacklist.has(sessionId);
  }

  blacklistRestore(sessionId: string): void {
    this.restoreBlacklist.add(sessionId);
  }

  getOpenBreaker(engineKey: string, now: number): SessionSetupBreaker | null {
    const breaker = this.breakers.get(engineKey);
    if (!breaker) return null;
    if (now >= breaker.untilMs) {
      this.breakers.delete(engineKey);
      return null;
    }
    return breaker;
  }

  openBreaker(
    engineKey: string,
    reason: SessionSetupFailureReason,
    now: number,
  ): SessionSetupBreaker {
    const breaker = { untilMs: now + this.breakerTtlMs, reason };
    this.breakers.set(engineKey, breaker);
    return breaker;
  }

  noteSetupTimeout(engineKey: string): void {
    this.timeoutEngineKeys.add(engineKey);
  }

  hasSetupTimeoutForOtherEngine(engineKey: string): boolean {
    for (const key of this.timeoutEngineKeys) {
      if (key !== engineKey) return true;
    }
    return false;
  }

  isHomeQuarantined(home: string): boolean {
    return this.quarantinedHomes.has(home);
  }

  markHomeQuarantined(home: string): void {
    this.quarantinedHomes.add(home);
  }

  reset(): void {
    this.restoreBlacklist.clear();
    this.breakers.clear();
    this.quarantinedHomes.clear();
    this.timeoutEngineKeys.clear();
  }
}

export const sessionSetupRecoveryState = new SessionSetupRecoveryState();

export interface SessionSetupReport {
  engineKey: string;
  prevSessionId?: string;
  setupPath: string;
  loadMs: number | null;
  newAttemptsMs: number[];
  recycleReasons: AcpEngineRecycleReason[];
  quarantined: boolean;
  /** 恢复超过了软超时仍在等待 */
  slowRestore: boolean;
  breakerOpened: boolean;
  totalMs: number;
}

export type SessionRecoveryResult =
  | {
      ok: true;
      session: AcpSessionLike;
      isNewSession: boolean;
      restoredVia: SessionRestoredVia;
      setupPath: string;
      fallbackReason?: SessionSetupFallbackReason;
      report: SessionSetupReport;
    }
  | {
      ok: false;
      reason: SessionSetupFailureReason;
      /** 面向日志的技术描述；给用户的文案按 reason 走 i18n */
      message: string;
      report: SessionSetupReport;
    };

export interface SessionRecoveryDeps extends SessionSetupDeps {
  engineKey: string;
  budgets: AcpSetupBudgets;
  /** 销毁引擎；respawn=true 时随后用原配置重启 */
  recycle(
    reason: AcpEngineRecycleReason,
    options: AcpEngineRecycleOptions,
  ): Promise<AcpEngineRecycleResult>;
  /** 隔离引擎 home；未提供视为不支持 */
  quarantineHome?(): SessionHomeQuarantineResult;
  /** 不做改名的前提下判断能否隔离；缺省同「是否提供 quarantineHome」 */
  canQuarantineHome?(): boolean;
  /** Only engines known to support a plugin-only recovery mode opt in. */
  canRetryWithoutExternalPlugins?(): boolean;
  state?: SessionSetupRecoveryState;
  now?: () => number;
  /** 链路起点（进入 /computer/chat 的时刻）；缺省取 now() */
  chainStartedAtMs?: number;
  onSlowRestore?: (info: { sessionId: string; softMs: number }) => void;
}

function findSessionInMemory(
  deps: Pick<
    SessionSetupDeps,
    "getSession" | "findSessionByProjectId"
  >,
  request: ComputerChatRequest,
): AcpSessionLike | undefined {
  if (request.session_id) {
    const byId = deps.getSession(request.session_id);
    if (byId) return byId;
  }
  // A2：仅按 conversationId（project_id）复用会话。不再按 agent_work_dir 匹配——
  // 否则同一常规项目下不同对话（同 devTargetId）会被归并到同一 session，
  // 触发抢占。cwd 仍按 agent_work_dir 共享（见 buildWorkDirAndProjectDir）。
  if (request.project_id) {
    const byProject = deps.findSessionByProjectId(request.project_id);
    if (byProject) return byProject;
  }
  return undefined;
}

/** load 报错时区分「会话不存在」与其他错误；引擎对缺失会话可能只回笼统的 service failure。 */
export function classifyLoadError(err: unknown): SessionSetupFallbackReason {
  const e = err as { code?: unknown; message?: unknown } | null;
  const message =
    e && typeof e === "object" && typeof e.message === "string"
      ? e.message
      : String(err);
  if (e?.code === -32002 || /resource not found|session not found/i.test(message)) {
    return "session_not_found";
  }
  return "load_error";
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 解析（或恢复）本次 chat 要用的会话。
 *
 * 每个请求最多经历三个引擎进程：
 * 1. 内存命中直接用。
 * 2. session/load：成功保留上下文；硬超时后支持安全模式的引擎跳过外部插件重试
 *    同一个会话。旧引擎沿用黑名单和新会话回退。
 * 3. session/new 超时：支持安全模式的引擎跳过外部插件重试；其他引擎沿用进程重建、
 *    可选 home 隔离与熔断。跳过插件后的消息必须由调用方要求用户确认。
 */
export async function resolveSessionWithRecovery(
  deps: SessionRecoveryDeps,
  request: ComputerChatRequest,
  sessionOptsExtras?: Pick<NewSessionOpts, "systemPrompt" | "requestId">,
): Promise<SessionRecoveryResult> {
  const now = deps.now ?? Date.now;
  const state = deps.state ?? sessionSetupRecoveryState;
  const { budgets } = deps;
  const startedAt = now();
  const deadlineAt =
    (deps.chainStartedAtMs ?? startedAt) + budgets.chainDeadlineMs;
  const remainingMs = () => deadlineAt - now();
  const stageBudget = (nominal: number) =>
    Math.max(0, Math.min(nominal, remainingMs()));

  const report: SessionSetupReport = {
    engineKey: deps.engineKey,
    prevSessionId: request.session_id,
    setupPath: "new",
    loadMs: null,
    newAttemptsMs: [],
    recycleReasons: [],
    quarantined: false,
    slowRestore: false,
    breakerOpened: false,
    totalMs: 0,
  };
  const finishReport = () => {
    report.totalMs = now() - startedAt;
    return report;
  };
  const succeed = (
    session: AcpSessionLike,
    isNewSession: boolean,
    restoredVia: SessionRestoredVia,
    setupPath: string,
    fallbackReason?: SessionSetupFallbackReason,
  ): SessionRecoveryResult => {
    report.setupPath = setupPath;
    if (restoredVia !== "memory") {
      session.projectId = request.project_id || request.agent_work_dir;
    }
    rememberSessionRequestProject(session, request.project_id);
    return {
      ok: true,
      session,
      isNewSession,
      restoredVia,
      setupPath,
      fallbackReason,
      report: finishReport(),
    };
  };
  const fail = async (
    reason: SessionSetupFailureReason,
    message: string,
    options?: { teardown?: boolean; breaker?: boolean },
  ): Promise<SessionRecoveryResult> => {
    if (options?.teardown) {
      await deps
        .recycle("give_up", { respawn: false })
        .catch(() => undefined);
      report.recycleReasons.push("give_up");
    }
    if (options?.breaker) {
      state.openBreaker(deps.engineKey, reason, now());
      report.breakerOpened = true;
    }
    return { ok: false, reason, message, report: finishReport() };
  };

  const memory = findSessionInMemory(deps, request);
  if (memory) {
    rememberSessionRequestProject(memory, request.project_id);
    return succeed(memory, false, "memory", "memory");
  }

  const breaker = state.getOpenBreaker(deps.engineKey, now());
  if (breaker) {
    report.setupPath = "breaker_open";
    return {
      ok: false,
      reason: breaker.reason,
      message: `session setup breaker open (${breaker.reason})`,
      report: finishReport(),
    };
  }

  const { workDirId, projectDir } = buildWorkDirAndProjectDir(deps, request);
  const sessionOpts: NewSessionOpts = {
    title: workDirId,
    cwd: projectDir,
    systemPrompt: sessionOptsExtras?.systemPrompt,
    requestId: sessionOptsExtras?.requestId,
  };

  let setupPath = "new";
  let fallbackReason: SessionSetupFallbackReason | undefined;
  let recycledInChain = false;
  let pluginsDisabledInChain = false;
  /**
   * 本链路里「足额预算内仍无响应」的次数。预算被总时限截短的超时不算数。
   * 两次及以上说明不是偶发变慢，收尾时开熔断。
   */
  let conclusiveTimeouts = 0;

  if (request.session_id && supportsLoadSession(deps.agentCapabilities)) {
    // 跨引擎：异形态 sessionId 直接跳过 load，避免发出无法取消的挂起 RPC
    const compatible = isSessionIdCompatibleWithEngine(
      request.session_id,
      deps.engineName,
    );
    if (!compatible) {
      setupPath = "skip_load→new";
    } else if (state.isRestoreBlacklisted(request.session_id)) {
      // 本次运行里恢复硬超时过：不再每条消息重付恢复成本
      setupPath = "blacklisted_load→new";
      fallbackReason = "load_timeout";
    } else {
      setupPath = "load";
      const loadBudget = stageBudget(budgets.loadHardMs);
      if (loadBudget <= 0) {
        return fail(
          "setup_timeout",
          "session setup deadline exceeded before load",
        );
      }
      const loadClipped = loadBudget < budgets.loadHardMs;
      const loadStart = now();
      try {
        const loaded = await withSetupTimeout(
          deps.loadSession(request.session_id, sessionOpts),
          {
            stage: "load",
            hardMs: loadBudget,
            softMs: budgets.loadSoftMs,
            onSoft: (info) => {
              report.slowRestore = true;
              deps.onSlowRestore?.({
                sessionId: request.session_id!,
                softMs: info.softMs,
              });
            },
          },
        );
        report.loadMs = now() - loadStart;
        return succeed(loaded, false, "load", "load");
      } catch (err) {
        report.loadMs = now() - loadStart;
        if (!isAcpSetupTimeoutError(err)) {
          fallbackReason = classifyLoadError(err);
          setupPath = "load_fail→new";
        } else if (loadClipped) {
          // 预算被链路时限截短，超时不足以判定卡死：收掉进程但不拉黑、不熔断
          return fail("setup_timeout", "session setup deadline exceeded during load", {
            teardown: true,
          });
        } else {
          conclusiveTimeouts++;
          state.noteSetupTimeout(deps.engineKey);
          if (deps.canRetryWithoutExternalPlugins?.()) {
            report.recycleReasons.push("external_plugins_disabled");
            const recycled = await deps.recycle("external_plugins_disabled", {
              respawn: true,
              withoutExternalPlugins: true,
            });
            if (!recycled.ok) {
              return fail("engine_recycle_failed", recycled.error);
            }
            const retryBudget = stageBudget(budgets.loadHardMs);
            if (retryBudget < budgets.minRetryMs) {
              return fail(
                "setup_timeout",
                "insufficient budget to restore without external plugins",
                { teardown: true },
              );
            }
            try {
              const restored = await withSetupTimeout(
                deps.loadSession(request.session_id, sessionOpts),
                { stage: "load", hardMs: retryBudget },
              );
              return succeed(
                restored, false, "load", "load_timeout→load_without_plugins",
              );
            } catch (retryError) {
              if (isAcpSetupTimeoutError(retryError)) {
                return fail(
                  retryBudget < budgets.loadHardMs ? "setup_timeout" : "engine_env_hang",
                  "session/load also timed out without external plugins",
                  { teardown: true, breaker: retryBudget >= budgets.loadHardMs },
                );
              }
              return fail("setup_failed", describeError(retryError), {
                teardown: true,
              });
            }
          }
          state.blacklistRestore(request.session_id);
          report.recycleReasons.push("load_timeout");
          const recycled = await deps.recycle("load_timeout", { respawn: true });
          if (!recycled.ok) {
            return fail("engine_recycle_failed", recycled.error);
          }
          recycledInChain = true;
          fallbackReason = "load_timeout";
          setupPath = "load_timeout→new";
        }
      }
    }
  } else if (request.session_id) {
    setupPath = "no_load_cap→new";
  }

  for (let attempt = 0; ; attempt++) {
    const newBudget = stageBudget(budgets.newSessionHardMs);
    // 首次尝试只要还有预算就发；重试则要求剩余足够跑完一次健康的新建会话
    if (newBudget <= 0 || (attempt > 0 && remainingMs() < budgets.minRetryMs)) {
      return fail("setup_timeout", "session setup deadline exceeded", {
        breaker: conclusiveTimeouts >= 2,
      });
    }
    const newClipped = newBudget < budgets.newSessionHardMs;
    const newStart = now();
    try {
      const created = await withSetupTimeout(deps.createSession(sessionOpts), {
        stage: "new",
        hardMs: newBudget,
      });
      report.newAttemptsMs.push(now() - newStart);
      const record = deps.getSessionRecord(created.id);
      if (!record) {
        return fail("setup_failed", "created session is not registered");
      }
      return succeed(record, true, "new", setupPath, fallbackReason);
    } catch (err) {
      report.newAttemptsMs.push(now() - newStart);
      if (!isAcpSetupTimeoutError(err)) {
        // 引擎有响应：不重建
        return fail("setup_failed", describeError(err));
      }
      if (newClipped) {
        // 预算被总时限截短：这次超时不算数，但此前已有两次足额超时则照样熔断
        return fail("setup_timeout", "session setup deadline exceeded", {
          teardown: true,
          breaker: conclusiveTimeouts >= 2,
        });
      }
      conclusiveTimeouts++;
      state.noteSetupTimeout(deps.engineKey);
      if (pluginsDisabledInChain) {
        return fail(
          "engine_env_hang",
          "session/new also timed out without external plugins",
          { teardown: true, breaker: conclusiveTimeouts >= 2 },
        );
      }
      if (deps.canRetryWithoutExternalPlugins?.()) {
        report.recycleReasons.push("external_plugins_disabled");
        const recycled = await deps.recycle("external_plugins_disabled", {
          respawn: true,
          withoutExternalPlugins: true,
        });
        if (!recycled.ok) {
          return fail("engine_recycle_failed", recycled.error);
        }
        pluginsDisabledInChain = true;
        recycledInChain = true;
        // A previous load error may have been caused by the same plugin setup.
        // Try the original session once more before creating a replacement.
        if (request.session_id && fallbackReason === "load_error") {
          const retryBudget = stageBudget(budgets.loadHardMs);
          if (retryBudget < budgets.minRetryMs) {
            return fail(
              "setup_timeout",
              "insufficient budget to restore without external plugins",
              { teardown: true },
            );
          }
          try {
            const restored = await withSetupTimeout(
              deps.loadSession(request.session_id, sessionOpts),
              { stage: "load", hardMs: retryBudget },
            );
            return succeed(
              restored, false, "load", "load_error→load_without_plugins",
            );
          } catch (retryError) {
            if (isAcpSetupTimeoutError(retryError)) {
              return fail(
                retryBudget < budgets.loadHardMs ? "setup_timeout" : "engine_env_hang",
                "session/load also timed out without external plugins",
                { teardown: true, breaker: retryBudget >= budgets.loadHardMs },
              );
            }
            fallbackReason = classifyLoadError(retryError);
          }
        }
        setupPath += "→new_without_plugins";
        continue;
      }
      if (!recycledInChain) {
        report.recycleReasons.push("new_timeout");
        const recycled = await deps.recycle("new_timeout", { respawn: true });
        if (!recycled.ok) {
          return fail("engine_recycle_failed", recycled.error);
        }
        recycledInChain = true;
        continue;
      }

      // 新进程里也建不出：环境级卡死
      let finalReason: SessionSetupFailureReason = "engine_env_hang";
      let finalMessage = "session/new timed out in a fresh engine process";
      const mayQuarantine =
        !!deps.quarantineHome &&
        !report.quarantined &&
        (deps.canQuarantineHome?.() ?? true);
      if (mayQuarantine) {
        report.recycleReasons.push("home_quarantined");
        // 用对象承载结果：赋值发生在回调里，TS 对普通变量做流 narrow 会把它当成 null
        const outcome: { quarantine: SessionHomeQuarantineResult | null } = {
          quarantine: null,
        };
        const recycled = await deps.recycle("home_quarantined", {
          respawn: true,
          beforeInit: () => {
            outcome.quarantine = deps.quarantineHome!();
          },
        });
        if (!recycled.ok) {
          return fail("engine_recycle_failed", recycled.error);
        }
        const { quarantine } = outcome;
        if (quarantine?.ok) {
          state.markHomeQuarantined(quarantine.home);
          report.quarantined = true;
          fallbackReason = "engine_env_reset";
          continue;
        }
        if (quarantine?.reason === "rename_failed") {
          finalReason = "quarantine_failed";
          finalMessage =
            quarantine.error ?? "failed to quarantine engine home";
        }
        // 其余不能隔离的原因：进程已重启，按环境卡死收尾
      }
      return fail(finalReason, finalMessage, { teardown: true, breaker: true });
    }
  }
}
