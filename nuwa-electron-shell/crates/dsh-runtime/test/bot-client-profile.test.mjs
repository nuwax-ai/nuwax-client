import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Script } from 'node:vm'
import { botClientProfile } from '../bot-client-profile.mjs'

test('the pinned original DS Bot Client produces a compilable Nuwax workbench', async () => {
  const source = await readFile(new URL('../node_modules/ds-bot/client.js', import.meta.url), 'utf8')
  const result = botClientProfile(source)
  assert.doesNotThrow(() => new Script(result))
  assert.notEqual(result, source)
  assert.ok(result.startsWith('// Nuwax DS Bot workbench profile v1\n'))
  assert.ok(result.includes('globalThis.nuwaxBotHost.openSettings()'))
  assert.ok(result.includes('Star DS Bot on GitHub'), 'upstream attribution remains in the workbench')
})

test('unknown or partially adapted upstream source fails before publishing an asset', async () => {
  const source = await readFile(new URL('../node_modules/ds-bot/client.js', import.meta.url), 'utf8')
  assert.throws(() => botClientProfile(source + '\n'), /Unsupported DS Bot Client source/)
  assert.throws(() => botClientProfile(botClientProfile(source)), /Unsupported DS Bot Client source/)
})
