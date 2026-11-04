import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fork } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { createModelBroker } from '../model-broker.mjs'

// Exercises real DSH sessions and unchanged DS-Bot code. Only the remote model is
// deterministic; this evidence does not assert platform billing or model quality.
const home = await mkdtemp(join(tmpdir(), 'nuwax-dsh-smoke-'))
await mkdir(join(home, 'workspace'))
const models = [{ id: '1', provider: 'nuwax-1', name: 'Mock', model: 'mock', api: 'openai-completions', contextWindow: 128000, maxTokens: 8192, input: ['text'] }]
const calls = []
const upstream = createServer(async (req, res) => {
  let text = ''; for await (const chunk of req) text += chunk
  const body = JSON.parse(text)
  assert.equal(req.headers.authorization, 'Bearer fixture-only')
  calls.push(body)
  const index = body.messages.findLastIndex(message => message.role === 'user' && JSON.stringify(message.content).includes('[integration:'))
  const last = body.messages[index]
  const input = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content)
  const continued = body.messages.slice(index + 1).some(message => message.role === 'tool')
  let tool
  if (!continued && last?.role === 'user' && input.includes('[integration:remember]')) tool = { name: 'remember', arguments: JSON.stringify({ text: '用户偏好简体中文。' }) }
  if (!continued && last?.role === 'user' && input.includes('[integration:delegate]')) tool = { name: 'message_bot', arguments: JSON.stringify({ to: 'Worker', message: '[integration:worker]', reply_to: 'user', request_id: 'smoke-work-1' }) }
  if (tool && !body.tools?.some(x => x.function.name === tool.name)) tool = undefined
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const delta = tool ? { tool_calls: [{ index: 0, id: 'call_' + calls.length, type: 'function', function: tool }] }
    : { content: 'DSH integration fixture completed.' }
  const event = (change, finish_reason = null) => 'data: ' + JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: change, finish_reason }] }) + '\n\n'
  res.write(event({ role: 'assistant' }))
  res.write(event(delta))
  res.write(event({}, tool ? 'tool_calls' : 'stop'))
  res.end('data: [DONE]\n\n')
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
const broker = createModelBroker({ models, baseUrl: 'http://127.0.0.1:' + upstream.address().port, apiKey: 'fixture-only', current: () => true, port: 0 })
const brokerUrl = await broker.start()
await writeFile(join(home, 'launch.json'), JSON.stringify({ models, workspace: join(home, 'workspace'), port: 0 }))
let child
let output = ''
let origin, cookie
async function start() {
  child = fork(fileURLToPath(new URL('../host.mjs', import.meta.url)), [], {
    env: { PATH: process.env.PATH, HOME: home, DSH_HOME: home, NUWAX_DSH_SCOPE_ROOT: home,
      NUWAX_DSH_BROKER: brokerUrl, NUWAX_DSH_RUN_TOKEN: broker.token, NUWAX_DSH_REQUIRE_OFFICE: '0', DSH_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  child.stdout.on('data', x => { output = (output + x).slice(-12000) })
  child.stderr.on('data', x => { output = (output + x).slice(-12000) })
  const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Boot timed out: ' + output)), 45000)
    child.on('message', message => {
      if (message.type === 'ready') { clearTimeout(timeout); resolve(message) }
      if (message.type === 'failed') { clearTimeout(timeout); reject(new Error(message.error + '\n' + output)) }
    })
    child.once('exit', code => { clearTimeout(timeout); reject(new Error('Runtime exited ' + code + '\n' + output)) })
  })
  const first = await fetch(ready.url, { redirect: 'manual' })
  cookie = first.headers.getSetCookie().map(x => x.split(';')[0]).join('; ')
  await first.body?.cancel()
  origin = new URL(ready.url).origin
  assert.equal((await fetch(origin, { headers: { Cookie: cookie } })).status, 200)
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise(resolve => child.once('exit', resolve))
  if (child.connected) child.send({ type: 'stop' }, () => {})
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
  await exited
  clearTimeout(timer)
}
async function api(endpoint, payload = {}) {
  const response = await fetch(origin + '/api/bot', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint, payload }), signal: AbortSignal.timeout(35000) })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true, JSON.stringify(body))
  return body.value
}
async function until(check) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)) }
  throw new Error('Functional assertion timed out\n' + JSON.stringify(calls.map(x => ({last: x.messages.at(-1), tools: x.tools?.map(t => t.function.name)}))).slice(-14000) + '\n' + output)
}
try {
  await start()
  const state = await api('state')
  assert.ok(state.models.some(model => model.provider === 'nuwax-1'))
  const main = state.bots.find(bot => bot.id === state.mainBotId)
  assert.ok(main)
  const worker = await api('create-bot', { name: 'Worker', role: 'Integration worker', model: state.defaultModel })
  const room = await api('create-room', { name: 'Integration group', members: [main.id, worker.id] })
  await api('send', { sessionId: main.id, text: '[integration:remember] 用户偏好简体中文。' })
  await until(async () => (await api('memory-view', { botId: main.id })).entries.some(x => JSON.stringify(x).includes('用户偏好简体中文')))
  await until(() => calls.some(call => call.messages.some(message => message.role === 'tool' && String(message.content).includes('memory'))))
  await api('send', { sessionId: main.id, text: '[integration:delegate] Ask Worker to reply in its own chat.' })
  await until(async () => JSON.stringify(await api('chat', { botId: worker.id })).includes('DSH integration fixture completed.'))
  const task = await api('schedule-create', { target: main.id, title: 'Restart reminder', prompt: '[integration:schedule]', when: { kind: 'at', at: new Date(Date.now() + 2000).toISOString() } })
  assert.equal(task.available, true)
  await until(() => calls.some(call => JSON.stringify(call.messages).includes('[integration:schedule]')))
  await until(async () => Object.keys((await api('state')).work.bots).length === 0 && Object.keys((await api('state')).work.rooms).length === 0)
  const before = calls.filter(call => JSON.stringify(call.messages.at(-1)).includes('[integration:schedule]')).length
  await stop()
  await start()
  const recovered = await api('state')
  assert.ok(recovered.bots.some(bot => bot.id === worker.id))
  assert.ok(recovered.rooms.some(value => value.id === room.id))
  assert.ok((await api('memory-view', { botId: main.id })).entries.some(x => JSON.stringify(x).includes('用户偏好简体中文')))
  assert.ok(JSON.stringify(await api('chat', { botId: worker.id })).includes('DSH integration fixture completed.'))
  await new Promise(resolve => setTimeout(resolve, 2500))
  assert.equal(calls.filter(call => JSON.stringify(call.messages.at(-1)).includes('[integration:schedule]')).length, before, 'completed task must not be resubmitted on restart')
  console.log(JSON.stringify({ level: 'real-dsh-with-fixture-provider', page: 200, toolContinuation: true, botMessage: true, memory: true, schedules: true, recovery: true, modelCalls: calls.length }))
} finally {
  await stop()
  await broker.close()
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve))
  await rm(home, { recursive: true, force: true })
}
