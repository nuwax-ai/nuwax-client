/** 宿主壳 `electronAPI.computerUse` 命名空间工厂；通道名与旧实现保持一致。 */
import type { IpcRenderer } from "electron";
import type { ComputerUseAPI } from "@shared/features/computer-use/contract";

export function createComputerUseBridge(
  ipc: Pick<IpcRenderer, "invoke">,
): ComputerUseAPI {
  return {
    getRuntime: () => ipc.invoke("cua:getRuntime"),
    pause: () => ipc.invoke("cua:pause"),
    resume: () => ipc.invoke("cua:resume"),
    stop: () => ipc.invoke("cua:stop"),
    recover: () => ipc.invoke("cua:recover"),
    selfTest: () => ipc.invoke("cua:selfTest"),
    exportDiagnostics: () => ipc.invoke("cua:exportDiagnostics"),
    clearHistory: () => ipc.invoke("cua:clearHistory"),
    listWindows: () => ipc.invoke("cua:listWindows"),
    setScope: (scope: Parameters<ComputerUseAPI["setScope"]>[0]) => ipc.invoke("cua:setScope", scope),
    getStatus: () => ipc.invoke("cua:getStatus"),
    setEnabled: (enabled: boolean) => ipc.invoke("cua:setEnabled", enabled),
    requestPermissions: () => ipc.invoke("cua:requestPermissions"),
    installHelper: () => ipc.invoke("cua:installHelper"),
    getVlmConfig: () => ipc.invoke("cua:getVlmConfig"),
    setVlmConfig: (patch: {
      clearApiKey?: boolean;
      baseUrl?: string;
      model?: string;
      apiKey?: string;
    }) => ipc.invoke("cua:setVlmConfig", patch),
    testVlm: () => ipc.invoke("cua:testVlm"),
  };
}
