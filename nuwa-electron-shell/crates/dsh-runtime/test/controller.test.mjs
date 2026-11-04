import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { RuntimeController, scopeKey } from '../controller.mjs'

async function fixture(readyDelay = 0) {
  const root = await mkdtemp(join(tmpdir(), 'nuwax-dsh-controller-'))
  const runtimeDir = join(root, 'runtime')
  await mkdir(runtimeDir)
  await writeFile(join(runtimeDir, 'host.mjs'), `
    import { readFileSync, writeFileSync } from 'node:fs';
    const launch = JSON.parse(readFileSync(process.env.DSH_HOME + '/launch.json'));
    writeFileSync(process.env.DSH_HOME + '/observed.json', JSON.stringify({ pid: process.pid, env: process.env }));
    process.on('message', message => { if (message.type === 'stop') { process.disconnect(); process.exit(0) } });
    setTimeout(() => process.send({ type: 'ready', url: 'http://127.0.0.1:' + launch.port + '/?token=fixture', port: launch.port }), ${readyDelay});
  `)
  let scope = { origin: 'https://a.example', accountId: 'one', epoch: 1 }
  const allocated = [], released = []
  const saved = new Map([['dsh.authorization.' + scopeKey(scope), { keyId: 5, models: ['12'] }]])
  const controller = new RuntimeController({
    runtimeDir, officeDir: join(root, 'office'), dataDir: root, node: () => process.execPath,
    env: () => ({ PATH: process.env.PATH }),
    settings: { read: key => saved.get(key), write: (key, value) => saved.set(key, value) },
    allocatePort: () => new Promise(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; allocated.push(port); server.close(() => resolve(port)) }) }),
    releasePort: async port => { released.push(port) },
    platform: { scope: () => scope, request: async (_scope, route) => {
      if (route.startsWith('/api/model/my')) return [{ id: 12, model: 'test', apiProtocol: 'OpenAI', usageScenarios: ['OpenApi'] }]
      if (route.endsWith('/list')) return [{ id: 5, status: 1, accessKey: 'platform-secret-fixture', config: { modelIds: [12] } }]
      if (route === '/api/tenant/config') return { baseModelApiUrl: 'https://models.example' }
    } },
  })
  return { controller, allocated, released, change: () => { scope = { ...scope, accountId: 'two', epoch: 2 } }, root,
    dispose: async () => { await controller.stop(); await rm(root, { recursive: true, force: true }) } }
}
test('duplicate starts share one owned child; only a run token reaches it', async () => {
  const f = await fixture()
  try {
    const [first, second] = await Promise.all([f.controller.start(), f.controller.start()])
    assert.equal(first, second)
    const observed = JSON.parse(await readFile(join(f.controller.scopeDir(), 'observed.json'), 'utf8'))
    assert.ok(!JSON.stringify(observed).includes('platform-secret-fixture'))
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
