import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initProfile, loadProfileDirectory, resolveProfileDir, writeProfileBundles, readProfileManifest, loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import { stringify } from 'yaml'
import { reconcileOfficeRuntime } from './vendor/office-patch.mjs'

const anchor = fileURLToPath(new URL('./package.json', import.meta.url))
const profileName = 'nuwax-plugins'
const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-experimental-voice-input-bundle', '@nuwax-ai/dsh-nuwax-bridge', 'ds-bot']
const send = message => { if (process.connected) process.send?.(message) }
let application
let stopping
async function stop() {
  if (stopping) return stopping
  stopping = (async () => {
    const running = await application?.catch(() => undefined)
    // Checkpoint while the persistence listeners still exist. Profile disposal
    // may unload a consumer before its final asynchronous model turn settles.
    if (running) {
      const sessions = running.ctx.get('sessions')
      try {
        if (sessions) await Promise.all(sessions.list().map(session => sessions.flush(session)))
      } catch { send({ type: 'checkpoint-failed' }) }
    }
    await running?.shutdown.shutdown(0)
    send({ type: 'stopped' })
    if (process.connected) process.disconnect()
  })()
  return stopping
}
process.on('message', message => { if (message?.type === 'stop') void stop() })
process.once('disconnect', () => { void stop() })

export async function bootRuntime() {
  const home = process.env.DSH_HOME
  const scopeRoot = process.env.NUWAX_DSH_SCOPE_ROOT
  const within = home && scopeRoot && relative(resolve(scopeRoot), resolve(home))
  if (!home || !scopeRoot || within === '..' || within.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(within)) throw new Error('An isolated DSH home is required')
  mkdirSync(home, { recursive: true })
  const launch = JSON.parse(readFileSync(join(home, 'launch.json'), 'utf8'))
  const profileDir = resolveProfileDir(profileName)
  initProfile(profileDir, bundles)
  const manifest = readProfileManifest('dsh', profileDir)
  const others = (manifest.dsh?.profile?.bundles ?? []).filter(x => !bundles.includes(x))
  writeProfileBundles(profileDir, manifest, [...bundles, ...others])
  const profile = loadProfileDirectory('dsh', profileDir, anchor)
  const lost = profile.skippedBundles.filter(x => bundles.includes(x.packageName))
  if (lost.length) throw new Error('A required runtime bundle could not load: ' + lost.map(x => x.packageName).join(', '))
  const first = launch.models[0]
  if (!first) throw new Error('No authorized Nuwax models')
  const office = reconcileOfficeRuntime(profile, process.env.NUWAX_DSH_OFFICE)
  if (process.env.NUWAX_DSH_REQUIRE_OFFICE !== '0' && !office.node) throw new Error('Office resources are incomplete; run prepare:dsh')
  if (office.node) {
    const { resolvePrimaryRuntime } = await import('@deepseek-ai/dsh-tool-workspace-dependencies')
    const { discoverRuntime } = await import('@deepseek-ai/libreoffice-kit')
    await resolvePrimaryRuntime(join(process.env.NUWAX_DSH_OFFICE, 'primary-runtime'))
    if (!await discoverRuntime()) throw new Error('Office engine is unavailable')
    process.env.DS_BOT_OFFICE_NODE = office.node
  }
  const patch = join(home, 'nuwax.patch.yml')
  writeFileSync(patch, stringify([
    { id: 'bot', inject: ['nuwaxModels'], config: { browser: true, browserPlugin: 'refs', playwrightUrl: new URL('./node_modules/playwright/index.mjs', import.meta.url).href, updateCheck: false, workspace: launch.workspace } },
    { id: 'agent-default-model', config: { provider: first.provider, model: first.model } },
    ...['llm-pi-ai', 'llm-deepseek', 'llm-deepseek-account'].map(id => ({ id, disabled: true })),
    { id: 'ui-settings-models', config: { credentialOnboarding: false } },
  ]), { mode: 0o600 })
  application = runProfile({
    environment: loadLayeredEnv('dsh'), profile: profileName,
    resolvedProfile: { profile, installAnchor: anchor },
    patchFiles: [patch, ...office.patchFiles],
    args: ['--no-open', '--host', '127.0.0.1', '--port', String(launch.port)],
    packageManager: { command: process.execPath, args: [fileURLToPath(new URL('./node_modules/pnpm/bin/pnpm.cjs', import.meta.url))] },
  })
  const running = await application
  const { ctx } = running
  for (const service of ['webServer', 'connection', 'sessionController', 'workspaceRegistry', 'nuwaxModels', 'speechToText', 'schedule', 'pluginManager', 'clientModules']) {
    if (!ctx.get(service)) throw new Error(`Required DSH service failed: ${service}`)
  }
  const url = ctx.get('connection').authenticatedUrl(`http://127.0.0.1:${ctx.get('webServer').port}`)
  const login = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  await login.body?.cancel()
  const state = await fetch(new URL('/api/bot', url), {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: 'state', payload: {} }), signal: AbortSignal.timeout(10000),
  })
  const result = await state.json()
  if (!state.ok || result.ok !== true || !result.value?.bots || !result.value.models?.some(model => model.provider === first.provider)) throw new Error('DS-Bot API or model catalog is not ready')
  send({ type: 'ready', url, port: ctx.get('webServer').port })
  return { ...running, url }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) bootRuntime().catch(async error => {
  // Avoid serializing error causes containing model credentials or request bodies.
  console.error('DSH boot failed:', error.message)
  send({ type: 'failed', error: String(error.message).slice(0, 2000) })
  await stop().catch(() => {})
  process.exitCode = 1
})
