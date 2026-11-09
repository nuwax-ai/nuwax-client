import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { RuntimeController, scopeKey, developmentModelProxy } from '../controller.mjs'

async function fixture(readyDelay = 0, devModelProxy) {
  const root = await mkdtemp(join(tmpdir(), 'nuwax-dsh-controller-'))
  const runtimeDir = join(root, 'runtime')
  await mkdir(runtimeDir)
  await writeFile(join(runtimeDir, 'host.mjs'), `
    import { readFileSync, writeFileSync } from 'node:fs';
    const launch = JSON.parse(readFileSync(process.env.DSH_HOME + '/launch.json'));
    writeFileSync(process.env.DSH_HOME + '/observed.json', JSON.stringify({ pid: process.pid, env: process.env, language: launch.language }));
    process.on('message', message => {
      if (message.type === 'language') writeFileSync(process.env.DSH_HOME + '/language.json', JSON.stringify(message.language));
      if (message.type === 'stop') { process.disconnect(); process.exit(0) }
      if (message.type === 'shell-plugin-request') setTimeout(() => { if (process.connected) process.send({ type: 'shell-plugin-result', id: message.id, value: { operation: message.operation } }) }, 30);
    });
    setTimeout(() => process.send({ type: 'ready', url: 'http://127.0.0.1:' + launch.port + '/?token=fixture', port: launch.port }), ${readyDelay});
  `)
  let scope = { origin: 'https://a.example', accountId: 'one', epoch: 1 }
  const allocated = [], released = []
  let language = 'zh-CN'
  const saved = new Map([['dsh.authorization.' + scopeKey(scope), { keyId: 5, models: ['12'] }]])
  const controller = new RuntimeController({
    runtimeDir, officeDir: join(root, 'office'), dataDir: root, node: () => process.execPath, devModelProxy,
    language: () => language,
    env: () => ({ PATH: process.env.PATH, NUWAX_DSH_DEV_MODEL_PROXY: 'fixture', NUWAX_DSH_DEV_MODEL_PROXY_TOKEN: 'fixture-capability' }),
    settings: { read: key => saved.get(key), write: (key, value) => saved.set(key, value) },
    allocatePort: () => new Promise(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; allocated.push(port); server.close(() => resolve(port)) }) }),
    releasePort: async port => { released.push(port) },
    platform: { scope: () => scope, request: async (_scope, route) => {
      if (route.startsWith('/api/model/my')) return [{ id: 12, model: 'test', apiProtocol: 'OpenAI', usageScenarios: ['OpenApi'] }]
      if (route.endsWith('/list')) return [{ id: 5, status: 1, accessKey: 'platform-secret-fixture', config: { modelIds: [12] } }]
      if (route === '/api/tenant/config') return { baseModelApiUrl: 'https://models.example' }
    } },
  })
  return { controller, allocated, released, changeLanguage: value => { language = value; controller.syncLanguage() }, change: () => { scope = { ...scope, accountId: 'two', epoch: 2 } }, root,
    dispose: async () => { await controller.stop(); await rm(root, { recursive: true, force: true }) } }
}
test('startup reads the shell language and later notifications reach only the owned runtime', async () => {
  const f = await fixture()
  try {
    f.changeLanguage('zh-TW')
    assert.equal(f.controller.status().phase, 'stopped')
    await f.controller.start()
    assert.equal(JSON.parse(await readFile(join(f.controller.scopeDir(), 'observed.json'), 'utf8')).language, 'zh-TW')
    f.changeLanguage('en-US')
    const deadline = Date.now() + 5000
    let observed
    while (Date.now() < deadline) {
      try { observed = JSON.parse(await readFile(join(f.controller.scopeDir(), 'language.json'), 'utf8')) } catch {}
      if (observed === 'en-US') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(observed, 'en-US')
    await f.controller.stop()
    f.changeLanguage('zh-CN')
    assert.equal(f.controller.status().phase, 'stopped')
  } finally { await f.dispose() }
})
test('duplicate starts share one owned child; only a run token reaches it', async () => {
  const f = await fixture()
  try {
    const [first, second] = await Promise.all([f.controller.start(), f.controller.start()])
    assert.equal(first, second)
    const observed = JSON.parse(await readFile(join(f.controller.scopeDir(), 'observed.json'), 'utf8'))
    assert.ok(!JSON.stringify(observed).includes('platform-secret-fixture'))
    assert.equal(observed.env.NUWAX_DSH_DEV_MODEL_PROXY, undefined)
    assert.equal(observed.env.NUWAX_DSH_DEV_MODEL_PROXY_TOKEN, undefined)
    assert.ok(observed.env.NUWAX_DSH_RUN_TOKEN)
    assert.equal(observed.env.HOME, f.controller.scopeDir())
    assert.equal(observed.env.PYTHONDONTWRITEBYTECODE, '1', 'Office must preserve sealed application resources')
    const base = observed.env.NUWAX_DSH_BROKER
    const headers = { Authorization: 'Bearer ' + observed.env.NUWAX_DSH_RUN_TOKEN }
    assert.equal((await fetch(base + '/catalog', { headers })).status, 200)
    f.change(); f.controller.invalidate()
    assert.equal(f.controller.current(), false)
    assert.equal((await fetch(base + '/catalog', { headers })).status, 403)
    await f.controller.stop()
    assert.equal(f.controller.status().phase, 'stopped')
    assert.throws(() => process.kill(observed.pid, 0), /ESRCH/)
    assert.deepEqual(f.released, f.allocated)
    await f.controller.stop()
    assert.deepEqual(f.released, f.allocated, 'private allocations are released exactly once')
  } finally { await f.dispose() }
})
test('development model proxy requires an explicit dev profile and a private loopback capability', () => {
  const input = { development: true, baseUrl: 'http://127.0.0.1:12345', token: 'a'.repeat(64) }
  assert.deepEqual(developmentModelProxy(input), { baseUrl: input.baseUrl, apiKey: input.token })
  assert.equal(developmentModelProxy({ ...input, development: false }), undefined)
  assert.equal(developmentModelProxy({ development: true }), undefined)
  for (const baseUrl of ['https://remote.example', 'http://localhost:12345', 'http://127.0.0.1:12345/path', 'http://user@127.0.0.1:12345', 'http://127.0.0.1:12345/?key=x']) {
    assert.throws(() => developmentModelProxy({ ...input, baseUrl }), /Invalid development/)
  }
  assert.throws(() => developmentModelProxy({ ...input, token: 'short' }), /Invalid development/)
})
test('development proxy preserves selected models and revocation without forwarding platform credentials', async () => {
  let calls = 0
  const upstream = createHttpServer(async (req, res) => {
    calls++
    assert.equal(req.url, '/12/v1/chat/completions')
    assert.equal(req.headers.authorization, 'Bearer ' + 'b'.repeat(64))
    let body = ''; for await (const chunk of req) body += chunk
    assert.equal(JSON.parse(body).model, 'test')
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const f = await fixture(0, developmentModelProxy({ development: true, baseUrl: 'http://127.0.0.1:' + upstream.address().port, token: 'b'.repeat(64) }))
  try {
    await f.controller.start()
    const observed = JSON.parse(await readFile(join(f.controller.scopeDir(), 'observed.json'), 'utf8'))
    const launch = await readFile(join(f.controller.scopeDir(), 'launch.json'), 'utf8')
    assert.ok(!JSON.stringify(observed).includes('b'.repeat(64)))
    assert.ok(!launch.includes('b'.repeat(64)))
    const base = observed.env.NUWAX_DSH_BROKER
    const headers = { Authorization: 'Bearer ' + observed.env.NUWAX_DSH_RUN_TOKEN }
    const post = (id, model) => fetch(base + '/model/' + id + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model, messages: [] }) })
    assert.equal((await post('13', 'test')).status, 404)
    assert.equal((await post('12', 'other')).status, 403)
    const response = await post('12', 'test')
    assert.equal(await response.text(), 'data: [DONE]\n\n')
    assert.equal(calls, 1)
    f.change(); f.controller.invalidate()
    assert.equal((await post('12', 'test')).status, 403)
    assert.equal(calls, 1)
  } finally {
    await f.dispose(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve))
  }
})
test('invalidation interrupts a child waiting for readiness and releases its private ports', async () => {
  const f = await fixture(60000)
  try {
    const opening = f.controller.start()
    // Attach rejection handling before revocation, as the user action can settle it immediately.
    const canceled = assert.rejects(opening, /canceled/)
    const observedFile = join(f.controller.scopeDir(), 'observed.json')
    const deadline = Date.now() + 5000
    let observed
    while (Date.now() < deadline) {
      try { observed = JSON.parse(await readFile(observedFile, 'utf8')); break } catch { await new Promise(resolve => setTimeout(resolve, 10)) }
    }
    assert.ok(observed, 'fixture child must actually start before invalidation')
    await f.controller.stop()
    await canceled
    assert.equal(f.controller.status().phase, 'stopped')
    assert.throws(() => process.kill(observed.pid, 0), /ESRCH/)
    assert.deepEqual(f.released, f.allocated)
  } finally { await f.dispose() }
})
test('stop cancels starts that are still queued', async () => {
  const f = await fixture()
  try {
    const opening = f.controller.start()
    const stopping = f.controller.stop()
    await assert.rejects(opening, /canceled/)
    await stopping
    assert.equal(f.controller.status().phase, 'stopped')
    await f.controller.start()
    assert.equal(f.controller.status().phase, 'ready')
  } finally { await f.dispose() }
})
test('host plugin calls bind to a live runtime generation and cancel when authorization or account changes', async () => {
  const f = await fixture()
  try {
    await assert.rejects(f.controller.plugins('list', {}, new AbortController().signal), /Open DS-Bot/)
    await f.controller.start()
    assert.deepEqual(await f.controller.plugins('list', {}, new AbortController().signal), { operation: 'list' })
    const abort = new AbortController(), pending = f.controller.plugins('list', {}, abort.signal)
    const canceled = assert.rejects(pending, /canceled/); abort.abort(); await canceled
    const stale = f.controller.plugins('list', {}, new AbortController().signal)
    const expired = assert.rejects(stale, /canceled/); f.change(); f.controller.invalidate(); await expired
  } finally { await f.dispose() }
})
