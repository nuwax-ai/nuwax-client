/**
 * 受信 IPC：统一的 sender 校验入口。
 *
 * 特性只描述「谁能调用」之外的业务；调用方是否受信（受信顶层业务页、主 frame、
 * 当前文档）由宿主注入的 `isTrusted` 判定，集中在这一处，特性代码里不再各写各的。
 * 不受信的调用得到约定的兜底结果，且处理函数**不会被执行**。
 */

export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

export interface TrustedIpc {
  /**
   * 注册一个只对受信 sender 生效的 invoke 通道。
   * @param untrustedResult 不受信调用得到的结果（处理函数不会被执行）
   */
  handle<E, A extends unknown[], R>(
    channel: string,
    handler: (event: E, ...args: A) => R | Promise<R>,
    untrustedResult: R,
  ): void;
  /** 移除本实例注册过的全部通道。 */
  dispose(): void;
}

export function createTrustedIpc<E>(
  ipcMain: IpcMainLike,
  isTrusted: (event: E) => boolean,
): TrustedIpc {
  const registered = new Set<string>();

  return {
    handle(channel, handler, untrustedResult) {
      if (registered.has(channel)) {
        throw new Error(`IPC channel already registered by this feature: ${channel}`);
      }
      registered.add(channel);
      ipcMain.handle(channel, (event: unknown, ...args: unknown[]) => {
        if (!isTrusted(event as E)) return untrustedResult;
        // handler 的 E / A 是 handle 方法自己的泛型参数，与工厂的 E 无关；经 unknown 转换避免 TS2352
        return (handler as unknown as (event: E, ...args: unknown[]) => unknown)(event as E, ...args);
      });
    },
    dispose() {
      for (const channel of registered) ipcMain.removeHandler(channel);
      registered.clear();
    },
  };
}
