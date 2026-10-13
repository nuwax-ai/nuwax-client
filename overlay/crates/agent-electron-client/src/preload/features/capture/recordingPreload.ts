import { contextBridge, ipcRenderer } from "electron";
import {
  RECORDING_IPC,
  type RecordingCommand,
  type RecordingWindowBridge,
} from "@shared/features/capture/recordingContract";

const bridge: RecordingWindowBridge = {
  config: () => ipcRenderer.invoke(RECORDING_IPC.CONFIG),
  event: (event) => ipcRenderer.invoke(RECORDING_IPC.EVENT, event),
  chunk: (sequence, data) => ipcRenderer.invoke(RECORDING_IPC.CHUNK, sequence, data),
  snapshot: (data, width, height) => ipcRenderer.invoke(RECORDING_IPC.SNAPSHOT, data, width, height),
  onCommand(listener) {
    const handler = (_event: Electron.IpcRendererEvent, command: RecordingCommand) => listener(command);
    ipcRenderer.on(RECORDING_IPC.COMMAND, handler);
    return () => ipcRenderer.removeListener(RECORDING_IPC.COMMAND, handler);
  },
};
contextBridge.exposeInMainWorld("captureRecording", bridge);
