import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'

/** Account-local durable storage, independent of the runtime's ephemeral HTTP origin. */
export class WorkbenchPresetFiles {
  constructor(scopeDir, current) {
    this.directory = join(scopeDir, 'workbench-layouts')
    this.current = current
    this.pending = new Map()
  }
  check() { if (!this.current()) throw new Error('Workbench authorization expired') }
  file(sessionId) {
    if (typeof sessionId !== 'string' || !/^session-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(sessionId))
      throw new Error('Invalid workbench session')
    return join(this.directory, createHash('sha256').update(sessionId).digest('hex') + '.json')
  }
  parse(raw) {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 1024 * 1024) throw new Error('Invalid saved layouts')
    let value
    try { value = JSON.parse(raw) } catch { throw new Error('Saved layouts are corrupt; stored data was preserved') }
    if (!value || typeof value.revision !== 'string' || !/^[a-f0-9-]{36}$/.test(value.revision) ||
        !Array.isArray(value.items) || value.items.length > 20 || typeof value.locked !== 'boolean')
      throw new Error('Invalid saved layouts')
    return value
  }
  async read(sessionId) {
    this.check()
    const file = this.file(sessionId)
    let raw
    try { raw = await readFile(file, 'utf8') }
    catch (error) { if (error.code !== 'ENOENT') throw error; raw = null }
    this.check()
    if (raw !== null) this.parse(raw)
    return raw
  }
  write(sessionId, expectedRevision, raw) {
    const file = this.file(sessionId)
    const value = this.parse(raw)
    const work = (this.pending.get(file) ?? Promise.resolve()).catch(() => {}).then(async () => {
      this.check()
      const previous = await this.read(sessionId)
      if (expectedRevision !== (previous ? this.parse(previous).revision : null) || value.revision === expectedRevision)
        throw new Error('Saved layout revision conflict; list layouts again')
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const temporary = file + '.' + randomUUID() + '.tmp'
      try {
        await writeFile(temporary, raw, { mode: 0o600, flag: 'wx' })
        this.check()
        await rename(temporary, file)
      } finally { await rm(temporary, { force: true }) }
      this.check()
    })
    this.pending.set(file, work)
    return work.finally(() => { if (this.pending.get(file) === work) this.pending.delete(file) })
  }
}
