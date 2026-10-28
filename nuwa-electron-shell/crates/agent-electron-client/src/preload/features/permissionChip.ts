import { contextBridge, ipcRenderer } from "electron";

/** Drag-add palette bridge; only the permission chip window loads this preload. */
contextBridge.exposeInMainWorld("permissionChip", {
  drag: () => ipcRenderer.invoke("permissions:onboarding:dragChip:start"),
  close: () => ipcRenderer.invoke("permissions:onboarding:dragChip:close"),
  onIdentity: (listener: (value: unknown) => void) => {
    const callback = (_event: unknown, value: unknown) => listener(value);
    ipcRenderer.on("permissionChip:identity", callback);
    return () => ipcRenderer.removeListener("permissionChip:identity", callback);
  },
});
