// Source-level Electron acceptance using an isolated account and local fixture pages.
import electron from 'electron'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'node:http'

const { app, BrowserWindow, webContents } = electron
const clientErrors = []
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (_event, level, message) => {
    if (level >= 2) { clientErrors.push(message); if (clientErrors.length > 20) clientErrors.shift() }
  })
})
const home = await mkdtemp(join(tmpdir(), 'nuwax-workbench-electron-'))
app.setPath('userData', join(home, 'electron'))
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
const deadline = setTimeout(() => { console.error('Workbench acceptance timed out'); app.exit(1) }, 360000)
const runtimeDir = fileURLToPath(new URL(process.argv.includes('--resources') ? '../resources/dsh-runtime/' : '../../dsh-runtime/', import.meta.url))
const { RuntimeController } = await import(pathToFileURL(join(runtimeDir, 'controller.mjs')).href)
const { createDesktop } = await import(pathToFileURL(join(runtimeDir, 'desktop.mjs')).href)
const node = fileURLToPath(new URL('../resources/dsh-office/primary-runtime/dependencies/node/bin/node', import.meta.url))
const workspace = join(home, 'workspace')
await mkdir(workspace)
await writeFile(join(workspace, 'preview.txt'), 'Native workbench file preview\n')
const scope = { origin: 'https://fixture.example', accountId: 'workbench-fixture', epoch: 1 }
const settings = new Map()
async function allocatePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
const runtime = new RuntimeController({ mode: 'workbench', runtimeDir, dataDir: join(home, 'profile'), node: () => node,
  env: () => ({ PATH: process.env.PATH }), allocatePort,
  settings: { read: key => settings.get(key), write: (key, value) => { settings.set(key, value); return true } },
  platform: { scope: () => scope, request: async () => { throw new Error('Workbench startup must be independent of model APIs') } },
})
let desktop, fixture
async function open() {
  const url = await runtime.start()
  desktop = createDesktop({ electron, runtimeDir, scopeDir: runtime.scopeDir(), namespace: 'workbench-fixture',
    port: await allocatePort(), launchUrl: url, current: () => runtime.current(), mode: 'workbench' })
  await desktop.open(false)
  const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith(new URL(url).origin))
  assert.ok(window)
  return window
}
const signal = () => new AbortController().signal
const bind = async conversationId => {
  const binding = await runtime.workbench('bind', { conversationId, cwd: workspace }, signal())
  await desktop.workbench('bind', binding, signal())
  return binding
}
async function change(operation, input) {
  const state = await desktop.workbench('state', { sessionId: input.sessionId }, signal())
  return desktop.workbench(operation, { ...input, actor: 'agent', expectedVersion: state.layoutVersion }, signal())
}

