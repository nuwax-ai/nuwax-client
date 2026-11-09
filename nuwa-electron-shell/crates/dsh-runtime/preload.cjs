const { contextBridge, ipcRenderer } = require('electron')
const origin = process.argv.find(x => x.startsWith('--nuwax-dsh-origin='))?.slice('--nuwax-dsh-origin='.length)
if (origin && location.origin === origin) {
  const workbench = process.argv.includes('--nuwax-dsh-workbench')
  const prefix = workbench ? 'nuwax-dsh-workbench:' : 'nuwax-dsh:'
  const documentToken = ipcRenderer.invoke(prefix + 'document')
  const invoke = async (action, ...args) => ipcRenderer.invoke(prefix + action, await documentToken, ...args)
  contextBridge.exposeInMainWorld('__DSH_LOCALE__', {
    read: () => invoke('locale'),
    // The shell is the preference owner; DSH reports render changes through this native contract.
    onChange() {},
  })
  if (workbench) {
    contextBridge.exposeInMainWorld('nuwaxWorkbench', {
      ready: () => invoke('workbench-ready'),
      closed: () => invoke('workbench-closed'),
      reply: (id, result) => invoke('workbench-reply', id, result),
      readLayouts: sessionId => invoke('workbench-layout-read', sessionId),
      writeLayouts: (sessionId, revision, raw) => invoke('workbench-layout-write', sessionId, revision, raw),
      onCommand(listener) {
        const receive = (_event, request) => listener(request)
        ipcRenderer.on('nuwax-workbench:command', receive)
        return () => ipcRenderer.removeListener('nuwax-workbench:command', receive)
      },
    })
  } else contextBridge.exposeInMainWorld('nuwaxBotHost', { openSettings: () => invoke('settings') })
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
        subscribe(listener) {
          listeners.add(listener)
          void invoke('restore').catch(() => { console.warn('DS-Bot browser state could not be restored') })
          return () => listeners.delete(listener)
        },
      },
    },
  })
}
