import test from 'node:test'
import assert from 'node:assert/strict'
import { WorkbenchChannel } from '../workbench-channel.mjs'

test('commands wait for a mounted Client and return its actual result', async () => {
  const sent = []
  const channel = new WorkbenchChannel(() => true)
  channel.connect(request => sent.push(request))
  const pending = channel.request('open', { sessionId: 'one', kind: 'files' })
  assert.equal(sent.length, 0)
  channel.activate()
  assert.equal(sent.length, 1)
  channel.reply(sent[0].id, { ok: true, value: { tabs: ['real-tab'] } })
  assert.deepEqual(await pending, { tabs: ['real-tab'] })
})

test('navigation cancels old commands, ignores their late replies and admits the next Client', async () => {
  const sent = []
  const channel = new WorkbenchChannel(() => true)
  channel.connect(request => sent.push(request)); channel.activate()
  const first = channel.request('bind', {})
  const rejected = assert.rejects(first, /document changed/)
  channel.reset()
  await rejected
  channel.reply(sent[0].id, { ok: true, value: 'stale' })
  const next = channel.request('state', {})
  channel.activate()
  channel.reply(sent.at(-1).id, { ok: true, value: 'current' })
  assert.equal(await next, 'current')
})

test('cancellation and authority changes reject live Client results', async () => {
  let current = true
  const sent = []
  const channel = new WorkbenchChannel(() => current)
  channel.connect(request => sent.push(request)); channel.activate()
  const abort = new AbortController()
  const first = channel.request('bind', {}, abort.signal)
  const rejected = assert.rejects(first, /canceled/)
  abort.abort(); await rejected
  assert.equal(sent.at(-1).operation, 'cancel')
  const next = channel.request('state', {})
  current = false
  channel.reply(sent.at(-1).id, { ok: true, value: 'old-account' })
  await assert.rejects(next, /expired/)
})

test('an unmounted or stalled Client times out rather than claiming a layout change', async () => {
  const channel = new WorkbenchChannel(() => true, 10)
  channel.connect(() => {})
  await assert.rejects(channel.request('open', {}), /did not acknowledge/)
})
