const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('qaForeign', { invoke: (channel, value) => {
  if (!['shell:openExternal', 'agentRunner:start'].includes(channel)) throw Error('Unsupported synthetic probe');
  return ipcRenderer.invoke(channel, value);
} });
