import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const home = await mkdtemp(join(tmpdir(), 'nuwax-workbench-'))
const workspace = join(home, 'project')
await mkdir(workspace)
await writeFile(join(workspace, 'preview.txt'), 'Workbench file fixture\n')
await writeFile(join(home, 'launch.json'), JSON.stringify({ port: 0, language: 'zh-CN' }))
let child, output = '', counter = 0
async function start() {
  output = ''
  child = fork(fileURLToPath(new URL('../workbench-host.mjs', import.meta.url)), [], {
    env: { PATH: process.env.PATH, HOME: home, DSH_HOME: home, NUWAX_DSH_SCOPE_ROOT: home, DSH_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { output = (output + value).slice(-12000) })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Workbench startup timed out\n' + output)), 45000)
    const finish = error => { clearTimeout(timer); child.off('message', receive); child.off('exit', exited); error ? reject(error) : resolve() }
    const receive = value => {
      if (value.type === 'ready') finish()
      if (value.type === 'failed') finish(new Error(value.error + '\n' + output))
    }
    const exited = () => finish(new Error('Workbench exited\n' + output))
    child.on('message', receive); child.once('exit', exited)
  })
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise(resolve => child.once('exit', resolve))
  child.send({ type: 'stop' }, () => {})
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000)
  await exited; clearTimeout(timer)
}
async function call(channel, operation, input) {
  const id = ++counter
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Workbench operation timed out\n' + output)), 180000)
    const finish = (error, value) => { clearTimeout(timer); child.off('message', receive); child.off('exit', exited); error ? reject(error) : resolve(value) }
    const receive = message => {
      if (message.type !== channel + '-result' || message.id !== id) return
      finish(message.error ? new Error(message.error) : null, message.value)
    }
    const exited = () => finish(new Error('Workbench exited\n' + output))
    child.on('message', receive); child.once('exit', exited)
    child.send({ type: channel + '-request', id, operation, input })
  })
}

try {
  await start()
  const input = { conversationId: 'existing-nuwax-conversation', cwd: workspace }
  const [first, duplicate] = await Promise.all([call('workbench', 'bind', input), call('workbench', 'bind', input)])
  assert.deepEqual(first, duplicate)
  assert.match(first.sessionId, /^session-[a-f0-9-]+$/)
  const second = await call('workbench', 'bind', { ...input, conversationId: 'another-conversation' })
  assert.notEqual(first.sessionId, second.sessionId)
  await assert.rejects(call('workbench', 'bind', { ...input, cwd: join(home, 'missing') }), /ENOENT/)
  await assert.rejects(call('workbench', 'bind', { ...input, cwd: 'relative' }), /absolute/)
  await mkdir(join(home, 'missing'))
  await call('workbench', 'bind', { ...input, cwd: join(home, 'missing') })
  await stop(); await start()
  assert.deepEqual(await call('workbench', 'bind', input), first)
  const list = await call('shell-plugin', 'list', {})
  assert.ok(list.bundles.some(bundle => bundle.name === '@nuwax-ai/dsh-workbench' && bundle.protected))
  console.log(JSON.stringify({ level: 'real-dsh-workbench-host', modelIndependentStartup: true, nativeSessionCarrier: true,
    concurrentBinding: true, sessionIsolation: true, workspaceRetry: true, restart: true }))
} finally {
  await stop()
  await rm(home, { recursive: true, force: true })
}
