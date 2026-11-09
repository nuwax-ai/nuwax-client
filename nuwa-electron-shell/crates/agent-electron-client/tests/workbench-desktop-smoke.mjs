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
    const browserContents = webContents.getAllWebContents().find(contents => contents.getURL().startsWith(url))
    const browserTab = (await desktop.workbench('state', { sessionId: first.sessionId }, signal())).tabs.find(tab => tab.kind === 'browser')
    const pageState = await desktop.browser({ sessionId: first.sessionId, tabId: browserTab.tabId, action: 'read' })
    assert.ok(pageState.value.text.includes('Shared browser page'))
    const floated = await change('layout', { sessionId: first.sessionId, action: 'float', tabId: browserTab.tabId, rect: { x: 200, y: 100, width: 600, height: 400 } })
    assert.ok(Object.values(floated.layout.nodes).some(node => node.kind === 'pane' && node.host === 'float'))
    const undone = await change('layout', { sessionId: first.sessionId, action: 'undo' })
    assert.ok(!Object.values(undone.layout.nodes).some(node => node.kind === 'pane' && node.host === 'float'))
    assert.equal(webContents.getAllWebContents().find(contents => contents.getURL().startsWith(url)).id, browserContents.id)
    await window.webContents.executeJavaScript("Array.from(document.querySelectorAll('button')).find(button => button.textContent === '锁定 Agent 布局调整').click()")
    await assert.rejects(change('visibility', { sessionId: first.sessionId, visible: false }), /locked/)
    await window.webContents.executeJavaScript("Array.from(document.querySelectorAll('button')).find(button => button.textContent === '允许 Agent 调整布局').click()")
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
    await assert.rejects(desktop.workbench('open', { sessionId: first.sessionId, kind: 'files' }, signal()), /session changed/)
    await bind('conversation-one')
    const restored = await desktop.workbench('state', { sessionId: first.sessionId }, signal())
    assert.ok(restored.tabs.some(tab => tab.kind === 'browser'))
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
