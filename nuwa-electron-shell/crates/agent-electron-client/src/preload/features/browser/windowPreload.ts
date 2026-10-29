import { contextBridge, ipcRenderer } from "electron";
import {
  BROWSER_IPC,
  type BrowserWindowBridge,
  type BrowserState,
} from "@shared/features/browser/contract";
const bridge: BrowserWindowBridge = {
  getState: () => ipcRenderer.invoke(BROWSER_IPC.state),
  command: (command) => ipcRenderer.invoke(BROWSER_IPC.command, command),
  onState(listener) {
    const receive = (_event: unknown, state: BrowserState) => listener(state);
    ipcRenderer.on(BROWSER_IPC.changed, receive);
    return () => ipcRenderer.removeListener(BROWSER_IPC.changed, receive);
  },
};
contextBridge.exposeInMainWorld("browserWindow", bridge);
