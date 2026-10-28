/** 宿主壳 `electronAPI.computerUse` 命名空间工厂；通道名与旧实现保持一致。 */
import type { IpcRenderer } from "electron";
import type { ComputerUseAPI } from "@shared/features/computer-use/contract";

export function createComputerUseBridge(
  ipc: Pick<IpcRenderer, "invoke">,
): ComputerUseAPI {
  return {
    getTaskHistory: () => ipc.invoke("cua:getTaskHistory"),
    clearTaskHistory: () => ipc.invoke("cua:clearTaskHistory"),
    showTaskPreview: (id) => ipc.invoke("cua:showTaskPreview", id),
    takeOver: () => ipc.invoke("cua:takeOver"),
    takeOverTask: (id) => ipc.invoke("cua:takeOverTask", id),
    getTasks: () => ipc.invoke("cua:getTasks"),
    bindTarget: (id, target) => ipc.invoke("cua:bindTarget", id, target),
    pauseTask: (id) => ipc.invoke("cua:pauseTask", id),
    resumeTask: (id) => ipc.invoke("cua:resumeTask", id),
    stopTask: (id) => ipc.invoke("cua:stopTask", id),
    setTaskMode: (id, mode) => ipc.invoke("cua:setTaskMode", id, mode),
    stopAll: () => ipc.invoke("cua:stopAll"),
    setMultiwindowEnabled: (enabled) => ipc.invoke("cua:setMultiwindowEnabled", enabled),
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
    setAgentCursor: (enabled: boolean) => ipc.invoke("cua:setAgentCursor", enabled),
    setAuthMode: (mode) => ipc.invoke("cua:setAuthMode", mode),
    setBlacklist: (apps) => ipc.invoke("cua:setBlacklist", apps),
    listInstalledApps: () => ipc.invoke("cua:listInstalledApps"),
    listScreenshots: () => ipc.invoke("cua:listScreenshots"),
    confirmSensitive: (allow, taskId) => ipc.invoke("cua:confirmSensitive", allow, taskId),
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
