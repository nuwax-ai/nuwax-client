import type { IpcRenderer } from "electron";
import {
  ANDROID_IPC,
  type AndroidBridge,
} from "@shared/features/android/contract";

export function createAndroidBridge(
  ipc: Pick<IpcRenderer, "invoke">,
): AndroidBridge {
  return {
    status: () => ipc.invoke(ANDROID_IPC.status),
    discover: (input) => ipc.invoke(ANDROID_IPC.discover, input),
    enable: (input) => ipc.invoke(ANDROID_IPC.enable, input),
    stop: () => ipc.invoke(ANDROID_IPC.stop),
  };
}
