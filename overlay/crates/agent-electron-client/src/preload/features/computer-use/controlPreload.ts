import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("cuaControls", {
  getRuntime: () => ipcRenderer.invoke("cua:control:getRuntime"),
  action: (action: string) => ipcRenderer.invoke("cua:control:action", action),
  onRuntime: (listener: (value: unknown) => void) => {
    const callback = (_event: unknown, value: unknown) => listener(value);
    ipcRenderer.on("cua:control:runtime", callback);
    return () => ipcRenderer.removeListener("cua:control:runtime", callback);
  },
});
