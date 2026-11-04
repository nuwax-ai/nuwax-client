import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto'

const supported = { OpenAI: 'openai-completions', Anthropic: 'anthropic-messages' }
export function modelSupportReason(value) {
  if (!value?.usageScenarios?.includes('OpenApi')) return 'externalDisabled'
  if (!supported[value.apiProtocol]) return 'protocolUnsupported'
  if (Array.isArray(value.types) && !value.types.includes('Text')) return 'typeUnsupported'
  if (value.functionCall === 'Unsupported') return 'toolsUnsupported'
  if (value.enabled === 0 || value.enabled === false) return 'modelDisabled'
  return undefined
}
export function modelDescriptor(value) {
  if (!value || !/^[1-9]\d*$/.test(String(value.id)) || !Number.isSafeInteger(Number(value.id)) || modelSupportReason(value)) return null
  const positive = (n, fallback) => Number.isSafeInteger(Number(n)) && Number(n) > 0 ? Number(n) : fallback
  return {
    id: String(value.id), provider: `nuwax-${value.id}`,
    name: String(value.name || value.model), model: String(value.model),
    api: supported[value.apiProtocol], contextWindow: positive(value.maxContextTokens, 128000),
    maxTokens: positive(value.maxTokens, 8192),
    input: value.types?.includes('Image') || value.type === 'Multi' ? ['text', 'image'] : ['text'],
  }
}
export function modelTarget(base, id, path) {
  const root = new URL(base.endsWith('/') ? base : base + '/')
  if (!['http:', 'https:'].includes(root.protocol) || root.username || root.password || root.search || root.hash) throw new Error('Invalid model proxy origin')
  return new URL(id + path, root)
}
function authorized(header, token) {
  const value = typeof header === 'string' ? header : ''
  const expected = 'Bearer ' + token
  return Buffer.byteLength(value) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(value), Buffer.from(expected))
}

/** Owns only local capabilities; the real platform key stays in this main-process closure. */
export function createModelBroker({ models, baseUrl, apiKey, current, port, diagnostic = () => {} }) {
  // Validate configuration before admitting any requests.
  modelTarget(baseUrl, '0', '/v1/chat/completions')
  const token = randomBytes(32).toString('hex')
  const selected = new Map(models.map(x => [x.id, x]))
  const requests = new Set()
  let valid = true
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const capability = authorized(req.headers.authorization, token) ||
      (typeof req.headers['x-api-key'] === 'string' && authorized('Bearer ' + req.headers['x-api-key'], token))
    if (!valid || !current() || req.headers.origin || !capability) { res.writeHead(403).end(); return }
    if (req.url === '/catalog' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ models })); return
    }
    const local = new URL(req.url ?? '/', 'http://127.0.0.1')
    const match = /^\/model\/(\d+)(\/v1\/chat\/completions|\/v1\/messages|\/messages)$/.exec(local.pathname)
    const model = match && selected.get(match[1])
    if (!match || !model || req.method !== 'POST' ||
      (model.api === 'openai-completions' ? match[2] !== '/v1/chat/completions' : !['/v1/messages', '/messages'].includes(match[2])) ||
      [...local.searchParams.keys()].some(name => name !== 'beta')) {
      diagnostic({ stage: 'route', status: 404, path: local.pathname.slice(0, 150) }); res.writeHead(404).end(); return
    }
    // A run capability is bound to the selected models, including the body model.
    // Buffer only the input (images can be large); output remains a raw SSE stream.
    const chunks = []
    let size = 0
    try {
      for await (const chunk of req) {
        size += chunk.length
        if (size > 32 * 1024 * 1024) { res.writeHead(413).end(); return }
        chunks.push(chunk)
      }
    } catch { if (!res.destroyed) res.writeHead(400).end(); return }
    const body = Buffer.concat(chunks)
    try {
      if (JSON.parse(body.toString('utf8')).model !== model.model) { res.writeHead(403).end(); return }
    } catch { res.writeHead(400).end(); return }
    if (!valid || !current() || res.destroyed) { res.writeHead(403).end(); return }
    const target = modelTarget(baseUrl, match[1], match[2])
    target.search = local.search
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey, 'trace-id': randomUUID() }
    for (const name of ['anthropic-version', 'anthropic-beta', 'user-agent']) if (typeof req.headers[name] === 'string') headers[name] = req.headers[name]
    if (model.api === 'anthropic-messages') headers['x-api-key'] = apiKey
    const upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { method: 'POST', headers }, response => {
      diagnostic({ stage: 'upstream', status: response.statusCode, modelId: model.id })
      if (!valid || !current()) { response.destroy(); res.destroy(); return }
      res.writeHead(response.statusCode ?? 502, { 'Content-Type': response.headers['content-type'] ?? 'application/json', 'Cache-Control': 'no-store' })
      response.pipe(res)
    })
    requests.add(upstream)
    upstream.on('close', () => requests.delete(upstream))
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502).end('Model proxy connection failed'); else res.destroy() })
    res.on('close', () => upstream.destroy())
    req.on('aborted', () => upstream.destroy())
    upstream.end(body)
  })
  return {
    token,
    async start() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
      return `http://127.0.0.1:${server.address().port}`
    },
    revoke() { valid = false; for (const request of requests) request.destroy() },
    async close() { this.revoke(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) },
  }
}
