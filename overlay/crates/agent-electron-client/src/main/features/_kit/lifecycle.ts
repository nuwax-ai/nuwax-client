/**
 * 特性生命周期事件：登出/换域（会话结束）与应用退出。
 *
 * 特性在这里订阅，宿主在汇合点发出；任何一个回调抛错都不影响其他回调。
 */

export type SessionEndReason = "logout" | "switch-domain" | "other";

export interface FeatureLifecycle {
  onSessionEnd(listener: (reason: SessionEndReason) => void): () => void;
  onQuit(listener: () => void | Promise<void>): () => void;
  emitSessionEnd(reason: SessionEndReason): void;
  emitQuit(): Promise<void>;
}

export function createFeatureLifecycle(
  onListenerError: (error: unknown) => void = () => undefined,
): FeatureLifecycle {
  const sessionEnd = new Set<(reason: SessionEndReason) => void>();
  const quit = new Set<() => void | Promise<void>>();

  return {
    onSessionEnd(listener) {
      sessionEnd.add(listener);
      return () => {
        sessionEnd.delete(listener);
      };
    },
    onQuit(listener) {
      quit.add(listener);
      return () => {
        quit.delete(listener);
      };
    },
    emitSessionEnd(reason) {
      for (const listener of [...sessionEnd]) {
        try {
          listener(reason);
        } catch (error) {
          onListenerError(error);
        }
      }
    },
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
