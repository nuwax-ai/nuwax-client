import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInContext, createContext } from 'node:vm'
import { webcrypto } from 'node:crypto'
import test from 'node:test'

// Exercise the browser's production controller without starting a renderer.
const source = await readFile(new URL('../workbench/client.js', import.meta.url), 'utf8')
const context = createContext({ window: { __ModuleLoader__: { load() {} } }, crypto: webcrypto })
runInContext(source, context)
const Presets = context.NuwaxLayoutPresets
test('native plugin changes can reevaluate the Client script in the same document', () => {
  const context = createContext({ window: { __ModuleLoader__: { load() {} } }, crypto: webcrypto })
  runInContext(source, context)
  assert.doesNotThrow(() => runInContext(source, context))
})
function fixture() {
  const sessionId = 'session-fixture'
  const contentId = 'sidebar://browser/one'
  const layout = {
    nodes: { pane1: { kind: 'pane', id: 'pane1', host: 'dock', tabs: ['tab1'], activeTabId: 'tab1' } },
    tabs: { tab1: { id: 'tab1', kind: 'browser', contentId, title: 'Browser' } },
    rootId: 'pane1', floats: [], activePaneId: 'pane1', expanded: true, mode: 'push',
  }
  const data = new Map()
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }
  const sidebar = {
    screen: () => ({ sessionId, surface: { layout } }),
    tabDomain: { occurrence: () => ({ navigation: { getSnapshot: () => ({ address: contentId, params: { url: 'https://example.com' } }) } }) },
  }
  const registry = { get: () => ({}), claim: () => ({}) }
  const presets = new Presets(sidebar, registry, storage, sessionId)
  return { presets, storage, data, layout, registry, sidebar, sessionId }
}

test('saved arrangements survive controller recreation and reject stale catalog writes', async () => {
  const f = fixture()
  assert.equal((await f.presets.list()).revision, null)
  const saved = await f.presets.change('save', 'Reading', null)
  assert.match(saved.revision, /^[a-f\d-]{36}$/)
  assert.equal((await new Presets(f.sidebar, f.registry, f.storage, f.sessionId).list()).items[0].name, 'Reading')
  await assert.rejects(() => f.presets.change('save', 'Stale', null), /revision conflict/)
  assert.equal((await f.presets.list()).items.length, 1)
  const removed = await f.presets.change('remove', 'Reading', saved.revision)
  assert.equal(removed.items.length, 0)
  assert.notEqual(removed.revision, saved.revision)
})

test('storage errors do not report success or change the last saved revision', async () => {
  const f = fixture()
  const saved = await f.presets.change('save', 'Original', null)
  const before = f.data.get(f.presets.key)
  f.storage.setItem = () => { throw new Error('Quota exceeded') }
  await assert.rejects(() => f.presets.change('save', 'New', saved.revision), /Quota exceeded/)
  assert.equal(f.data.get(f.presets.key), before)
})

test('catalogs are conversation scoped and corrupt or foreign file data is preserved and rejected', async () => {
  const f = fixture()
  await f.presets.change('save', 'One', null)
  assert.equal((await new Presets(f.sidebar, f.registry, f.storage, 'another-session').list()).items.length, 0)
  const raw = f.data.get(f.presets.key)
  const corrupt = JSON.parse(raw)
  const tab = corrupt.items[0].arrangement.dock[0].tabs[0]
  tab.contentId = tab.navigation.address = 'dsh-resource://file/session/another-session/private.txt'
  const foreign = JSON.stringify(corrupt)
  f.data.set(f.presets.key, foreign)
  await assert.rejects(() => f.presets.list(), /stored data was preserved/)
  assert.equal(f.data.get(f.presets.key), foreign)
  f.data.set(f.presets.key, '{')
  await assert.rejects(() => f.presets.change('save', 'Overwrite', null), /stored data was preserved/)
  assert.equal(f.data.get(f.presets.key), '{')
})

test('missing plugin dependencies prevent restore before any native layout mutation', async () => {
  const f = fixture()
  const saved = await f.presets.change('save', 'Browser', null)
  f.registry.get = () => undefined
  f.sidebar.actionsFor = () => { throw new Error('Must not mutate') }
  await assert.rejects(() => f.presets.apply('Browser', saved.revision), /plugin is unavailable/)
  await assert.rejects(() => f.presets.apply('Browser', null), /revision conflict/)
})

test('saved catalog has a bounded capacity and overwrites do not consume an extra slot', async () => {
  const f = fixture()
  let revision = null
  for (let i = 0; i < 20; i++) revision = (await f.presets.change('save', 'Layout ' + i, revision)).revision
  revision = (await f.presets.change('save', 'Layout 0', revision)).revision
  await assert.rejects(() => f.presets.change('save', 'Overflow', revision), /At most 20/)
  assert.equal((await f.presets.list()).items.length, 20)
})

test('user locks survive recreation and share catalog revision checks', async () => {
  const f = fixture()
  const locked = await f.presets.lock(true, null)
  assert.equal(locked.locked, true)
  assert.equal(locked.items.length, 0)
  const reopened = new Presets(f.sidebar, f.registry, f.storage, f.sessionId)
  assert.equal((await reopened.list()).locked, true)
  await assert.rejects(reopened.lock(false, null), /revision conflict/)
  assert.equal((await reopened.change('save', 'Locked', locked.revision)).locked, true)
})

test('authorization is rechecked after asynchronous storage reads before saving', async () => {
  const f = fixture()
  let read
  f.storage.getItem = () => new Promise(resolve => { read = resolve })
  f.presets.guard = () => { throw new Error('Turn canceled') }
  const pending = f.presets.change('save', 'Late', null)
  read(null)
  await assert.rejects(pending, /Turn canceled/)
  assert.equal(f.data.size, 0)
})
