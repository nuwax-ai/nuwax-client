import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("cuaControls", {
  close: () => ipcRenderer.invoke("cua:control:close"),
  move: (position: { x: number; y: number }) => ipcRenderer.invoke("cua:control:move", position),
  resize: (size: { width: number; height: number }) => ipcRenderer.invoke("cua:control:resize", size),
  reorder: (ids: string[]) => ipcRenderer.invoke("cua:control:reorder", ids),
  getPresentation: () => ipcRenderer.invoke("cua:control:getPresentation"),
  setPresentation: (id: string | null) => ipcRenderer.invoke("cua:control:setPresentation", id),
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
  taskAction: (id: string, action: "pause" | "resume" | "stop" | "takeover") => ipcRenderer.invoke("cua:control:taskAction", id, action),
  onRuntime: (listener: (value: unknown) => void) => {
    const callback = (_event: unknown, value: unknown) => listener(value);
    ipcRenderer.on("cua:control:runtime", callback);
    return () => ipcRenderer.removeListener("cua:control:runtime", callback);
  },
});
