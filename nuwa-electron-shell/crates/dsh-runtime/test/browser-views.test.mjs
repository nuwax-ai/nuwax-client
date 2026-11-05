import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { BotViews } from '../vendor/bot-views.mjs'

const botId = 'session-11111111-1111-4111-8111-111111111111'

class Contents extends EventEmitter {
  debugger = Object.assign(new EventEmitter(), { attach() {} })
  setWindowOpenHandler() {}
  async loadURL(url) { this.url = url }
  getURL() { return this.url ?? 'about:blank' }
  getTitle() { return 'Download fixture' }
  isLoading() { return false }
  isDestroyed() { return false }
  canGoBack() { return false }
  canGoForward() { return false }
  close() { this.emit('destroyed') }
}

async function fixture(t, saved) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nuwax-bot-download-')))
  const statePath = join(root, 'browser-tabs.json')
  if (saved) await writeFile(statePath, JSON.stringify({ version: 1, bots: saved }))
  let download
  const changes = []
  const views = new BotViews({
    window: () => undefined, origin: () => 'http://127.0.0.1:12345',
    statePath, onChange: value => changes.push(value),
    WebContentsView: class {
      webContents = new Contents()
      setBounds() {}
      setVisible() {}
    },
    guests: {
      storageFor: () => ({ partition: 'download-fixture' }),
      setDownloadHandler: (_key, handler) => { download = handler },
    },
  })
  t.after(async () => { views.dispose(); await rm(root, { recursive: true, force: true }) })
  const entry = saved ? undefined : views.create(botId, { url: 'https://example.com', tabId: 'download' })
  if (entry) await views.endpoint(botId, { downloadRoots: [root] })
  else await new Promise(resolve => setImmediate(resolve))
  const invoke = () => {
    let cancelled = false, savePath
    const item = Object.assign(new EventEmitter(), {
      setSavePath: value => { savePath = value }, getURL: () => 'https://example.com/download',
      getFilename: () => 'fixture.txt', getReceivedBytes: () => 0, getTotalBytes: () => 1,
    })
    download({ preventDefault: () => { cancelled = true } }, item, entry.view.webContents)
    return { cancelled, savePath }
  }
  return { views, entry, root, invoke, changes }
}

test('user takeover leaves downloads to the native save dialog without an automation path', async t => {
  const { views, entry, root, invoke } = await fixture(t)
  assert.deepEqual(invoke(), { cancelled: true, savePath: undefined })
  // An automation route can still be disconnecting when the user takes over.
  entry.sessions.set({}, 'old-cdp-session')
  entry.downloadPath = root
  await views.hold(botId, true)
  assert.deepEqual(invoke(), { cancelled: false, savePath: undefined })
  await views.hold(botId, false)
  entry.sessions.clear()
  assert.deepEqual(invoke(), { cancelled: true, savePath: undefined })
  await views.hold(botId, true)
  views.dispose()
  assert.deepEqual(invoke(), { cancelled: true, savePath: undefined })
})

test('automated downloads still require an attached session and an authorized output directory', async t => {
  const { entry, root, invoke } = await fixture(t)
  entry.downloadPath = root
  assert.deepEqual(invoke(), { cancelled: true, savePath: undefined })
  entry.sessions.set({}, 'cdp-session')
  entry.downloadPath = join(root, '..', 'outside-download-fixture')
  assert.deepEqual(invoke(), { cancelled: true, savePath: undefined })
  entry.downloadPath = root
  const result = invoke()
  assert.equal(result.cancelled, false)
  assert.equal(dirname(result.savePath), root)
})

test('saved tabs rehydrate a fresh Client with the active tab last and keep Bot ownership', async t => {
  const other = 'session-22222222-2222-4222-8222-222222222222'
  const { views, changes } = await fixture(t, {
    [botId]: { tabs: [
      { tabId: 'first', url: 'https://example.com/first', title: 'First' },
      { tabId: 'second', url: 'https://example.com/second', title: 'Second' },
    ], active: 'first' },
    [other]: { tabs: [{ tabId: 'other', url: 'http://127.0.0.1:12345/private', title: 'Blocked Host' }], active: 'other' },
  })
  views.restore()
  assert.deepEqual(changes.filter(value => value.type === 'created' && value.botId === botId).map(value => value.tabId), ['second', 'first'])
  assert.deepEqual(views.sync(botId).map(value => value.url).sort(), ['https://example.com/first', 'https://example.com/second'])
  assert.equal(views.sync(other)[0].url, 'about:blank', 'the previous private Host must not load as a browser page')
  views.restore()
  assert.equal(views.sync(botId).length, 2, 'resubscribing must reuse the owned views')
  await assert.rejects(views.operate(other, 'read', { tabId: 'first', script: 'document.title' }), /another Bot|does not belong/)
  views.dispose()
  assert.throws(() => views.restore(), /disposed/)
})
