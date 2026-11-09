import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** The caller narrows this fixture's declared window to 45,056 tokens. Actual
 * inference, steward, checkpoint and history-tool turns still use the platform. */
export async function exercisePlatformContext({ api, state, runtime }) {
  const node = fileURLToPath(new URL('../../agent-electron-client/resources/dsh-office/primary-runtime/dependencies/node/bin/node', import.meta.url))
  const proof = () => JSON.parse(execFileSync(node, [fileURLToPath(new URL('./checkpoint-proof.cjs', import.meta.url)), runtime.scopeDir()], { encoding: 'utf8' }))
  async function until(label, check, duration = 180000) {
    const deadline = Date.now() + duration
    while (Date.now() < deadline) {
      const value = await check()
      if (value) return value
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    throw new Error('Live context acceptance timed out: ' + label)
  }
  const main = state.mainBotId
  await api('send', { sessionId: main, text: '临时验收事实：DSH_HISTORY_ALPHA 的数值是 734291。不写入永久记忆。当前项目还在进行，先回答好并等我后续指令。' })
  const settled = async () => {
    const current = await api('state')
    return Object.keys(current.work.bots).length === 0
  }
  await until('initial turn', settled)
  for (let round = 1; round <= 4; round++) {
    await api('send', { sessionId: main, text: `继续同一个尚未完成的项目，这是第 ${round} 轮材料整理。请逐行输出 250 行，每行用行号开头，后面写“这是持续项目的上下文验收材料，我们还需要继续收集分析验证结果。”。不要省略、合并、写代码或使用工具。此阶段仍有工作未完成，最后问我下一阶段还需哪些材料。` })
    await until('long reply ' + round, settled)
    // Persistence may be between append frames; retry on the next observation.
    let current
    try { current = proof() } catch { /* Writer is still appending. */ }
    if (current?.checkpoints) break
    await new Promise(resolve => setTimeout(resolve, 1500))
  }
  await until('native checkpoint', () => { try { return proof().checkpoints > 0 } catch { return false } }, 60000)
  await api('send', { sessionId: main, text: '请务必调用 read_own_chat 检索 DSH_HISTORY_ALPHA 的原始记录，找出代号对应的数值。工具成功后，只回复 DSH_HISTORY_OK 加上那个数值。' })
  await until('history tool result', async () =>
    (await api('chat', { botId: main })).items.some(item => item.kind === 'bot' && item.text.includes('DSH_HISTORY_OK') && item.text.includes('734291')))
  await until('history persisted', () => { try { return proof().historyLookup } catch { return false } }, 15000)
  const result = proof()
  assert.ok(result.checkpoints > 0 && result.historyLookup)
  console.log(JSON.stringify({ level: 'real-platform-context', declaredTestWindow: 45056, ...result, originalPlugin: true }))
}
