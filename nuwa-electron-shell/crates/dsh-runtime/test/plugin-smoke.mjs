import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createModelBroker } from '../model-broker.mjs'
const home = await mkdtemp(join(tmpdir(), 'nuwax-dsh-plugins-'))
const plugin = join(home, 'fixture-plugin')
await mkdir(plugin)
await writeFile(join(plugin, 'package.json'), JSON.stringify({ name: 'nuwax-test-plugin', version: '1.0.0', license: 'MIT', type: 'module', main: 'index.js', exports: { '.': './index.js', './client': './client.js', './package.json': './package.json' }, dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } }))
await writeFile(join(plugin, 'index.js'), "export const name='nuwax-test-plugin'; export function apply(ctx) { ctx.effect(() => () => {}); }")
await writeFile(join(plugin, 'client.js'), "window.__ModuleLoader__.load({id:'nuwax-test-plugin',factory:()=>({name:'nuwax-test-plugin',apply:()=>{window.__NUWAX_PLUGIN_TEST__=true;}})});")
await writeFile(join(plugin, 'cordis.patch.yml'), "- insert:\n    - id: nuwax-test-plugin\n      name: nuwax-test-plugin\n")
const models = [{ id: '1', provider: 'nuwax-1', name: 'Fixture', model: 'fixture', api: 'openai-completions', input: ['text'], contextWindow: 128000, maxTokens: 8192 }]
const broker = createModelBroker({ models, baseUrl: 'http://127.0.0.1:1/', apiKey: 'fixture', current: () => true, port: 0 })
const base = await broker.start()
await writeFile(join(home, 'launch.json'), JSON.stringify({ models, workspace: join(home, 'workspace'), port: 0 }))
let child, output = '', nextId = 0
async function start() {
  child = fork(fileURLToPath(new URL('./plugin-driver.mjs', import.meta.url)), [], { env: { PATH: process.env.PATH, HOME: home, DSH_HOME: home, NUWAX_DSH_SCOPE_ROOT: home, NUWAX_DSH_BROKER: base, NUWAX_DSH_RUN_TOKEN: broker.token, NUWAX_DSH_REQUIRE_OFFICE: '0', DSH_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  child.stdout.on('data', value => { output = (output + value).slice(-12000) }); child.stderr.on('data', value => { output = (output + value).slice(-12000) })
  await new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error(output)), 45000); child.on('message', value => { if (value.type === 'ready') { clearTimeout(timeout); resolve() } if (value.type === 'failed') { clearTimeout(timeout); reject(new Error(value.error + '\n' + output)) } }); child.once('exit', () => { clearTimeout(timeout); reject(new Error(output)) }) })
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise(resolve => child.once('exit', resolve))
  child.send({ type: 'stop' }, () => {})
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000); await exited; clearTimeout(timer)
}
async function action(action, fields = {}) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.off('message', listener); reject(new Error('Plugin operation timed out\n' + output)) }, 120000)
    const listener = message => { if (message.type !== 'plugin-result' || message.id !== id) return; clearTimeout(timeout); child.off('message', listener); message.error ? reject(new Error(message.error)) : resolve(message.value) }
    child.on('message', listener); child.send({ type: 'plugin-test', id, action, ...fields })
  })
}
try {
  await start()
  const installed = await action('install', { spec: plugin })
  assert.notEqual(installed.application, 'failed', JSON.stringify(installed))
  await stop(); await start()
  let list = await action('list')
  assert.ok(list.plugins.some(value => value.moduleName === 'nuwax-test-plugin' && value.fiberPhase === 'active'))
  assert.ok(list.clients.includes('nuwax-test-plugin'))
  assert.ok(list.bundles.find(value => value.name === 'ds-bot').removable === false)
  await action('enable', { enabled: false }); await stop(); await start()
  list = await action('list'); assert.ok(!list.clients.includes('nuwax-test-plugin'))
  await action('enable', { enabled: true }); await stop(); await start()
  list = await action('list'); assert.ok(list.clients.includes('nuwax-test-plugin'))
  const removed = await action('remove'); assert.notEqual(removed.application, 'failed', JSON.stringify(removed))
  await stop(); await start()
  list = await action('list'); assert.ok(!list.clients.includes('nuwax-test-plugin'))
  console.log(JSON.stringify({ level: 'real-dsh-plugin-manager', install: true, hostAndClientDiscovery: true, disable: true, enable: true, remove: true }))
} finally { await stop(); await broker.close(); await rm(home, { recursive: true, force: true }) }
