import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hook = path.join(root, 'overlay/crates/agent-electron-client/scripts/linux/postinst.sh');
const source = fs.readFileSync(hook, 'utf8');
const base = path.join(root, 'nuwa-electron-shell/crates/agent-electron-client');

// 执行真实 hook，仅把固定 /opt 路径改到自建目录；所有提权工具均模拟。
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-postinst-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const opt = path.join(dir, 'opt');
  const app = path.join(opt, 'Nuwax');
  const sandbox = path.join(app, 'chrome-sandbox');
  const community = path.join(opt, 'NuwaClaw/chrome-sandbox');
  fs.mkdirSync(app, { recursive: true });
  fs.mkdirSync(path.dirname(community), { recursive: true });
  const bytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x66, 0x69, 0x78, 0x74, 0x75, 0x72, 0x65]);
  fs.writeFileSync(sandbox, bytes);
  fs.writeFileSync(community, bytes);
  if (options.missing) fs.unlinkSync(sandbox);
  if (options.symlinkFile) { fs.unlinkSync(sandbox); fs.symlinkSync(community, sandbox); }
  if (options.symlinkDir) { fs.renameSync(app, app + '-actual'); fs.symlinkSync(app + '-actual', app); }
  const entries = Object.fromEntries(['/', opt, app, sandbox, community].map((p) => [p, { uid: 0, gid: 0, mode: p === sandbox ? '755' : '755', links: 1 }]));
  Object.assign(entries[sandbox], options.fileInfo);
  Object.assign(entries[app], options.dirInfo);
  const statePath = path.join(dir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({ entries, calls: [], options }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const tool = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const p = process.env.NUWAX_POSTINST_FIXTURE_STATE;
const state = JSON.parse(fs.readFileSync(p));
const options = state.options;
state.calls.push({name, args});
let output = '', code = 0;
if (name === 'id') output = String(options.uid ?? 0);
else if (name === 'file') output = options.invalidElf ? 'data' : 'ELF 64-bit LSB executable';
else if (name === 'stat') {
  const entry = state.entries[args[2]];
  if (options.statFail || !entry) code = 1;
  else output = args[1].replace(/%u/g, entry.uid).replace(/%g/g, entry.gid).replace(/%a/g, entry.mode).replace(/%h/g, entry.links);
} else if (name === 'chown' || name === 'chmod') {
  const entry = state.entries[args[1]];
  if (!entry || options[name + 'Fail']) code = 1;
  else if (!options[name + 'NoEffect']) {
    if (name === 'chown') { entry.uid = 0; entry.gid = 0; }
    else entry.mode = args[0];
  }
} else code = 99;
fs.writeFileSync(p, JSON.stringify(state));
if (output) process.stdout.write(output + '\\n');
process.exit(code);
`;
  for (const name of ['id', 'file', 'stat', 'chown', 'chmod']) {
    const p = path.join(bin, name);
    fs.writeFileSync(p, tool, { mode: 0o755 });
  }
  assert.ok(source.includes('SANDBOX_PATH="/opt/Nuwax/chrome-sandbox"'));
  const fixtureSource = source.replaceAll('/opt', opt);
  assert.ok(!fixtureSource.includes('SANDBOX_PATH="/opt/Nuwax/chrome-sandbox"'));
  const script = path.join(dir, 'postinst.sh');
  fs.writeFileSync(script, fixtureSource);
  const run = spawnSync('/bin/bash', [script], {
    env: { PATH: `${bin}:/usr/bin:/bin`, NUWAX_POSTINST_FIXTURE_STATE: statePath }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(run.error, undefined);
  const state = JSON.parse(fs.readFileSync(statePath));
  const mutations = state.calls.filter(({ name }) => name === 'chown' || name === 'chmod');
  // 即便误扫社区文件，也只会被模拟工具记录；真实文件内容/权限没有改动。
  assert.equal(fs.statSync(community).mode & 0o4000, 0);
  assert.deepEqual(fs.readFileSync(community), bytes);
  assert.ok(mutations.every(({ args }) => args[1] === sandbox));
  return { run, state, mutations, sandbox };
}

test('pinned deb/rpm hooks and commercial product agree with the fixed Nuwax install directory', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
  assert.equal(pkg.build.deb.afterInstall, 'scripts/linux/postinst.sh');
  assert.equal(pkg.build.rpm.afterInstall, 'scripts/linux/postinst.sh');
  assert.match(fs.readFileSync(path.join(root, 'client.config.mjs'), 'utf8'), /name: 'Nuwax'/);
  assert.ok(!source.includes('/NuwaClaw') && !source.includes('/nuwaclaw'));
  assert.ok(!source.includes('ELECTRON_DISABLE_SANDBOX') && !source.includes('--no-sandbox'));
  assert.doesNotMatch(source, /\$\{[a-zA-Z]+\}/, 'builder template must not reinterpret shell variables');
});

test('Nuwax 755 helper becomes root:root 4755 while an old community installation stays untouched', (t) => {
  const result = fixture(t, { fileInfo: { gid: 42 } });
  assert.equal(result.run.status, 0, result.run.stderr);
  assert.deepEqual(result.mutations.map(({ name, args }) => [name, args]), [
    ['chown', ['root:root', result.sandbox]], ['chmod', ['4755', result.sandbox]],
  ]);
  assert.deepEqual(result.state.entries[result.sandbox], { uid: 0, gid: 0, mode: '4755', links: 1 });
});

for (const [name, options] of [
  ['missing Nuwax helper does not fall back to the old community path', { missing: true }],
  ['non-root invocation', { uid: 1000 }],
  ['symlink helper', { symlinkFile: true }],
  ['symlink parent directory', { symlinkDir: true }],
  ['non-root helper owner', { fileInfo: { uid: 1000 } }],
  ['user-writable parent directory', { dirInfo: { mode: '777' } }],
  ['user-writable helper', { fileInfo: { mode: '777' } }],
  ['hard-linked helper', { fileInfo: { links: 2 } }],
  ['invalid ELF', { invalidElf: true }],
  ['failed ownership inspection', { statFail: true }],
]) test(`${name} refuses privilege changes`, (t) => {
  const result = fixture(t, options);
  assert.equal(result.run.status, 1, result.run.stdout);
  assert.equal(result.mutations.length, 0);
});

for (const [name, options, expected] of [
  ['chown fails', { chownFail: true }, ['chown']],
  ['chown reports success without changing owner', { chownNoEffect: true, fileInfo: { gid: 42 } }, ['chown']],
  ['chmod fails', { chmodFail: true }, ['chown', 'chmod']],
  ['chmod reports success without changing mode', { chmodNoEffect: true }, ['chown', 'chmod']],
]) test(`${name} returns failure rather than claiming sandbox is ready`, (t) => {
  const result = fixture(t, options);
  assert.equal(result.run.status, 1, result.run.stdout);
  assert.deepEqual(result.mutations.map(({ name }) => name), expected);
  assert.doesNotMatch(result.run.stdout, /SUID sandbox enabled/);
});
