import { bootRuntime } from '../host.mjs'
const running = await bootRuntime()
const { ctx } = running
process.on('message', async message => {
  if (message.type !== 'plugin-test') return
  try {
    const manager = ctx.get('pluginManager')
    let value
    if (message.action === 'list') value = { bundles: await manager.listBundles(), plugins: await manager.listPlugins(), clients: ctx.get('clientModules').graph().entries.map(entry => entry.id) }
    else if (message.action === 'install') value = await manager.installBundle(message.spec, { enabled: true, saveExact: true })
    else if (message.action === 'enable') value = await manager.setBundleEnabled('nuwax-test-plugin', message.enabled)
    else if (message.action === 'voice-state') value = ctx.get('speechToText').snapshot()
    else if (message.action === 'voice-prepare') { ctx.get('speechToText').prepare('sensevoice-local'); value = true }
    else if (message.action === 'voice-cancel') { await ctx.get('speechToText').cancelPreparation('sensevoice-local'); value = true }
    else if (message.action === 'voice-transcribe') { const { readFile } = await import('node:fs/promises'); const speech = ctx.get('speechToText'); value = await speech.transcribe(speech.resolve({audio:await readFile(message.file),language:'en'}),AbortSignal.timeout(90000)); }
    else if (message.action === 'remove') value = await manager.removeBundle('nuwax-test-plugin')
    process.send({ type: 'plugin-result', id: message.id, value })
  } catch (error) { process.send({ type: 'plugin-result', id: message.id, error: error.message }) }
})
