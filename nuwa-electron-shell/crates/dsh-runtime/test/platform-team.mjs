import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Explicit live acceptance, invoked only with the platform-runtime fixture. */
export async function exercisePlatformTeam({ api, state, runtime }) {
  async function until(label, check) {
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      const value = await check()
      if (value) return value
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw new Error('Live team acceptance timed out: ' + label)
  }
  const main = state.bots.find(bot => bot.id === state.mainBotId)
  const worker = await api('create-bot', {
    name: 'AcceptanceWorker', role: 'Integration acceptance worker', model: state.defaultModel,
    instructions: 'Follow the acceptance instructions. Answer short marker requests exactly; do not delegate them to anyone else.',
  })
  await api('send', { sessionId: main.id, text: '请务必调用 message_bot，to 为 AcceptanceWorker，reply_to 为 me，request_id 为 live-team-acceptance-1，message 为“仅回复 DSH_WORKER_OK”。收到它的回复后，仅回复 DSH_TEAM_OK。' })
  await until('bidirectional Bot result', async () =>
    JSON.stringify(await api('exchange', { a: main.id, b: worker.id })).includes('DSH_WORKER_OK') &&
    (await api('chat', { botId: main.id })).items.some(item => item.kind === 'bot' && item.text.includes('DSH_TEAM_OK')))
  await api('send', { sessionId: main.id, text: '请调用 remember 工具记住：集成验收偏好是 DSH_ACCEPTANCE_MEMORY。工具成功后仅回复 DSH_MEMORY_OK。' })
  await until('real memory tool', async () => (await api('memory-view', { botId: main.id })).entries.some(value => String(value.text ?? '').includes('DSH_ACCEPTANCE_MEMORY')))
  const room = await api('create-room', { name: 'Live acceptance group', members: [main.id, worker.id], admin: main.id })
  await api('send', { sessionId: room.id, text: '@all 这是群聊集成验收。每个 Bot 只回复一次 DSH_GROUP_OK，并写上自己的名字；不调用工具或其他 Bot。' })
  const replies = await until('two group participants', async () => {
    // DS-Bot's chat endpoint pages only Bot-owned chats. Group messages are
    // projected through the original DSH Client; inspect their durable log here.
    const saved = JSON.parse(await readFile(join(runtime.scopeDir(), 'bot/state.json'), 'utf8'))
    const posts = (saved.rooms[room.id].log ?? []).filter(item => item.kind === undefined && [main.name, worker.name].includes(item.who) && String(item.text ?? '').includes('DSH_GROUP_OK'))
    return new Set(posts.map(item => item.who)).size >= 2 && posts
  })
  await api('schedule-create', { target: main.id, title: 'Live acceptance reminder', prompt: '请仅回复 DSH_SCHEDULE_OK。', when: { kind: 'at', at: new Date(Date.now() + 2000).toISOString() } })
  const scheduledReplies = async call => (await call('chat', { botId: main.id })).items.filter(item => item.kind === 'bot' && item.text.includes('DSH_SCHEDULE_OK')).length
  await until('real scheduled turn', () => scheduledReplies(api))
  await until('all work settled', async () => {
    const value = await api('state')
    return Object.keys(value.work.bots).length === 0 && Object.keys(value.work.rooms).length === 0
  })
  const before = await scheduledReplies(api)
  await runtime.stop()
  const url = await runtime.start()
  const login = await fetch(url, { redirect: 'manual' })
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  await login.body?.cancel()
  const recoveredApi = async (endpoint, payload = {}) => {
    const response = await fetch(new URL('/api/bot', url), { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint, payload }), signal: AbortSignal.timeout(35000) })
    const value = await response.json()
    assert.equal(value.ok, true, 'Recovered API refused ' + endpoint)
    return value.value
  }
  const recovered = await recoveredApi('state')
  assert.ok(recovered.bots.some(bot => bot.id === worker.id))
  assert.ok(recovered.rooms.some(group => group.id === room.id))
  assert.ok((await recoveredApi('memory-view', { botId: main.id })).entries.some(value => String(value.text ?? '').includes('DSH_ACCEPTANCE_MEMORY')))
  assert.ok(JSON.stringify(await recoveredApi('exchange', { a: main.id, b: worker.id })).includes('DSH_WORKER_OK'))
  await new Promise(resolve => setTimeout(resolve, 3000))
  assert.equal(await scheduledReplies(recoveredApi), before, 'completed scheduled work must not repeat on restart')
  console.log(JSON.stringify({ level: 'real-platform-team', bidirectionalBotResult: true, memoryTool: true, groupParticipants: new Set(replies.map(value => value.who)).size, schedules: true, recovery: true, duplicateSchedule: false }))
}
