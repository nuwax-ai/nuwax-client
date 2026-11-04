import * as mcpClient from '@deepseek-ai/dsh-mcp-client'

const protectedModule = name => /^(?:@deepseek-ai\/|@nuwax-ai\/|ds-bot(?:\/|$))/.test(name)
const safeJson = value => {
  if (value === null || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor', '__jsExpr'].includes(key)) throw new Error('Unsafe plugin configuration field')
    safeJson(child)
  }
}

/** Native MCP Client and Plugin Manager remain the owners of tools and plugins. */
export function createShellIntegration(ctx, coreBundles) {
  let fork, closed = false, queue = Promise.resolve(), epoch = 0
  const pending = new Map()
  const manager = () => {
    const service = ctx.get('pluginManager')
    if (!service) throw new Error('DSH Plugin Manager unavailable')
    return service
  }
  const configurable = async () => {
    const rows = await manager().listPlugins()
    const allowed = new Set(rows.filter(row => !row.readOnlyReason && !protectedModule(row.moduleName)).map(row => row.patchId))
    return (ctx.get('settings')?.describe({ redactSecrets: true }) ?? []).filter(row => allowed.has(row.ns))
  }
  const revoke = () => {
    epoch++
    for (const [id, abort] of pending) {
      abort.abort()
      void manager().cancelInstall(id).catch(() => {})
    }
  }
  return {
    update(entry) {
      revoke()
      const generation = epoch
      const work = queue.catch(() => {}).then(async () => {
        await fork?.dispose(); fork = undefined
        if (!entry || closed || generation !== epoch) return
        if (typeof entry.command !== 'string' || !Array.isArray(entry.args)) throw new Error('Invalid host MCP connection')
        await new Promise((resolve, reject) => {
          fork = ctx.plugin({
            name: 'nuwax-shell-mcp', inject: ['tools'],
            async apply(inner) {
              try {
                await mcpClient.apply(inner, mcpClient.Config({ serverName: 'nuwax-shell', transport: 'stdio', command: entry.command,
                  args: entry.args, env: entry.env, failOnStartupError: true, toolCallTimeoutMs: 240000, reconnect: { enabled: false } }))
                resolve()
              } catch (error) { reject(error); throw error }
            },
          })
        })
      })
      queue = work
      return work
    },
    cancel(id) {
      pending.get(id)?.abort()
      void manager().cancelInstall(id).catch(() => {})
    },
    async plugins(id, operation, input = {}) {
      if (closed) throw new Error('Host capability connection closed')
      const generation = epoch, abort = new AbortController()
      pending.set(id, abort)
      const check = () => { if (closed || generation !== epoch || abort.signal.aborted) throw new Error('Plugin operation canceled') }
      try {
        const service = manager()
        if (operation === 'list') {
          const bundles = await service.listBundles(), configuration = await configurable()
          check()
          return { bundles: bundles.map(({ name, version, enabled, installed, removable, readOnlyReason, availability, error }) => ({
            name, version, enabled, installed, availability, removable: !coreBundles.includes(name) && removable,
            protected: coreBundles.includes(name), readOnlyReason, error,
          })), configuration }
        }
        if (operation === 'configure') {
          const descriptor = (await configurable()).find(row => row.ns === input.target)
          check()
          if (!descriptor) throw new Error('No public configuration for this third-party plugin')
          if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error('Plugin configuration revision is required')
          if (!input.patch || typeof input.patch !== 'object' || Array.isArray(input.patch) || JSON.stringify(input.patch).length > 512 * 1024) throw new Error('Invalid plugin configuration patch')
          safeJson(input.patch)
          await ctx.get('settings').update(input.target, input.patch, input.expectedRevision)
          check()
          return { applied: true, configuration: (await configurable()).find(row => row.ns === input.target) }
        }
        if (typeof input.target !== 'string' || !input.target.trim() || input.target.length > 500) throw new Error('Invalid plugin target')
        if (coreBundles.includes(input.target)) throw new Error('Core runtime bundles are protected')
        let result
        if (operation === 'install') {
          const inspection = await service.inspect(input.target, undefined, abort.signal)
          check()
          if (inspection.status !== 'accepted') throw new Error('Plugin inspection refused: ' + String(inspection.code ?? inspection.reason ?? 'unavailable'))
          if (!inspection.name || coreBundles.includes(inspection.name)) throw new Error('Core runtime bundles are protected')
          result = await service.installBundle(input.target, { enabled: true, saveExact: true, requestId: id })
        } else if (operation === 'enable' || operation === 'disable') {
          check(); result = await service.setBundleEnabled(input.target, operation === 'enable')
        } else if (operation === 'remove') {
          check(); result = await service.removeBundle(input.target)
        } else throw new Error('Unknown plugin operation')
        check()
        // Package-manager logs may contain environment details. Return only native outcomes.
        const { application, restartReason, saved, persisted, enabled, bundle, version, error, stage } = result
        return { application, restartReason, saved, persisted, enabled, bundle, version, error, stage }
      } finally { pending.delete(id) }
    },
    async dispose() { closed = true; revoke(); await queue.catch(() => {}); await fork?.dispose(); fork = undefined },
  }
}
