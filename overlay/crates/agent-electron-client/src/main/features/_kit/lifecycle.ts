/**
 * 特性生命周期事件，由宿主在各汇合点发出；任何一个回调抛错都不影响其他回调。
 *
 * - sessionInvalidated：登录失效的第一时间同步通知，用于立即撤销对外能力（不等待队列）；
 * - servicesStarting：业务服务与 Agent 引擎启动前，宿主逐个等待；
 * - servicesStopping：随业务服务停止并行等待，任一失败计入停止结果；
 * - sessionEnd：登出/换域（会话结束）通知；
 * - quit：应用退出，逐个等待。
 */

export type SessionEndReason = "logout" | "switch-domain" | "other";

export interface FeatureLifecycle {
  onSessionInvalidated(listener: () => void): () => void;
  onServicesStarting(listener: (signal: AbortSignal) => Promise<void> | void): () => void;
  onServicesStopping(listener: () => Promise<void> | void): () => void;
  onSessionEnd(listener: (reason: SessionEndReason) => void): () => void;
  onQuit(listener: () => void | Promise<void>): () => void;
}

export interface FeatureLifecycleHost extends FeatureLifecycle {
  emitSessionInvalidated(): void;
  /** 顺序等待；signal 中止后不再调用后续监听者。抛错的监听者不阻断其余监听者。 */
  emitServicesStarting(signal: AbortSignal): Promise<void>;
  /** 并行等待；返回失败的监听者数量。 */
  emitServicesStopping(): Promise<number>;
  emitSessionEnd(reason: SessionEndReason): void;
  emitQuit(): Promise<void>;
}

export function createFeatureLifecycle(
  onListenerError: (error: unknown) => void = () => undefined,
): FeatureLifecycleHost {
  const invalidated = new Set<() => void>();
  const starting = new Set<(signal: AbortSignal) => Promise<void> | void>();
  const stopping = new Set<() => Promise<void> | void>();
  const sessionEnd = new Set<(reason: SessionEndReason) => void>();
  const quit = new Set<() => void | Promise<void>>();
  const subscribe = <T>(set: Set<T>, listener: T) => {
    set.add(listener);
    return () => { set.delete(listener); };
  };
  const notify = <A extends unknown[]>(set: Set<(...args: A) => void>, ...args: A) => {
    for (const listener of [...set]) {
      try {
        listener(...args);
      } catch (error) {
        onListenerError(error);
      }
    }
  };

  return {
    onSessionInvalidated: (listener) => subscribe(invalidated, listener),
    onServicesStarting: (listener) => subscribe(starting, listener),
    onServicesStopping: (listener) => subscribe(stopping, listener),
    onSessionEnd: (listener) => subscribe(sessionEnd, listener),
    onQuit: (listener) => subscribe(quit, listener),
    emitSessionInvalidated: () => notify(invalidated),
    async emitServicesStarting(signal) {
      for (const listener of [...starting]) {
        if (signal.aborted) return;
        try {
          await listener(signal);
        } catch (error) {
          onListenerError(error);
        }
      }
    },
    async emitServicesStopping() {
      const results = await Promise.allSettled([...stopping].map(async (listener) => listener()));
      let failed = 0;
      for (const result of results) {
        if (result.status === "rejected") {
          failed++;
          onListenerError(result.reason);
        }
      }
      return failed;
    },
    emitSessionEnd: (reason) => notify(sessionEnd, reason),
    async emitQuit() {
      for (const listener of [...quit]) {
        try {
          await listener();
        } catch (error) {
          onListenerError(error);
        }
      }
    },
  };
}
