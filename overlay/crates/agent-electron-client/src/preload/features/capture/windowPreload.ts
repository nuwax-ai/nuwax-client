import { contextBridge, ipcRenderer } from 'electron';
import { CAPTURE_WINDOW_CHANNELS as CH, type CaptureWindowBridge } from '@shared/features/capture/windowContract';

const bridge: CaptureWindowBridge = {
  init: () => ipcRenderer.invoke(CH.init),
  source: (id) => ipcRenderer.invoke(CH.source, id),
  finish: (payload) => ipcRenderer.invoke(CH.finish, payload),
  action: (action) => ipcRenderer.send(CH.action, action),
  onState(callback) {
    const listener = (_event: Electron.IpcRendererEvent, state: Parameters<typeof callback>[0]) => callback(state);
    ipcRenderer.on(CH.state, listener);
    return () => ipcRenderer.removeListener(CH.state, listener);
  },
};
contextBridge.exposeInMainWorld('NuwaxCaptureWindow', bridge);
