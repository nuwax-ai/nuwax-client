import { Service } from '@deepseek-ai/cordis'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { realpath, stat } from 'node:fs/promises'

export const name = 'nuwax-workbench'
export const inject = ['agents', 'sessionPersistence', 'workspaceRegistry']

/** Stable, account-profile-local carrier identity, independent of ACP restart ids. */
export function carrierId(conversationId, cwd) {
  const hash = createHash('sha256')
    .update(JSON.stringify([conversationId, cwd]))
    .digest('hex')
  return `session-${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(
    13,
    16
  )}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

/** Real DSH Sessions carry plugin state; the ACP engine owns the conversation. */
export class WorkbenchSessions extends Service {
  constructor(ctx) {
    super(ctx, 'nuwaxWorkbench')
    this.entries = new Map()
    this.pending = new Map()
    this.closed = false
    ctx.effect(() => async () => {
      this.closed = true
      await Promise.allSettled([...this.pending.values()])
      const entries = [...this.entries.values()]
      this.entries.clear()
      const results = await Promise.allSettled(
        entries.map((entry) => entry.handle?.dispose())
      )
      const failure = results.find((result) => result.status === 'rejected')
      if (failure) throw failure.reason
    })
  }

  async bind(input) {
    if (this.closed) throw new Error('Workbench is disposed')
    if (
      !input ||
      typeof input.conversationId !== 'string' ||
      !input.conversationId.trim() ||
      input.conversationId.length > 200
    ) {
      throw new Error('A host-owned conversation is required')
    }
    if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd))
      throw new Error('An absolute local workspace is required')
    const cwd = await realpath(input.cwd)
    if (!(await stat(cwd)).isDirectory())
      throw new Error('Workspace is not a directory')
    if (this.closed) throw new Error('Workbench is disposed')
    const id = carrierId(input.conversationId, cwd)
    const binding = { sessionId: id, conversationId: input.conversationId, cwd }
    const existing = this.entries.get(id)
    if (existing && existing.agent === this.ctx.agents.get(id)) return binding
    if (existing) {
      this.entries.delete(id)
      await existing.handle?.dispose()
    }
    if (!this.pending.has(id)) {
      const pending = this.open(binding).finally(() => this.pending.delete(id))
      this.pending.set(id, pending)
    }
    await this.pending.get(id)
    if (this.closed) throw new Error('Workbench is disposed')
    return binding
  }

  async open(binding) {
    const { sessionId, cwd } = binding
    let handle
    try {
      let agent = this.ctx.agents.get(sessionId)
      if (!agent) {
        try {
          handle = await this.ctx.agents.resume({ resumeSessionId: sessionId })
        } catch (error) {
          if (!(error instanceof SessionPersistenceNotFoundError)) throw error
          handle = await this.ctx.agents.create({ sessionId, meta: { cwd } })
        }
        agent = handle.agent
      }
      if (agent.session.header.cwd !== cwd)
        throw new Error('Workspace binding changed')
      await this.ctx.sessions.flush(agent.session)
      await this.ctx.workspaceRegistry.create(cwd)
      if (this.closed) throw new Error('Workbench is disposed')
      this.entries.set(sessionId, { agent, handle })
    } catch (error) {
      this.entries.delete(sessionId)
      await handle?.dispose()
      throw error
    }
  }
}

export function apply(ctx) {
  ctx.plugin(WorkbenchSessions)
}
