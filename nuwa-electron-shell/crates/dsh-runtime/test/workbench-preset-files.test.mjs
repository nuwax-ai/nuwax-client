import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { WorkbenchPresetFiles } from '../workbench-presets.mjs'

const session = 'session-11111111-1111-4111-8111-111111111111'
const raw = (revision = randomUUID()) => JSON.stringify({ revision, items: [], locked: false })
test('durable writes compare revisions and survive a new window and changing runtime ports', async t => {
  const home = await mkdtemp(join(tmpdir(), 'workbench-presets-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const files = new WorkbenchPresetFiles(home, () => true)
  const first = raw()
  await files.write(session, null, first)
  const next = new WorkbenchPresetFiles(home, () => true)
  assert.equal(await next.read(session), first)
  await assert.rejects(next.write(session, null, raw()), /revision conflict/)
  assert.equal(await readFile(next.file(session), 'utf8'), first)
  const revision = JSON.parse(first).revision
  const writes = await Promise.allSettled([next.write(session, revision, raw()), next.write(session, revision, raw())])
  assert.equal(writes.filter(row => row.status === 'fulfilled').length, 1)
  assert.equal((await readdir(next.directory)).filter(name => name.endsWith('.tmp')).length, 0)
})

test('account storage and session paths are isolated and revocation blocks writes', async t => {
  const home = await mkdtemp(join(tmpdir(), 'workbench-presets-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  let current = true
  const first = new WorkbenchPresetFiles(join(home, 'account-one'), () => current)
  const second = new WorkbenchPresetFiles(join(home, 'account-two'), () => true)
  await first.write(session, null, raw())
  assert.equal(await second.read(session), null)
  assert.throws(() => first.file('../account-two'), /Invalid/)
  current = false
  await assert.rejects(first.read(session), /authorization expired/)
  await assert.rejects(first.write(session, null, raw()), /authorization expired/)
})
