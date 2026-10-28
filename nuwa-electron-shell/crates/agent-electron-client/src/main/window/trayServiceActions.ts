import type { AuthLifecycle, ServiceResult } from "@main/services/auth/lifecycle";

interface TrayServiceActionsDependencies {
  getCommercialLifecycle(): Pick<AuthLifecycle<unknown>, "start" | "stop"> | undefined;
  serviceManager: {
    restartAllServices(): Promise<ServiceResult>;
    stopAllServices(): Promise<ServiceResult>;
  };
  updateServicesStatus(running: boolean): void;
  setErrorStatus(): void;
}

/** 独立接线使托盘操作可在不启动 Electron main 的情况下验证。 */
export function createTrayServiceActions(deps: TrayServiceActionsDependencies) {
  let latestOperation = 0;
  const run = async (
    running: boolean,
    operation: () => Promise<ServiceResult>,
  ): Promise<void> => {
    const operationId = ++latestOperation;
    try {
      const result = await operation();
      if (!result.success)
        throw new Error(result.error || (running ? "Service restart failed" : "Service stop failed"));
      // 新停止操作会撤销旧启动；旧结果不能覆盖较新的托盘状态。
      if (operationId === latestOperation) deps.updateServicesStatus(running);
    } catch (error) {
      if (operationId === latestOperation) deps.setErrorStatus();
      throw error;
    }
  };

  return {
    onRestartServices: (): Promise<void> => run(true, () => {
      // IPC 注册可能晚于托盘创建，因此每次操作读取当前唯一实例。
      const lifecycle = deps.getCommercialLifecycle();
      return lifecycle ? lifecycle.start(true) : deps.serviceManager.restartAllServices();
    }),
    onStopServices: (): Promise<void> => run(false, () => {
      const lifecycle = deps.getCommercialLifecycle();
      return lifecycle ? lifecycle.stop() : deps.serviceManager.stopAllServices();
    }),
  };
}
