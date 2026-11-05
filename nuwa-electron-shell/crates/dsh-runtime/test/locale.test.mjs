import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createLocaleSync, dshLanguage } from '../locale.mjs'

function fixture() {
  const events = new EventEmitter(), writes = []
  let preference = 'en', fail = false
  const settings = {
    describe: () => [{ ns: 'locale', value: { preference } }],
    update: async (namespace, value) => {
      if (fail) throw new Error('write failed')
      writes.push({ namespace, ...value }); preference = value.preference
      events.emit('settings/document-updated', namespace)
    },
  }
  const sync = createLocaleSync({ get: () => settings, logger: { warn() {} },
    on: (event, listener) => { events.on(event, listener); return () => events.off(event, listener) },
  })
  return { sync, writes, read: () => preference, fail: value => { fail = value },
    external: value => { preference = value; events.emit('settings/document-updated', 'locale') } }
}

test('shell locales map to the dictionaries shipped by DSH', () => {
  for (const language of ['zh', 'zh-CN', 'ZH-tw', 'zh-HK', ' zh-cn ']) assert.equal(dshLanguage(language), 'zh')
  for (const language of ['en', 'en-US', 'ja-JP', undefined, 'zhinvalid']) assert.equal(dshLanguage(language), 'en')
})

test('initial and live updates follow the shell; stale Client preferences cannot diverge', async () => {
  const f = fixture()
  try {
    await f.sync.update('zh-CN')
    assert.equal(f.read(), 'zh')
    await f.sync.update('en-US')
    assert.equal(f.read(), 'en')
    await Promise.all([f.sync.update('en'), f.sync.update('zh-CN'), f.sync.update('en-US'), f.sync.update('zh-TW')])
    assert.equal(f.read(), 'zh')
    f.external('en')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.read(), 'zh')
    assert.ok(f.writes.every(write => write.namespace === 'locale'))
    const count = f.writes.length
    await f.sync.update('zh-HK')
    assert.equal(f.writes.length, count, 'same dictionary does not write or broadcast again')
    f.sync.dispose()
    f.external('en')
    await f.sync.update('zh')
    assert.equal(f.read(), 'en', 'disposed runtime stops writing')
  } finally { f.sync.dispose() }
})

test('a failed update can recover on the next language notification', async () => {
  const f = fixture()
  try {
    f.fail(true)
    await assert.rejects(f.sync.update('zh-CN'), /write failed/)
    f.fail(false)
    await f.sync.update('zh-CN')
    assert.equal(f.read(), 'zh')
  } finally { f.sync.dispose() }
})
