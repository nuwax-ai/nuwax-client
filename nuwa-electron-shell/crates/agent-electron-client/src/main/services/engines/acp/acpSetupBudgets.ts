/**
 * 会话建立阶段的统一预算与超时包装。
 *
 * 背景（2026-11-25 同事日志）：引擎在某个会话的目录级初始化处卡死后，只有
 * session/load 有 15s 超时，回退的 session/new、握手、模型同步都没有超时，
 * /computer/chat 一直挂到后端超时。这里把各阶段的等待上限集中成一处。
 *
 * 取值依据：
 * - load/new 都要等引擎连完 MCP 才返回（引擎侧连接上限 30s）；同事机器上健康的
 *   session/new 实测 23–26s，15s 会把健康恢复误判成失败。
 * - 整条恢复链路自 /computer/chat 进入起不超过 chainDeadlineMs，需低于后端调用
 *   超时（现观测不少于约 3.5 分钟，待后端确认）。
 *
 * 超时只能做在宿主侧：ACP SDK 的待响应表是私有的，无法取消已发出的 RPC。
 * 硬超时后调用方必须销毁引擎进程，否则迟到的响应会唤醒挂起的续体。
 */

export type AcpSetupBudgetName =
  | "loadSoftMs"
  | "loadHardMs"
  | "newSessionHardMs"
  | "pluginInstallHardMs"
  | "spawnHardMs"
  | "handshakeHardMs"
  | "configOptionHardMs"
  | "destroyHardMs"
  | "chainDeadlineMs"
  | "minRetryMs";

export type AcpSetupBudgets = Record<AcpSetupBudgetName, number>;

export const ACP_SETUP_DEFAULT_BUDGETS: AcpSetupBudgets = {
  /** 恢复超过该时长只告警，继续等到 loadHardMs */
  loadSoftMs: 15_000,
  loadHardMs: 40_000,
  newSessionHardMs: 40_000,
  /** 插件共享的 npm install；超时走既有的「失败不阻断启动」语义 */
  pluginInstallHardMs: 40_000,
  spawnHardMs: 10_000,
  /** ACP initialize 握手 */
  handshakeHardMs: 10_000,
  configOptionHardMs: 15_000,
  destroyHardMs: 12_000,
  chainDeadlineMs: 150_000,
  /** 链路剩余不足该值时不再重试 */
  minRetryMs: 20_000,
};

/** JSON 对象，字段同 AcpSetupBudgetName，单位 ms；供支持人员按机器调整。 */
export const ACP_SETUP_BUDGETS_ENV = "NUWAX_ACP_SETUP_BUDGETS";

const BUDGET_NAMES = Object.keys(ACP_SETUP_DEFAULT_BUDGETS) as AcpSetupBudgetName[];

export function resolveAcpSetupBudgets(
  env: NodeJS.ProcessEnv = process.env,
): AcpSetupBudgets {
  const budgets: AcpSetupBudgets = { ...ACP_SETUP_DEFAULT_BUDGETS };
  const raw = env[ACP_SETUP_BUDGETS_ENV]?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const name of BUDGET_NAMES) {
        const value = parsed[name];
        if (value === undefined) continue;
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
          throw new Error(`${name} must be a positive number`);
        }
        budgets[name] = Math.floor(value);
      }
    } catch (err) {
      // 非法配置回落默认值；日志在调用侧打，这里保持纯函数便于测试
      console.warn(
        `[AcpSetupBudgets] Ignoring invalid ${ACP_SETUP_BUDGETS_ENV}:`,
        err instanceof Error ? err.message : err,
      );
      return { ...ACP_SETUP_DEFAULT_BUDGETS };
    }
  }
  if (budgets.loadSoftMs > budgets.loadHardMs) {
    budgets.loadSoftMs = budgets.loadHardMs;
  }
  return budgets;
}

let cachedBudgets: AcpSetupBudgets | null = null;

/** 进程内缓存一份；env 在运行期不变。 */
export function getAcpSetupBudgets(): AcpSetupBudgets {
  if (!cachedBudgets) cachedBudgets = resolveAcpSetupBudgets();
  return cachedBudgets;
}

/** 测试用：清掉缓存。 */
export function resetAcpSetupBudgetsCacheForTests(): void {
  cachedBudgets = null;
}

export type AcpSetupStage = "load" | "new" | "config" | "handshake" | "destroy";

/**
 * 宿主侧超时错误的统一措辞。错误穿过服务层之后只剩 message 字符串
 * （"Failed to create engine …: handshake timed out after 10000ms"），
 * 上游靠 parseSetupTimeoutStage 认出它，所以格式只在这里定义。
 */
export function setupTimeoutMessage(stage: string, ms: number): string {
  return `${stage} timed out after ${ms}ms`;
}

const SETUP_TIMEOUT_MESSAGE_RE = /^(.+) timed out after \d+ms$/;

/** 从错误文案里取回超时的阶段名；不是超时文案时返回 null。 */
export function parseSetupTimeoutStage(message: string): string | null {
  const match = SETUP_TIMEOUT_MESSAGE_RE.exec(message.trim());
  return match ? match[1] : null;
}

export class AcpSetupTimeoutError extends Error {
  readonly stage: AcpSetupStage;
  readonly hardMs: number;

  constructor(stage: AcpSetupStage, hardMs: number) {
    super(setupTimeoutMessage(stage, hardMs));
    this.name = "AcpSetupTimeoutError";
    this.stage = stage;
    this.hardMs = hardMs;
  }
}

export function isAcpSetupTimeoutError(
  err: unknown,
): err is AcpSetupTimeoutError {
  return (
    err instanceof AcpSetupTimeoutError ||
    (err instanceof Error && err.name === "AcpSetupTimeoutError")
  );
}

export interface AcpSetupTimeoutOptions {
  stage: AcpSetupStage;
  /** 到点 reject AcpSetupTimeoutError；底层 promise 不被取消 */
  hardMs: number;
  /** 仅告警的软超时；到点调用 onSoft，不 reject */
  softMs?: number;
  onSoft?: (info: { stage: AcpSetupStage; softMs: number }) => void;
}

/**
 * 给建会话 RPC 加软/硬超时。硬超时后底层 promise 仍可能完成，调用方不得再消费
 * 其结果（进程已销毁，用代际号挡住续体）。
 */
export function withSetupTimeout<T>(
  promise: Promise<T>,
  options: AcpSetupTimeoutOptions,
): Promise<T> {
  const { stage, hardMs, softMs, onSoft } = options;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let softTimer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    const clearTimers = () => {
      if (softTimer !== undefined) clearTimeout(softTimer);
      if (hardTimer !== undefined) clearTimeout(hardTimer);
    };
    if (onSoft && softMs !== undefined && softMs < hardMs) {
      softTimer = setTimeout(() => {
        if (settled) return;
        try {
          onSoft({ stage, softMs });
        } catch {
          // 告警回调失败不影响等待
        }
      }, softMs);
    }
    hardTimer = setTimeout(
      () => {
        if (settled) return;
        settled = true;
        clearTimers();
        reject(new AcpSetupTimeoutError(stage, hardMs));
      },
      Math.max(0, hardMs),
    );
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimers();
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimers();
        reject(err);
      },
    );
  });
}
