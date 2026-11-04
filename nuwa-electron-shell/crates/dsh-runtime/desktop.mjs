import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { BotBrowserGuests } from './vendor/bot-browser.mjs'
import { BotViews, isBotId } from './vendor/bot-views.mjs'

/** The original plugin consumes this desktop protocol; no business bridge enters the page. */
export function createDesktop({ electron, runtimeDir, scopeDir, namespace, port, launchUrl, current }) {
  const { BrowserWindow, WebContentsView, session, ipcMain, shell } = electron
  const origin = new URL(launchUrl).origin
  let window
  let disposing = false
  let documentToken
  const partition = 'persist:nuwax-dsh-ui-' + namespace
  const storage = session.fromPartition(partition)
  const owns = event => {
    try {
      return !disposing && current() && window && !window.isDestroyed() && event.sender === window.webContents &&
        event.senderFrame === window.webContents.mainFrame && new URL(event.senderFrame.url).origin === origin
    } catch { return false }
  }
  storage.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(Boolean(current() && window && contents === window.webContents && details.isMainFrame === true && details.requestingUrl?.startsWith(origin + '/') &&
      permission === 'media' && details.mediaTypes?.includes('audio') && !details.mediaTypes?.includes('video')))
  })
  storage.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    Boolean(current() && window && contents === window.webContents && permission === 'media' &&
      requestingOrigin === origin && details?.isMainFrame === true && details?.mediaType === 'audio'))
  const guests = new BotBrowserGuests({ session, origin: () => origin, devTools: false, namespace })
  const views = new BotViews({
    window: () => window, WebContentsView, guests, origin: () => origin, port,
    statePath: join(scopeDir, 'browser-tabs.json'),
    onChange: value => { if (!disposing && window && !window.isDestroyed()) window.webContents.send('ds-bot:browser-view-changed', value) },
  })
  const channels = []
  const handle = (name, action) => {
    const channel = 'nuwax-dsh:' + name
    channels.push(channel)
    ipcMain.handle(channel, (event, token, ...args) => {
      if (!owns(event) || !documentToken || token !== documentToken) throw new Error('Plugin document is no longer authorized')
      return action(event, ...args)
    })
  }
  const identity = botId => { if (!isBotId(botId)) throw new Error('Invalid Bot identity'); return botId }
  ipcMain.handle('nuwax-dsh:document', event => {
    if (!owns(event)) throw new Error('Untrusted plugin document')
    return documentToken ??= randomBytes(32).toString('hex')
  })
  channels.push('nuwax-dsh:document')
  handle('acquire', (event, key) => { identity(String(key).slice(4)); if (!String(key).startsWith('bot:')) throw new Error('Invalid browser key'); return guests.acquire(event.sender, key) })
  handle('release', (event, lease) => guests.release(event.sender, lease))
  handle('forget', async (event, key) => { const id = identity(String(key).slice(4)); await views.forget(id); await guests.forget(event.sender, key) })
  handle('create', (_event, botId, tabId, url) => views.create(identity(botId), { tabId, ...(url ? { url } : {}) }).tabId)
  handle('sync', (_event, botId) => views.sync(identity(botId)))
  handle('restore', () => views.restore())
  handle('place', (_event, tabId, rect, visible) => views.place(tabId, rect, visible))
  for (const action of ['navigate', 'command', 'focus', 'read', 'close']) {
    handle(action, (_event, botId, tabId, value) => views.operate(identity(botId), action, {
      tabId, ...(action === 'navigate' ? { url: value } : action === 'command' ? { command: value } : action === 'read' ? { script: value } : {}),
    }))
  }
  handle('hold', (_event, botId, held) => views.hold(identity(botId), held === true))
  const downloading = (_event, item) => {
    if (!current()) { item.cancel(); return }
    // Electron owns its native save dialog when no synchronous save path is set.
  }
  storage.on('will-download', downloading)
  return {
    async open(visible = true) {
      if (!current()) throw new Error('Plugin runtime is no longer authorized')
      if (window && !window.isDestroyed()) { if (visible) { window.show(); window.focus() } return }
      window = new BrowserWindow({
        width: 1280, height: 860, title: 'DS-Bot · Nuwax', show: visible,
        webPreferences: { partition, preload: join(runtimeDir, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true,
          additionalArguments: ['--nuwax-dsh-origin=' + origin] },
      })
      views.attach(window)
      guests.bind(window)
      window.on('close', event => { if (!disposing && current()) { event.preventDefault(); window.hide() } })
      window.webContents.on('did-start-navigation', (_event, _url, _inPlace, main) => { if (main) documentToken = undefined })
      window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) event.preventDefault() })
      window.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/.test(url) && new URL(url).origin !== origin) void shell.openExternal(url)
        return { action: 'deny' }
      })
      window.webContents.once('destroyed', () => { documentToken = undefined })
      try { await window.loadURL(launchUrl) }
      catch (error) { if (window && !window.isDestroyed()) window.destroy(); window = undefined; throw error }
    },
    async endpoint(message) {
      if (!current()) throw new Error('Runtime expired')
      return views.endpoint(identity(message.botId), { downloadRoots: message.downloadRoots })
    },
    dispose() {
      disposing = true; documentToken = undefined
      views.dispose()
      if (window && !window.isDestroyed()) window.destroy()
      for (const channel of channels) ipcMain.removeHandler(channel)
      storage.off('will-download', downloading)
      storage.setPermissionRequestHandler(null); storage.setPermissionCheckHandler(null)
    },
  }
}
