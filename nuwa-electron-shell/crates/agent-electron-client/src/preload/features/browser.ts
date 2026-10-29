import {
  BROWSER_IPC,
  type BrowserBridge,
} from "@shared/features/browser/contract";
import type { IpcRenderer } from "electron";
export function createBrowserBridge(
  ipc: Pick<IpcRenderer, "invoke">,
  host = false
): BrowserBridge {
  return {
    async getCapabilities() {
      try {
        return await ipc.invoke(
          host ? BROWSER_IPC.hostCapabilities : BROWSER_IPC.capabilities
        );
      } catch {
        return { available: false };
      }
    },
  };
}
