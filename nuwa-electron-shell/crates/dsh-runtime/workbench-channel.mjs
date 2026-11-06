import { randomUUID } from 'node:crypto'

/** Requests are settled by the live Client plugin, after native slot operations finish. */
export class WorkbenchChannel {
  constructor(current, timeoutMs = 30000) {
    this.current = current
    this.timeoutMs = timeoutMs
    this.pending = new Map()
    this.ready = false
  }

  connect(send) {
    this.reset()
    this.send = send
  }

  reset() {
    this.ready = false
    for (const request of [...this.pending.values()])
      request.finish(new Error('Workbench document changed'))
  }

  activate() {
    if (!this.current()) throw new Error('Workbench authorization expired')
    this.ready = true
    for (const request of this.pending.values()) this.deliver(request)
  }

  deliver(request) {
    if (request.sent || !this.ready) return
    if (!this.current()) {
      request.finish(new Error('Workbench authorization expired'))
      return
    }
    request.sent = true
    try {
      this.send({
        id: request.id,
        operation: request.operation,
        input: request.input,
      })
    } catch {
      request.finish(new Error('Workbench window unavailable'))
    }
  }

  request(operation, input, signal) {
    if (!this.send || !this.current())
      return Promise.reject(new Error('Open the workbench first'))
    if (signal?.aborted)
      return Promise.reject(new Error('Workbench operation canceled'))
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const finish = (error, value) => {
        if (!this.pending.delete(id)) return
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancel)
        if (error && request.sent && this.current()) {
          try {
            this.send({ id, operation: 'cancel' })
          } catch {
            /* Window already closed. */
          }
        }
        error ? reject(error) : resolve(value)
      }
      const cancel = () => finish(new Error('Workbench operation canceled'))
      const timer = setTimeout(
        () =>
          finish(
            new Error('Workbench Client did not acknowledge the operation')
          ),
        this.timeoutMs
      )
      const request = { id, operation, input, finish, sent: false }
      this.pending.set(id, request)
      signal?.addEventListener('abort', cancel, { once: true })
      this.deliver(request)
    })
  }

  reply(id, result) {
    const request = this.pending.get(id)
    if (!request?.sent) return
    if (!this.current()) {
      request.finish(new Error('Workbench authorization expired'))
      return
    }
    if (result?.ok === true) request.finish(null, result.value)
    else
      request.finish(
        new Error(
          typeof result?.error === 'string'
            ? result.error.slice(0, 500)
            : 'Workbench operation failed'
        )
      )
  }
}
