import { createHash, randomUUID } from 'node:crypto'
import { fork, execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { modelDescriptor, modelSupportReason, createModelBroker } from './model-broker.mjs'

export function scopeKey(scope) {
  return createHash('sha256').update(scope.origin + '\n' + scope.accountId).digest('hex')
}
const same = (a, b) => a && b && a.origin === b.origin && a.accountId === b.accountId && a.epoch === b.epoch

/** Serializes runtime ownership; invalidation closes admission synchronously. */
export class RuntimeController extends EventEmitter {
  #options; #phase = 'stopped'; #error; #child; #broker; #scope; #url; #queue = Promise.resolve(); #generation = 0; #checkpointFailed = false; #ports = []
  constructor(options) { super(); this.#options = options }
  identity() { return this.#scope ? { ...this.#scope } : null }
  current() { return same(this.#scope, this.#options.platform.scope()) && this.#phase === 'ready' }
  updateShellMcp(entry) {
    if (this.#child?.connected) this.#child.send({ type: 'shell-mcp', entry }, () => {})
  }
  plugins(operation, input, signal) {
    const child = this.#child, generation = this.#generation
    if (!this.current() || !child?.connected) return Promise.reject(new Error('Open DS-Bot before managing its plugins'))
    if (signal.aborted) return Promise.reject(new Error('Plugin operation canceled'))
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const cleanup = () => { clearTimeout(timer); child.off('message', receive); child.off('exit', ended); this.off('invalidated', canceled); signal.removeEventListener('abort', canceled) }
      const cancel = error => { if (child.connected) child.send({ type: 'shell-plugin-cancel', id }, () => {}); cleanup(); reject(error) }
      const canceled = () => cancel(new Error('Plugin operation canceled'))
      const ended = () => cancel(new Error('DSH runtime stopped'))
      const receive = message => {
        if (message?.type !== 'shell-plugin-result' || message.id !== id) return
        if (!this.current() || generation !== this.#generation) { canceled(); return }
        cleanup()
        if (message.error) reject(new Error(message.error)); else resolve(message.value)
      }
      const timer = setTimeout(() => cancel(new Error('Plugin operation timed out')), 240000)
      child.on('message', receive); child.once('exit', ended); this.once('invalidated', canceled); signal.addEventListener('abort', canceled, { once: true })
      child.send({ type: 'shell-plugin-request', id, operation, input }, error => { if (error) ended() })
    })
  }
  scopeDir() { return join(this.#options.dataDir, scopeKey(this.#identity())) }
  status() { return { phase: this.#phase, error: this.#error, available: true } }
  enabled() {
    const scope = this.#options.platform.scope()
    return Boolean(scope && this.#options.settings.read('dsh.enabled.' + scopeKey(scope)) === true)
  }
  disable() {
    const scope = this.#options.platform.scope()
    if (scope) this.#options.settings.write('dsh.enabled.' + scopeKey(scope), false)
    return this.stop()
  }
  #state(phase, error) { this.#phase = phase; this.#error = error; this.emit('status', this.status()) }
  #serial(task) { const next = this.#queue.then(task); this.#queue = next.catch(() => {}); return next }
  #identity() { const scope = this.#options.platform.scope(); if (!scope) throw new Error('Login required'); return scope }
  async #port(name) { const port = await this.#options.allocatePort(name); this.#ports.push(port); return port }
  async catalog(includeUnsupported = false) {
    const scope = this.#identity()
    const [system, space] = await Promise.all(['System', 'Space'].map(tab => this.#options.platform.request(scope, '/api/model/my?tab=' + tab)))
    if (!same(scope, this.#options.platform.scope())) throw new Error('Account changed')
    return [...new Map([...(system ?? []), ...(space ?? [])].map(value => [String(value.id), value])).values()]
      .map(value => modelDescriptor(value) ?? (includeUnsupported && /^\d+$/.test(String(value.id)) ? {
        id: String(value.id), name: String(value.name || value.model), model: String(value.model),
        reason: modelSupportReason(value) ?? 'modelDisabled',
      } : null)).filter(Boolean)
  }
  async authorize(ids) {
    const scope = this.#identity()
    const catalog = await this.catalog()
    if (!Array.isArray(ids) || !ids.length || ids.some(id => !catalog.some(model => model.id === String(id)))) throw new Error('Select supported authorized models')
    const key = 'dsh.authorization.' + scopeKey(scope)
    const saved = this.#options.settings.read(key)
    const keys = await this.#options.platform.request(scope, '/api/user/api-key/list')
    let record = keys.find(item => String(item.id) === String(saved?.keyId))
    if (!record) record = await this.#options.platform.request(scope, '/api/user/api-key/create', 'POST', { name: 'Nuwax DS-Bot ' + scopeKey(scope).slice(0, 10) })
    await this.#options.platform.request(scope, '/api/user/api-key/update', 'POST', {
      accessKey: record.accessKey, name: record.name, status: 1, apiConfigs: [], modelIds: ids.map(Number),
      expire: null,
    })
    if (!same(scope, this.#options.platform.scope())) throw new Error('Account changed')
    if (this.#options.settings.write(key, { keyId: record.id, models: ids.map(String) }) === false) throw new Error('Model authorization was not saved')
    await this.stop()
    return { authorized: ids.map(String) }
  }
  invalidate() { this.#generation++; this.#broker?.revoke(); this.#url = undefined; this.emit('invalidated') }
  start() {
    const admission = this.#generation
    return this.#serial(() => {
      if (admission !== this.#generation) throw new Error('Runtime start was canceled')
      return this.#start()
    })
  }
  async #start() {
    const scope = this.#identity()
    if (this.#phase === 'ready' && same(scope, this.#scope)) return this.#url
    await this.#stop()
    const generation = this.#generation
    this.#scope = scope
    this.#checkpointFailed = false
    const current = () => generation === this.#generation && same(scope, this.#options.platform.scope())
    this.#state('starting')
    try {
      const saved = this.#options.settings.read('dsh.authorization.' + scopeKey(scope))
      const [all, keys, tenant] = await Promise.all([this.catalog(),
        this.#options.platform.request(scope, '/api/user/api-key/list'),
        this.#options.platform.request(scope, '/api/tenant/config')])
      const key = keys.find(item => String(item.id) === String(saved?.keyId) && item.status === 1)
      const models = all.filter(model => saved?.models?.includes(model.id) && key?.config?.modelIds?.map(String).includes(model.id))
      if (!models.length || !key?.accessKey) throw new Error('Authorize Nuwax models before opening DS-Bot')
      if (!tenant.baseModelApiUrl) throw new Error('The tenant has no model API proxy')
      if (!current()) throw new Error('Account changed')
      const home = join(this.#options.dataDir, scopeKey(scope))
      const workspace = join(home, 'workspace')
      await mkdir(workspace, { recursive: true, mode: 0o700 })
      const port = await this.#port('runtime')
      this.#broker = createModelBroker({ models, baseUrl: tenant.baseModelApiUrl, apiKey: key.accessKey, current, port: await this.#port('models'), diagnostic: value => this.emit('diagnostic', value) })
      const broker = await this.#broker.start()
      await writeFile(join(home, 'launch.json'), JSON.stringify({ models, workspace, port, shellMcp: this.#options.shellMcp?.() ?? null }), { mode: 0o600 })
      if (!current()) throw new Error('Account changed')
      const env = { ...this.#options.env(), HOME: home, USERPROFILE: home, DSH_HOME: home,
        // Office imports must not create __pycache__ inside a sealed app bundle.
        PYTHONDONTWRITEBYTECODE: '1',
        NUWAX_DSH_SCOPE_ROOT: home, NUWAX_DSH_BROKER: broker, NUWAX_DSH_RUN_TOKEN: this.#broker.token,
        NUWAX_DSH_OFFICE: this.#options.officeDir, DS_BOT_APP: '1', DSH_TELEMETRY_DISABLED: '1' }
      const child = fork(join(this.#options.runtimeDir, 'host.mjs'), [], {
        execPath: this.#options.node(), cwd: home, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
      this.#child = child
      child.on('message', message => {
        if (message?.type === 'checkpoint-failed' && (this.#child === child || this.#phase === 'stopping')) this.#checkpointFailed = true
        if (message?.type === 'ds-bot:browser-endpoint' && current()) {
          this.emit('browser-endpoint', message, result => { if (current() && child.connected) child.send({ type: 'ds-bot:browser-endpoint-response', id: message.id, ...result }, () => {}) })
        }
      })
      // Child output may contain third-party model diagnostics. Do not persist raw streams.
      child.stdout?.resume(); child.stderr?.resume()
      const ready = await new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timeout); this.off('invalidated', canceled)
          child.off('error', failed); child.off('exit', exited); child.off('message', message)
        }
        const fail = error => { cleanup(); reject(error) }
        const canceled = () => fail(new Error('Runtime start was canceled'))
        const failed = () => fail(new Error('DSH process could not start'))
        const exited = () => fail(new Error('DSH exited before readiness'))
        const message = message => {
          if (message?.type === 'failed') fail(new Error('DSH boot failed: ' + String(message.error).slice(0, 1500)))
          if (message?.type === 'ready') { cleanup(); resolve(message) }
        }
        const timeout = setTimeout(() => fail(new Error('DSH startup timed out')), 45000)
        this.once('invalidated', canceled); child.once('error', failed); child.once('exit', exited); child.on('message', message)
        if (!current()) canceled()
      })
      if (!current() || child.exitCode !== null || child.signalCode !== null || new URL(ready.url).origin !== `http://127.0.0.1:${port}`) throw new Error('Stale or invalid DSH readiness')
      this.#url = ready.url
      child.once('exit', () => { if (this.#child === child && this.#phase === 'ready') { this.invalidate(); this.#state('failed', 'DSH exited'); this.emit('failed') } })
      this.#options.settings.write('dsh.enabled.' + scopeKey(scope), true)
      this.#state('ready')
      this.updateShellMcp(this.#options.shellMcp?.() ?? null)
      return this.#url
    } catch (error) {
      await this.#stop()
      this.#state('failed', error.message)
      throw error
    }
  }
  stop() { this.invalidate(); return this.#serial(() => this.#stop()) }
  async #stop() {
    const child = this.#child
    this.#child = undefined
    this.#url = undefined
    this.#broker?.revoke()
    if (child && child.exitCode === null && child.signalCode === null) {
      this.#state('stopping')
      await new Promise(resolve => {
        const timeout = setTimeout(() => {
          if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => resolve())
          else { try { process.kill(-child.pid, 'SIGKILL') } catch { /* Already reaped. */ } resolve() }
        }, 10000)
        child.once('exit', () => { clearTimeout(timeout); resolve() })
        if (child.connected) child.send({ type: 'stop' }, () => {})
        else child.kill()
      })
    }
    await this.#broker?.close()
    this.#broker = undefined
    await Promise.all(this.#ports.splice(0).map(port => this.#options.releasePort?.(port)))
    this.#state('stopped', this.#checkpointFailed ? 'DSH could not checkpoint all sessions before stopping' : undefined)
  }
}
