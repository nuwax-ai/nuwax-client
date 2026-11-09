import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  initProfile,
  loadProfileDirectory,
  resolveProfileDir,
  writeProfileBundles,
  readProfileManifest,
  loadLayeredEnv,
} from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import { stringify } from 'yaml'
import { createShellIntegration } from './shell-integration.mjs'
import { createLocaleSync } from './locale.mjs'

const bundles = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@nuwax-ai/dsh-workbench',
]
const anchor = fileURLToPath(new URL('./package.json', import.meta.url))
const send = (message) => {
  if (process.connected) process.send(message)
}
let application, integration, localeSync, stopping

async function stop() {
  if (stopping) return stopping
  stopping = (async () => {
    await integration?.dispose()
    localeSync?.dispose()
    const running = await application?.catch(() => undefined)
    if (running) {
      try {
        await Promise.all(
          running.ctx.sessions
            .list()
            .map((session) => running.ctx.sessions.flush(session))
        )
      } catch {
        send({ type: 'checkpoint-failed' })
      }
      await running.shutdown.shutdown(0)
    }
    send({ type: 'stopped' })
    if (process.connected) process.disconnect()
  })()
  return stopping
}

process.on('message', async (message) => {
  if (message?.type === 'stop') {
    void stop()
    return
  }
  try {
    if (message?.type === 'language') await localeSync?.update(message.language)
    if (message?.type === 'shell-mcp') await integration?.update(message.entry)
    if (message?.type === 'shell-plugin-cancel') integration?.cancel(message.id)
    if (message?.type === 'shell-plugin-request') {
      if (!integration) throw new Error('Workbench is starting')
      const value = await integration.plugins(
        message.id,
        message.operation,
        message.input
      )
      send({ type: 'shell-plugin-result', id: message.id, value })
    }
    if (message?.type === 'workbench-request') {
      const running = await application
      if (!running || stopping) throw new Error('Workbench is unavailable')
      if (message.operation !== 'bind')
        throw new Error('Unknown workbench operation')
      const value = await running.ctx.get('nuwaxWorkbench').bind(message.input)
      send({ type: 'workbench-result', id: message.id, value })
    }
  } catch (error) {
    if (
      message?.type === 'shell-plugin-request' ||
      message?.type === 'workbench-request'
    ) {
      send({
        type:
          message.type === 'workbench-request'
            ? 'workbench-result'
            : 'shell-plugin-result',
        id: message.id,
        error: String(error.message).slice(0, 500),
      })
    }
  }
})
process.once('disconnect', () => {
  void stop()
})

export async function bootWorkbench() {
  const home = process.env.DSH_HOME
  const scopeRoot = process.env.NUWAX_DSH_SCOPE_ROOT
  const within =
    home && scopeRoot && relative(resolve(scopeRoot), resolve(home))
  if (
    !home ||
    !scopeRoot ||
    within === '..' ||
    within.startsWith('../') ||
    within.startsWith('..\\') ||
    isAbsolute(within)
  ) {
    throw new Error('An isolated DSH home is required')
  }
  mkdirSync(home, { recursive: true })
  const launch = JSON.parse(readFileSync(join(home, 'launch.json'), 'utf8'))
  const profileName = 'nuwax-workbench'
  const profileDir = resolveProfileDir(profileName)
  initProfile(profileDir, bundles)
  const manifest = readProfileManifest('dsh', profileDir)
  const others = (manifest.dsh?.profile?.bundles ?? []).filter(
    (name) => !bundles.includes(name)
  )
  writeProfileBundles(profileDir, manifest, [...bundles, ...others])
  const profile = loadProfileDirectory('dsh', profileDir, anchor)
  if (
    profile.skippedBundles.some((bundle) =>
      bundles.includes(bundle.packageName)
    )
  )
    throw new Error('A required workbench bundle could not load')
  const patch = join(home, 'nuwax-workbench.patch.yml')
  writeFileSync(
    patch,
    stringify([
      ...['llm-pi-ai', 'llm-deepseek', 'llm-deepseek-account'].map((id) => ({
        id,
        disabled: true,
      })),
      { id: 'ui-settings-models', config: { credentialOnboarding: false } },
    ]),
    { mode: 0o600 }
  )
  application = runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: profileName,
    resolvedProfile: { profile, installAnchor: anchor },
    patchFiles: [patch],
    args: ['--no-open', '--host', '127.0.0.1', '--port', String(launch.port)],
    packageManager: {
      command: process.execPath,
      args: [
        fileURLToPath(
          new URL('./node_modules/pnpm/bin/pnpm.cjs', import.meta.url)
        ),
      ],
    },
  })
  const running = await application
  const { ctx } = running
  for (const name of [
    'webServer',
    'connection',
    'pluginManager',
    'clientModules',
    'nuwaxWorkbench',
  ]) {
    if (!ctx.get(name))
      throw new Error(`Required workbench service failed: ${name}`)
  }
  localeSync = createLocaleSync(ctx)
  await localeSync.update(launch.language ?? 'zh-CN')
  integration = createShellIntegration(ctx, bundles)
  await integration.update(launch.shellMcp ?? null)
  const url = ctx
    .get('connection')
    .authenticatedUrl(`http://127.0.0.1:${ctx.get('webServer').port}`)
  send({ type: 'ready', url, port: ctx.get('webServer').port })
  return { ...running, url }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  bootWorkbench().catch(async (error) => {
    send({ type: 'failed', error: String(error.message).slice(0, 1000) })
    await stop().catch(() => {})
    process.exitCode = 1
  })
}
