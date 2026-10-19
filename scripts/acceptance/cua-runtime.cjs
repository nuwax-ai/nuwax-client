#!/usr/bin/env node
/** Real helper protocol smoke; no capture/input tools, no production state, no broad process cleanup. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const assert = require('node:assert/strict');
const base = path.resolve(__dirname, '../../nuwa-electron-shell/crates/agent-electron-client');
const esbuild = require(path.join(base, 'node_modules/esbuild'));
const helper = process.argv[2];
if (process.platform === 'win32') throw new Error('This read-only smoke currently supports Unix sockets only.');
if (!helper || !fs.existsSync(helper)) throw new Error('Pass a built helper binary path.');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncr-'));
const socket = path.join(dir, 'd');
const token = crypto.randomBytes(32).toString('hex');
const tokenFile = path.join(dir, 'capability');
fs.writeFileSync(tokenFile, token, { mode: 0o600 });
const env = { ...process.env, CUA_DRIVER_RS_TELEMETRY_ENABLED: "false", CUA_DRIVER_DATA_HOME: dir, CUA_DRIVER_NUWAX_TOKEN_FILE: tokenFile };
const policyFile = path.join(dir, 'nuwax-capabilities.yaml');
env.CUA_DRIVER_MANAGED_POLICY_FILE = policyFile;
let daemon, gateway, client;
async function direct(method, name, args) {
  const peer = net.connect(socket); peer.setEncoding('utf8');
  try {
    await once(peer, 'connect');
    return await new Promise((resolve, reject) => {
      let data = '';
      peer.setTimeout(3000, () => reject(new Error('Direct helper request timed out')));
      peer.on('error', reject); peer.on('data', (chunk) => { data += chunk; if(data.includes('\n')) resolve(JSON.parse(data.slice(0,data.indexOf('\n')))); });
      peer.write(JSON.stringify({ method, name, args, nuwax_client_token: token, observation_origin: 'direct', client_kind: 'cli' }) + '\n');
    });
  } finally { peer.destroy(); }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function start() {
  daemon = spawn(helper, ['serve', '--socket', socket, '--permission-mode', 'unrestricted', '--dangerously-bypass-approvals', '--no-permissions-gate'], { env, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    if (daemon.exitCode !== null) throw new Error('Helper exited during smoke startup');
    if (fs.existsSync(socket)) return;
    await sleep(100);
  }
  throw new Error('Helper startup timed out');
}
async function stop() {
  if (!daemon || daemon.exitCode !== null) return;
  const exit = once(daemon, 'exit');
  daemon.kill('SIGTERM');
  const timer = setTimeout(() => daemon.kill('SIGKILL'), 3000);
  await exit; clearTimeout(timer);
  fs.rmSync(socket, { force: true });
}
(async () => {
  const output = path.join(dir, 'runtime.cjs');
  await esbuild.build({ stdin: { contents: `export { CuaMcpGateway } from './src/main/features/computer-use/mcpGateway'; export { CuaTaskController } from './src/main/features/computer-use/taskController'; export { cuaPolicy } from './src/main/features/computer-use/windowScope';`, resolveDir: base }, outfile: output, bundle: true, platform: 'node', format: 'cjs' });
  const { CuaMcpGateway, CuaTaskController, cuaPolicy } = require(output);
  fs.writeFileSync(policyFile, cuaPolicy({ kind: 'window', pid: 2147483646, windowId: 2147483646, label: '' }, [], ['replay_trajectory']), { mode: 0o600 });
  const controller = new CuaTaskController(); controller.setAvailable(true);
  await start();
  const authorization = await direct('authorization_status');
  assert.equal(authorization.result?.managed_policy_active, true);
  assert.equal(authorization.result?.managed_policy_valid, true);
  for (const args of [ { pid: 2147483645, window_id: 2147483646, element_index: 0 }, { pid: 2147483646, window_id: 2147483645, element_index: 0 }, { pid: 2147483646, window_id: 2147483646 } ]) {
    const rejected = await direct('call', 'click', args);
    assert.match(JSON.stringify(rejected), /policy_denied|denied.*policy|policy.*denied/i, 'Native helper must reject out-of-scope or missing element target before platform input');
  }
  console.log('Native managed policy: wrong PID, wrong window ID and missing element index rejected.');
  gateway = new CuaMcpGateway({ controller, allowedTools: ['get_config'], timeoutMs: 10000,
    launch: () => { const child = spawn(helper, ['mcp', '--socket', socket], { env, stdio: ['pipe', 'pipe', 'pipe'] }); child.stderr.on('data', (bytes) => console.error(bytes.toString().replace(/[0-9a-f]{64}/gi, '[redacted]').slice(0, 300))); return child; },
    onFailure: () => {},
  });
  await gateway.listen(path.join(dir, 'g'), token);
  client = net.connect(path.join(dir, 'g')); client.setEncoding('utf8');
  await once(client, 'connect'); client.write(JSON.stringify({ token }) + '\n');
  let buffer = '', sequence = 0;
  const pending = new Map();
  client.on('data', (chunk) => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n');
      const msg = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
      pending.get(msg.id)?.(msg); pending.delete(msg.id);
    }
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => reject(new Error(`MCP response timed out: ${method} #${id}`)), 12000);
    pending.set(id, (reply) => { clearTimeout(timer); resolve(reply); });
    client.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'nuwax-readonly-smoke', version: '1' } });
  assert.ok(init.result?.serverInfo);
  console.log('MCP initialization passed.');
  client.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  assert.ok(!(await call('tools/call', { name: 'get_config', arguments: {} })).result?.isError);
  controller.pause();
  gateway.pauseTransports();
  assert.equal((await call('tools/call', { name: 'get_config', arguments: {} })).result?.structuredContent?.code, 'userPaused');
  await stop();
  await start();
  await gateway.resumeTransports();
  assert.equal(controller.resume(), true);
  const resumed = await call('tools/call', { name: 'get_config', arguments: {} });
  assert.ok(resumed.result && !resumed.result.isError, 'MCP connection must survive a helper restart');
  controller.stop();
  assert.equal((await call('tools/call', { name: 'get_config', arguments: {} })).result?.structuredContent?.code, 'taskStopped');
  console.log('Real helper: MCP initialization, read-only tool, pause, restart/resume and stop gates passed.');
})().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  client?.destroy(); await gateway?.close(); await stop(); fs.rmSync(dir, { recursive: true, force: true });
});
