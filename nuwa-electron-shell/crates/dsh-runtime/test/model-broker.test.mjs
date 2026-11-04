import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createModelBroker, modelDescriptor, modelTarget } from '../model-broker.mjs'
import { scopeKey, RuntimeController } from '../controller.mjs'

const model = { id: '12', provider: 'nuwax-12', name: 'Test', model: 'test-model', api: 'openai-completions', input: ['text'], contextWindow: 128000, maxTokens: 8192 }
test('catalog exposes only externally authorized compatible models', () => {
  const source = { id: 12, model: 'test-model', apiProtocol: 'OpenAI', usageScenarios: ['OpenApi'] }
  assert.equal(modelDescriptor(source).provider, 'nuwax-12')
  assert.equal(modelDescriptor({ ...source, usageScenarios: [] }), null)
  assert.equal(modelDescriptor({ ...source, apiProtocol: 'Ollama' }), null)
  assert.equal(modelDescriptor({ ...source, functionCall: 'Unsupported' }), null)
  assert.equal(modelTarget('https://models.example/api/proxy/model', '12', '/v1/chat/completions').pathname, '/api/proxy/model/12/v1/chat/completions')
})
test('streams platform output unchanged, keeps real key private, and revokes stale generations', async () => {
  let received
  const upstream = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    received = { key: req.headers.authorization, body, url: req.url }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"tool_calls":[{"id":"call-1"}]}}]}\n\n')
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  let current = true
  const broker = createModelBroker({ models: [model], baseUrl: 'http://127.0.0.1:' + upstream.address().port + '/proxy', apiKey: 'private-platform-fixture', current: () => current, port: 0 })
  const base = await broker.start()
  const headers = { Authorization: 'Bearer ' + broker.token, 'Content-Type': 'application/json' }
  try {
    assert.equal((await fetch(base + '/catalog')).status, 403)
    assert.equal((await fetch(base + '/catalog', { headers: { ...headers, Origin: 'https://external.example' } })).status, 403)
    const catalog = await (await fetch(base + '/catalog', { headers })).text()
    assert.ok(!catalog.includes('private-platform-fixture'))
    const result = await fetch(base + '/model/12/v1/chat/completions', { method: 'POST', headers, body: '{"model":"test-model","messages":[],"stream":true}' })
    assert.equal(await result.text(), 'data: {"choices":[{"delta":{"tool_calls":[{"id":"call-1"}]}}]}\n\ndata: [DONE]\n\n')
    assert.equal(received.key, 'Bearer private-platform-fixture')
    assert.equal(received.url, '/proxy/12/v1/chat/completions')
    assert.equal((await fetch(base + '/model/13/v1/chat/completions', { method: 'POST', headers })).status, 404)
    current = false
    assert.equal((await fetch(base + '/catalog', { headers })).status, 403)
    current = true; broker.revoke()
    assert.equal((await fetch(base + '/catalog', { headers })).status, 403)
  } finally { await broker.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)) }
})
test('authorization stores identifiers rather than keys and isolates account/domain', async () => {
  const scope = { origin: 'https://a.example', accountId: 'one', epoch: 1 }
  assert.notEqual(scopeKey(scope), scopeKey({ ...scope, origin: 'https://b.example' }))
  assert.notEqual(scopeKey(scope), scopeKey({ ...scope, accountId: 'two' }))
  const stored = new Map()
  let granted
  const controller = new RuntimeController({
    settings: { read: key => stored.get(key), write: (key, value) => stored.set(key, value) },
    platform: { scope: () => scope, request: async (_scope, route, _method, data) => {
      if (route.startsWith('/api/model/my')) return [{ id: 12, model: 'test-model', apiProtocol: 'OpenAI', usageScenarios: ['OpenApi'] }]
      if (route.endsWith('/list')) return []
      if (route.endsWith('/create')) return { id: 5, name: 'fixture', accessKey: 'private-fixture' }
      if (route.endsWith('/update')) { granted = data; return null }
    } },
  })
  await controller.authorize(['12'])
  assert.deepEqual(granted.modelIds, [12])
  assert.ok(!JSON.stringify([...stored]).includes('private-fixture'))
  await assert.rejects(controller.authorize(['13']), /Select supported/)
})

test('binds body model, validates malformed inputs and streams Anthropic without translating tools', async () => {
  let count = 0
  const upstream = createServer(async (req, res) => {
    count++
    assert.equal(req.url, '/proxy/20/v1/messages?beta=true')
    assert.equal(req.headers['x-api-key'], 'private-anthropic-fixture')
    assert.equal(req.headers['anthropic-version'], '2023-06-01')
    for await (const _ of req) { /* Drain bounded body. */ }
    res.writeHead(429, { 'Content-Type': 'application/json' }); res.end('{"type":"error","error":{"type":"rate_limit_error"}}')
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const broker = createModelBroker({ models: [{ ...model, id: '20', api: 'anthropic-messages' }], baseUrl: 'http://127.0.0.1:' + upstream.address().port + '/proxy', apiKey: 'private-anthropic-fixture', current: () => true, port: 0 })
  const base = await broker.start()
  const headers = { 'x-api-key': broker.token, 'anthropic-version': '2023-06-01' }
  try {
    const post = body => fetch(base + '/model/20/v1/messages?beta=true', { method: 'POST', headers, body })
    assert.equal((await post('broken')).status, 400)
    assert.equal((await post('{"model":"unauthorized"}')).status, 403)
    assert.equal(count, 0)
    const result = await post('{"model":"test-model","messages":[]}')
    assert.equal(result.status, 429)
    assert.deepEqual(await result.json(), { type: 'error', error: { type: 'rate_limit_error' } })
    assert.equal(count, 1)
    assert.throws(() => createModelBroker({ models: [], baseUrl: 'file:///tmp/', current: () => true }), /Invalid model/)
  } finally { await broker.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)) }
})
