import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { RuntimeController } from '../controller.mjs'

export async function verifyPlatformRuntime(request, modelId = '100000121') {
  const root = await mkdtemp(join(tmpdir(), 'nuwax-dsh-live-'))
  const saved = new Map()
  const scope = { origin: 'https://testagent.xspaceagi.com', accountId: 'acceptance-only', epoch: 1 }
  let createdKey
  const runtime = new RuntimeController({
    runtimeDir: fileURLToPath(new URL('../', import.meta.url)), officeDir: fileURLToPath(new URL('../../agent-electron-client/resources/dsh-office', import.meta.url)), dataDir: root,
    node: () => fileURLToPath(new URL('../../agent-electron-client/resources/dsh-office/primary-runtime/dependencies/node/bin/node', import.meta.url)), env: () => ({ PATH: process.env.PATH }),
    settings: { read: key => saved.get(key), write: (key, value) => saved.set(key, value) },
    platform: { scope: () => scope, request: async (_scope, route, method, data) => { const value = await request(route, method, data); if (route.endsWith('/create')) createdKey = value; return value } },
    allocatePort: () => new Promise(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) }) }),
  })
  runtime.on('diagnostic', value => console.log(JSON.stringify(value)))
  try {
    await runtime.authorize([modelId])
    const url = await runtime.start()
    const login = await fetch(url, { redirect: 'manual' })
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    await login.body?.cancel()
    const api = async (endpoint, payload = {}) => {
      const response = await fetch(new URL('/api/bot', url), { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint, payload }), signal: AbortSignal.timeout(35000) })
      const body = await response.json(); assert.equal(body.ok, true, 'DS-Bot refused ' + endpoint); return body.value
    }
    const state = await api('state')
    await api('send', { sessionId: state.mainBotId, text: '请务必调用 list_bots 工具查看团队，看到工具结果后，仅回复 DSH_PLATFORM_OK。' })
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const chat = await api('chat', { botId: state.mainBotId })
      if (chat.items.some(item => item.kind === 'bot' && item.text.includes('DSH_PLATFORM_OK'))) {
        const home=runtime.scopeDir();await runtime.stop();
        const node=fileURLToPath(new URL('../../agent-electron-client/resources/dsh-office/primary-runtime/dependencies/node/bin/node', import.meta.url));
        const proof=JSON.parse(execFileSync(node,[fileURLToPath(new URL('./persisted-proof.cjs',import.meta.url)),home],{encoding:'utf8'}));
        console.log(JSON.stringify({persistence:proof}));
        assert.equal(proof.passed,true,'Persisted DSH tool/result/assistant sequence is missing');
        console.log(JSON.stringify({ level: 'real-dsh-real-platform', modelId, ready: true, toolContinuation: true, persistedHistory: true }))
        return { passed: true, modelId }
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    const report = await api('diagnostics')
    return { passed: false, modelId, diagnostics: { entries:report.entries?.slice(-5), chat:await api('chat',{botId:state.mainBotId}), work:(await api('state')).work, error:(await api('state')).bots.find(value=>value.id===state.mainBotId)?.blocked } }
  } finally {
    await runtime.stop()
    if (createdKey) await request('/api/user/api-key/delete/' + encodeURIComponent(createdKey.accessKey), 'POST')
    await rm(root, { recursive: true, force: true })
  }
}