async function main() {
  try {
    await app.whenReady()
    let window = await open()
    if (process.argv.includes('--ecosystem')) {
      const result = await runtime.plugins('install', { target: 'dsh-better-sidebar@0.28.2' }, signal())
      assert.notEqual(result.application, 'failed', JSON.stringify(result))
      desktop.dispose(); await runtime.stop()
      window = await open()
      const list = await runtime.plugins('list', {}, signal())
      assert.ok(list.bundles.some(bundle => bundle.name === 'dsh-better-sidebar' && bundle.version === '0.28.2' && bundle.enabled))
    }
    const first = await bind('conversation-one')
    const waitUntil = async (check, label) => {
      const end = Date.now() + 20000
      while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)) }
      throw new Error(label + '\n' + await window.webContents.executeJavaScript('document.body.innerText'))
    }
    assert.equal(await window.webContents.executeJavaScript('typeof window.NuwaClawBridge'), 'undefined')
    assert.equal(await window.webContents.executeJavaScript('typeof require'), 'undefined')
    const initial = await desktop.workbench('state', { sessionId: first.sessionId }, signal())
    await change('open', { sessionId: first.sessionId, kind: 'files' })
    await assert.rejects(desktop.workbench('visibility', { sessionId: first.sessionId, actor: 'agent', expectedVersion: initial.layoutVersion, visible: false }, signal()), /version conflict/)
    await waitUntil(() => window.webContents.executeJavaScript("document.body.innerText.includes('preview.txt')"), 'Workspace files did not render')
    await change('open-file', { sessionId: first.sessionId, path: 'preview.txt' })
    await waitUntil(() => window.webContents.executeJavaScript("document.body.innerText.includes('Native workbench file preview')"), 'File contents did not render')
    await change('open', { sessionId: first.sessionId, kind: 'terminal' })
    const state = await desktop.workbench('state', { sessionId: first.sessionId }, signal())
    assert.ok(state.tabs.some(tab => tab.kind === 'files'))
    assert.ok(state.tabs.some(tab => tab.kind === 'terminal'))
    const terminalTab = state.tabs.find(tab => tab.kind === 'terminal')
    await waitUntil(async () => (await desktop.workbench('terminal', { sessionId: first.sessionId, tabId: terminalTab.tabId, action: 'state' }, signal())).writable, 'Native terminal did not become writable')
    await desktop.workbench('terminal', { sessionId: first.sessionId, tabId: terminalTab.tabId, action: 'write', data: "printf '%s%s\\n' workbench- terminal-fixture\r" }, signal())
    await waitUntil(() => window.webContents.executeJavaScript("document.body.innerText.includes('workbench-terminal-fixture')"), 'Native terminal command did not render its output')
    if (process.argv.includes('--ecosystem')) assert.ok(state.components.some(component => component.id.includes('better-sidebar')))
    fixture = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<title>Workbench browser</title><h1>Shared browser page</h1><button onclick="document.body.dataset.clicked=\'yes\'">Click me</button>')
    })
    await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${fixture.address().port}`
    await change('open', { sessionId: first.sessionId, kind: 'browser', params: { url } })
    await waitUntil(() => webContents.getAllWebContents().some(contents => contents.getURL().startsWith(url)), 'Native browser view did not load')
    await waitUntil(() => window.contentView.children.some(view => view.webContents?.getURL().startsWith(url) && view.getVisible() && view.getBounds().width > 100), 'Browser page is not visible in its panel')
    let browserContents = webContents.getAllWebContents().find(contents => contents.getURL().startsWith(url))
    let browserTab = (await desktop.workbench('state', { sessionId: first.sessionId }, signal())).tabs.find(tab => tab.kind === 'browser')
    const pageState = await desktop.browser({ sessionId: first.sessionId, tabId: browserTab.tabId, action: 'read' })
    assert.ok(pageState.value.text.includes('Shared browser page'))
    const split = await change('layout', { sessionId: first.sessionId, action: 'split' })
    const splitNode = split.layout.nodes[split.layout.rootId]
    assert.equal(splitNode.kind, 'split')
    await change('layout', { sessionId: first.sessionId, action: 'move', tabId: terminalTab.tabId, paneId: splitNode.children[1], zone: 'center' })
    await change('layout', { sessionId: first.sessionId, action: 'resize-split', splitId: splitNode.id, sizes: [0.65, 0.35] })
    const floated = await change('layout', { sessionId: first.sessionId, action: 'float', tabId: browserTab.tabId, rect: { x: 200, y: 100, width: 600, height: 400 } })
    assert.ok(Object.values(floated.layout.nodes).some(node => node.kind === 'pane' && node.host === 'float'))
    const saved = await change('preset', { sessionId: first.sessionId, action: 'save', name: 'Review', expectedRevision: null })
    let revision = saved.presets.revision
    await assert.rejects(change('preset', { sessionId: first.sessionId, action: 'save', name: 'Stale', expectedRevision: null }), /revision conflict/)
    const undone = await change('layout', { sessionId: first.sessionId, action: 'undo' })
    assert.ok(!Object.values(undone.layout.nodes).some(node => node.kind === 'pane' && node.host === 'float'))
    assert.equal(webContents.getAllWebContents().find(contents => contents.getURL().startsWith(url)).id, browserContents.id)
    const applied = await change('preset', { sessionId: first.sessionId, action: 'apply', name: 'Review', expectedRevision: revision })
    assert.deepEqual(applied.layout.nodes[applied.layout.rootId].sizes, [0.65, 0.35])
    assert.ok(Object.values(applied.layout.nodes).some(node => node.kind === 'pane' && node.host === 'float' && node.tabs.includes(browserTab.tabId)))
    assert.equal(webContents.getAllWebContents().find(contents => contents.getURL().startsWith(url)).id, browserContents.id)
    await change('close', { sessionId: first.sessionId, tabId: browserTab.tabId })
    await waitUntil(() => browserContents.isDestroyed(), 'Closed browser page was not released')
    await change('preset', { sessionId: first.sessionId, action: 'apply', name: 'Review', expectedRevision: revision })
    await waitUntil(() => webContents.getAllWebContents().some(contents => contents.getURL().startsWith(url)), 'Saved browser panel did not reopen')
    browserContents = webContents.getAllWebContents().find(contents => contents.getURL().startsWith(url))
    browserTab = (await desktop.workbench('state', { sessionId: first.sessionId }, signal())).tabs.find(tab => tab.kind === 'browser')
    await change('preset', { sessionId: first.sessionId, action: 'apply', name: 'Review', expectedRevision: revision })
    assert.equal((await desktop.workbench('state', { sessionId: first.sessionId }, signal())).tabs.filter(tab => tab.kind === 'browser').length, 1)
    const currentLayout = await desktop.workbench('state', { sessionId: first.sessionId }, signal())
    const dockPane = Object.values(currentLayout.layout.nodes).find(node => node.kind === 'pane' && node.host === 'dock')
    await assert.rejects(change('layout', { sessionId: first.sessionId, action: 'move', tabId: browserTab.tabId, paneId: dockPane.id, zone: 'bottom' }), /supports center/)
    await assert.rejects(change('layout', { sessionId: first.sessionId, action: 'float', tabId: 'unknown-tab' }), /does not belong/)
    await window.webContents.executeJavaScript("Array.from(document.querySelectorAll('button')).find(button => button.textContent === '锁定 Agent 布局调整').click()")
    await waitUntil(async () => (await desktop.workbench('state', { sessionId: first.sessionId }, signal())).layoutLocked, 'Layout lock was not saved')
    await assert.rejects(change('visibility', { sessionId: first.sessionId, visible: false }), /locked/)
    await assert.rejects(change('preset', { sessionId: first.sessionId, action: 'apply', name: 'Review', expectedRevision: revision }), /locked/)
    await window.webContents.executeJavaScript("Array.from(document.querySelectorAll('button')).find(button => button.textContent === '允许 Agent 调整布局').click()")
    await waitUntil(async () => !(await desktop.workbench('state', { sessionId: first.sessionId }, signal())).layoutLocked, 'Layout lock was not released')
    revision = (await desktop.workbench('preset', { sessionId: first.sessionId, action: 'list' }, signal())).revision
    const endpoint = await desktop.endpoint({ botId: first.sessionId, downloadRoots: [workspace] })
    const { chromium } = await import('../../dsh-runtime/node_modules/playwright/index.mjs')
    const browser = await chromium.connectOverCDP(endpoint)
    try {
      const page = browser.contexts()[0].pages().find(page => page.url().startsWith(url))
      assert.ok(page)
      await page.locator('button').click()
      assert.equal(await page.evaluate(() => document.body.dataset.clicked), 'yes')
      const disconnected = new Promise(resolve => browser.once('disconnected', resolve))
      await window.webContents.executeJavaScript(`window.dshDesktop.browser.views.hold(${JSON.stringify(first.sessionId)}, true)`)
      await disconnected
      await assert.rejects(desktop.endpoint({ botId: first.sessionId, downloadRoots: [workspace] }), /taken over/)
      await assert.rejects(desktop.browser({ sessionId: first.sessionId, tabId: browserTab.tabId, action: 'click', selector: 'button' }), /taken over/)
      await window.webContents.executeJavaScript(`window.dshDesktop.browser.views.hold(${JSON.stringify(first.sessionId)}, false)`)
    } finally { await browser.close().catch(() => {}) }
    const second = await bind('conversation-two')
    assert.notEqual(first.sessionId, second.sessionId)
    assert.equal((await desktop.workbench('preset', { sessionId: second.sessionId, action: 'list' }, signal())).items.length, 0)
    await assert.rejects(desktop.workbench('open', { sessionId: first.sessionId, kind: 'files' }, signal()), /session changed/)
    await bind('conversation-one')
    const restored = await desktop.workbench('state', { sessionId: first.sessionId }, signal())
    assert.ok(restored.tabs.some(tab => tab.kind === 'browser'))
    await window.webContents.executeJavaScript("Array.from(document.querySelectorAll('button')).find(button => button.textContent === '锁定 Agent 布局调整').click()")
    await waitUntil(async () => (await desktop.workbench('state', { sessionId: first.sessionId }, signal())).layoutLocked, 'Layout lock was not saved before restart')
    revision = (await desktop.workbench('preset', { sessionId: first.sessionId, action: 'list' }, signal())).revision
    desktop.dispose(); await runtime.stop(); window = await open(); await bind('conversation-one')
    const persisted = await desktop.workbench('preset', { sessionId: first.sessionId, action: 'list' }, signal())
    assert.equal(persisted.revision, revision)
    assert.equal(persisted.items[0].name, 'Review')
    assert.equal((await desktop.workbench('state', { sessionId: first.sessionId }, signal())).layoutLocked, true)
    await assert.rejects(change('preset', { sessionId: first.sessionId, action: 'apply', name: 'Review', expectedRevision: revision }), /locked/)
    await window.webContents.executeJavaScript("Array.from(document.querySelectorAll('button')).find(button => button.textContent === '允许 Agent 调整布局').click()")
    await waitUntil(async () => !(await desktop.workbench('state', { sessionId: first.sessionId }, signal())).layoutLocked, 'Restored layout lock was not released')
    revision = (await desktop.workbench('preset', { sessionId: first.sessionId, action: 'list' }, signal())).revision
    await change('preset', { sessionId: first.sessionId, action: 'apply', name: 'Review', expectedRevision: revision })
    await writeFile('/tmp/nuwax-workbench-source.png', (await window.webContents.capturePage()).toPNG())
    if (process.argv.includes('--ecosystem')) {
      await runtime.plugins('disable', { target: 'dsh-better-sidebar' }, signal())
      desktop.dispose(); await runtime.stop(); window = await open(); await bind('conversation-one')
      const disabled = await desktop.workbench('state', { sessionId: first.sessionId }, signal())
      assert.ok(!disabled.components.some(component => component.id.includes('better-sidebar')))
      await runtime.plugins('enable', { target: 'dsh-better-sidebar' }, signal())
      desktop.dispose(); await runtime.stop(); window = await open(); await bind('conversation-one')
      const enabled = await desktop.workbench('state', { sessionId: first.sessionId }, signal())
      assert.ok(enabled.components.some(component => component.id.includes('better-sidebar')))
    }
    console.log(JSON.stringify({ level: 'electron-real-dsh-workbench', modelIndependent: true, clientMounted: true,
      nativeFilesAndTerminal: true, sharedBrowserAutomation: true, userTakeover: true, sessionIsolation: true,
      layoutVersionConflict: true, layoutLock: true, floatAndUndo: true, browserInstancePreserved: true,
      namedLayoutRestore: true, splitRatioRestore: true, closedPanelReopened: true, presetRestart: true, lockRestart: true, invalidLayoutRejected: true,
      betterSidebar: process.argv.includes('--ecosystem'), screenshot: '/tmp/nuwax-workbench-source.png' }))
  } catch (error) {
    console.error(error)
    console.error(clientErrors.join('\n').slice(0, 8000))
    for (const window of BrowserWindow.getAllWindows()) {
      try { console.error((await window.webContents.executeJavaScript('document.body.innerText')).slice(0, 6000)) } catch {}
    }
    process.exitCode = 1
  } finally {
    desktop?.dispose(); await runtime.stop()
    if (fixture) { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)) }
    await rm(home, { recursive: true, force: true })
    clearTimeout(deadline); app.exit(process.exitCode ?? 0)
  }
}
void main()
