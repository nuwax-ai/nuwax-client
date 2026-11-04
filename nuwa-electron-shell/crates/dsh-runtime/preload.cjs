const { contextBridge, ipcRenderer } = require('electron')
const origin = process.argv.find(x => x.startsWith('--nuwax-dsh-origin='))?.slice('--nuwax-dsh-origin='.length)
if (origin && location.origin === origin) {
  const documentToken = ipcRenderer.invoke('nuwax-dsh:document')
  const invoke = async (action, ...args) => ipcRenderer.invoke('nuwax-dsh:' + action, await documentToken, ...args)
  const listeners = new Set()
  const opens = new Map()
  ipcRenderer.on('ds-bot:browser-view-changed', (_event, value) => { for (const listener of listeners) listener(value) })
  ipcRenderer.on('ds-bot:browser-open-requested', (_event, value) => { for (const listener of opens.get(value.lease) ?? []) listener(value.url) })
  contextBridge.exposeInMainWorld('dshDesktop', {
    protocolVersion: 1,
    browser: {
      acquire: key => invoke('acquire', key),
      release: lease => invoke('release', lease),
      forget: key => invoke('forget', key),
      onOpenRequested(lease, listener) {
        const set = opens.get(lease) ?? new Set(); opens.set(lease, set); set.add(listener)
        return () => { set.delete(listener); if (!set.size) opens.delete(lease) }
      },
      views: {
        create: (botId, tabId, url) => invoke('create', botId, tabId, url),
        sync: botId => invoke('sync', botId),
        place: (tabId, rect, visible) => invoke('place', tabId, rect, visible),
        navigate: (botId, tabId, url) => invoke('navigate', botId, tabId, url),
        command: (botId, tabId, command) => invoke('command', botId, tabId, command),
        focus: (botId, tabId) => invoke('focus', botId, tabId),
        read: (botId, tabId, script) => invoke('read', botId, tabId, script),
        close: (botId, tabId) => invoke('close', botId, tabId),
        hold: (botId, held) => invoke('hold', botId, held),
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
      },
    },
  })
}
