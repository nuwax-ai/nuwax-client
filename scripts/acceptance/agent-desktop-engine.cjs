/** macOS native smoke test against an isolated temporary app, with no user documents. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const client = path.join(root, 'nuwa-electron-shell/crates/agent-electron-client');
const source = path.join(client, 'src/main/features/computer-use');
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-desktop-smoke-'));
const app = path.join(stage, 'NuwaxDesktopFixture.app');
let adapter, child, transport;
async function main() {
  if (process.platform !== 'darwin') throw new Error('This native fixture requires macOS');
  const mac = path.join(app, 'Contents/MacOS'); fs.mkdirSync(mac, { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>NuwaxDesktopFixture</string><key>CFBundleIdentifier</key><string>com.nuwax.desktop-fixture</string>
  <key>CFBundleName</key><string>NuwaxDesktopFixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  execFileSync('swiftc', [path.join(__dirname, 'fixtures/agent-desktop.swift'), '-o', path.join(mac, 'NuwaxDesktopFixture')]);
  const esbuild = require(require.resolve('esbuild', { paths: [client] }));
  const output = path.join(stage, 'adapter.cjs');
  esbuild.buildSync({ stdin: { resolveDir: root, contents: `export { AgentDesktopAdapter } from ${JSON.stringify(path.join(source, 'agentDesktop.ts'))}; export { createDesktopRunner } from ${JSON.stringify(path.join(source, 'agentDesktopProcess.ts'))};` },
    bundle: true, platform: 'node', format: 'cjs', outfile: output });
  const { AgentDesktopAdapter, createDesktopRunner } = require(output);
  const binary = path.join(client, 'resources/agent-desktop', `darwin-${process.arch}`, `agent-desktop-darwin-${process.arch}`);
  adapter = new AgentDesktopAdapter(createDesktopRunner(binary, () => process.env), path.join(stage, 'state')); adapter.start();
  assert.equal((await adapter.permissions()).accessibility, true, 'Accessibility permission is required for the test host');
  child = spawn(path.join(mac, 'NuwaxDesktopFixture'), [], { stdio: 'ignore' });
  let target;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const reply = await adapter.request('call', 'list_windows', {});
    target = reply.result?.structuredContent?.windows?.find(window => window.pid === child.pid && window.title === 'Nuwax Agent Desktop Fixture');
    if (target) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(target, 'Fixture window must become accessible');
  transport = adapter.transport();
  let sequence = 0, buffer = ''; const pending = new Map();
  transport.stdout.on('data', chunk => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      pending.get(message.id)?.(message.result ?? message.error); pending.delete(message.id);
    }
  });
  const call = (name, args) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => reject(new Error('Fixture RPC timeout')), 20_000);
    pending.set(id, result => { clearTimeout(timer); resolve(result); });
    transport.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
  const args = { pid: target.pid, window_id: target.window_id };
  const observe = async () => {
    const reply = await call('get_window_state', args);
    assert.equal(reply.isError, undefined, JSON.stringify(reply)); return reply.structuredContent;
  };
  let observed = await observe();
  const input = observed.elements.find(element => element.name === 'Fixture input'); assert.ok(input);
  const stale = { ...args, snapshot_id: observed.snapshot_id, element_index: input.element_index, value: 'native-smoke' };
  let action = await call('set_value', stale);
  assert.equal(action.structuredContent.status, 'ok', JSON.stringify(action));
  assert.equal((await call('set_value', stale)).structuredContent.code, 'staleObservation');
  observed = await observe();
  assert.equal(observed.elements.find(element => element.name === 'Fixture input')?.value, 'native-smoke');
  const button = observed.elements.find(element => element.name === 'Apply fixture'); assert.ok(button);
  action = await call('click', { ...args, snapshot_id: observed.snapshot_id, element_index: button.element_index });
  assert.ok(['ok', 'uncertain'].includes(action.structuredContent.status), JSON.stringify(action));
  observed = await observe();
  assert.ok(observed.elements.some(element => element.value === 'applied:native-smoke'), 'Click must update the native fixture label');
  await adapter.stop();
  assert.equal((await call('get_window_state', args)).structuredContent.code, 'operationCancelled');
  console.log(JSON.stringify({ ok: true, platform: process.platform, engine: 'agent-desktop/1.2.0', checks: ['native-observation', 'native-set-value', 'stale-reference-refused', 'native-click-effect', 'stopped-engine-refused'] }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await adapter?.stop(); transport?.kill();
  if (child && child.exitCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('close', resolve)); }
  fs.rmSync(stage, { recursive: true, force: true });
});
