import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("cuaControls", {
  close: () => ipcRenderer.invoke("cua:control:close"),
  move: (position: { x: number; y: number }) => ipcRenderer.invoke("cua:control:move", position),
  reorder: (ids: string[]) => ipcRenderer.invoke("cua:control:reorder", ids),
  getPresentation: () => ipcRenderer.invoke("cua:control:getPresentation"),
  setPresentation: (id: string | null, expanded: boolean) => ipcRenderer.invoke("cua:control:setPresentation", id, expanded),
  onPresentation: (listener: (value: any) => void) => {
    const callback = (_event: unknown, value: unknown) => listener(value);
    ipcRenderer.on("cua:control:presentation", callback);
    return () => ipcRenderer.removeListener("cua:control:presentation", callback);
  },
  onPreview: (listener: (value: any) => void) => {
    const callback = (_event: unknown, value: unknown) => listener(value);
    ipcRenderer.on("cua:control:preview", callback);
    return () => ipcRenderer.removeListener("cua:control:preview", callback);
  },
  getRuntime: () => ipcRenderer.invoke("cua:control:getRuntime"),
  action: (action: string) => ipcRenderer.invoke("cua:control:action", action),
  taskAction: (id: string, action: string, value?: unknown) => ipcRenderer.invoke("cua:control:taskAction", id, action, value),
  listWindows: () => ipcRenderer.invoke("cua:control:listWindows"),
  onRuntime: (listener: (value: unknown) => void) => {
    const callback = (_event: unknown, value: unknown) => listener(value);
    ipcRenderer.on("cua:control:runtime", callback);
    return () => ipcRenderer.removeListener("cua:control:runtime", callback);
  },
});
