import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const recipe = ['scripts/computer-use/build-helper.sh', 'scripts/client/native-build-cache.mjs',
  'scripts/client/build-resource-artifacts.mjs', 'docs/computer-use-poc/0001-0003-cua-nuwax-helper-bundle.patch'];

// The production module is copied unchanged. Only its command adapter is replaced,
// so this exercises the real key/save/restore path without a Rust build or host SDK.
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-native-cache-test-'));
  const originalEnv = { ...process.env };
  t.after(() => {
    for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name];
    Object.assign(process.env, originalEnv);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const source = path.join(directory, 'source');
  const workspace = path.join(source, 'libs/cua-driver/rust');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'Cargo.lock'), 'locked dependency graph');
  execFileSync('git', ['init', '-q', source]);
  execFileSync('git', ['-C', source, 'add', '.']);
  const commit = message => execFileSync('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@localhost',
    '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(directory, 'no-hooks')}`, 'commit', '-qm', message]);
  commit('source');

  const producer = path.join(directory, 'producer');
  const consumer = path.join(directory, 'consumer');
  const statePath = path.join(directory, 'tools.json');
  fs.writeFileSync(statePath, '{}');
  const coreUrl = pathToFileURL(path.join(root, 'scripts/client/core.mjs')).href;
  const facade = `export * from ${JSON.stringify(coreUrl)};
import fs from 'node:fs';
export function run(command, args) {
  const statePath = ${JSON.stringify(statePath)};
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  let stdout = '';
  let stderr = '';
  let status = 0;
  if (command === 'rustc' || command === 'cargo') {
    stdout = command + ' ' + (state.version || '1.97.1') + '\\ncommit-hash: compiler-source';
    if (state.notice) { stderr = 'info: syncing channel updates\\ninfo: installing component rust-src\\n'; delete state.notice; fs.writeFileSync(statePath, JSON.stringify(state)); }
    if (state.failure) { status = 1; stdout = ''; stderr = 'compiler unavailable'; }
    if (state.empty) { stdout = ''; stderr = 'warning only'; }
  } else if (String(command).endsWith('vswhere.exe')) {
    stdout = JSON.stringify([{installationPath: ${JSON.stringify(path.join(directory, 'vs'))}, installationVersion: '17.0'}]);
  } else if (String(command).endsWith('cl.exe')) {
    status = 2; stderr = 'Microsoft C/C++ Optimizing Compiler Version ' + (state.nativeVersion || '19.44') + ' for x64';
  } else if (command === 'xcrun') {
    stdout = args.includes('--show-sdk-path') ? '/fixed/sdk' : args.includes('--show-sdk-version') ? '26.0' : 'clang ' + (state.nativeVersion || '17');
  } else if (command === 'xcode-select') stdout = '/fixed/developer';
  else if (command === 'gcc' || command === 'ld' || command === 'pkg-config' || command === 'nasm') stdout = command + ' ' + (state.nativeVersion || '1.0');
  else throw new Error('Unexpected tool: ' + command);
  return {status, stdout, stderr};
}
`;
  for (const target of [producer, consumer]) {
    for (const name of recipe) {
      fs.mkdirSync(path.dirname(path.join(target, name)), { recursive: true });
      fs.copyFileSync(path.join(root, name), path.join(target, name));
    }
    fs.writeFileSync(path.join(target, 'scripts/client/core.mjs'), facade);
  }
  // Windows compiler discovery still reads its declared version/SDK inventory.
  const programFiles = path.join(directory, 'program-files');
  fs.mkdirSync(path.join(programFiles, 'Windows Kits/10/Include/10.0.0'), { recursive: true });
  const msvc = path.join(directory, 'vs/VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt');
  fs.mkdirSync(path.dirname(msvc), { recursive: true }); fs.writeFileSync(msvc, '14.44');
  process.env['ProgramFiles(x86)'] = programFiles;
  delete process.env.NUWAX_CUA_CACHE_DIR;
  delete process.env.RUSTFLAGS;
  process.env.TARGET_ARCH = process.arch;
  const load = target => import(pathToFileURL(path.join(target, 'scripts/client/native-build-cache.mjs')).href);
  const producerApi = await load(producer);
  const consumerApi = await load(consumer);
  const binary = path.join(directory, 'unsigned-helper');
  fs.writeFileSync(binary, 'unsigned compiler output');
  const destination = path.join(directory, 'restored-helper');
  const update = state => fs.writeFileSync(statePath, JSON.stringify(state));
  const transfer = () => fs.cpSync(path.join(producer, '.cache'), path.join(consumer, '.cache'), { recursive: true });
  return { directory, source, producer, consumer, producerApi, consumerApi, binary, destination, update, transfer, commit };
}

test('a fresh rustup component notice cannot turn an exact transported compiler cache into record_missing', async t => {
  const f = await fixture(t);
  f.producerApi.saveHelper(f.producer, f.source, 'native-target', f.binary);
  f.transfer();
  f.update({ notice: true });
  assert.equal(f.consumerApi.restoreHelper(f.consumer, f.source, 'native-target', f.destination), true);
  assert.equal(fs.readFileSync(f.destination, 'utf8'), 'unsigned compiler output');
});

test('artifact lookup identity is stable across successful compiler-manager stderr notices', async t => {
  const f = await fixture(t);
  const expected = f.producerApi.nativeHelperResourceKey(f.producer);
  f.update({ notice: true });
  assert.equal(f.consumerApi.nativeHelperResourceKey(f.consumer), expected);
});

test('real compiler, target, source, dependency lock, recipe and compilation-flag changes still miss', async t => {
  const f = await fixture(t);
  f.producerApi.saveHelper(f.producer, f.source, 'native-target', f.binary);
  f.transfer();
  for (const mutation of [
    () => f.update({ version: '1.98.0' }),
    () => f.update({ nativeVersion: 'different' }),
    () => { f.update({}); process.env.RUSTFLAGS = '-C target-cpu=other'; },
  ]) {
    mutation();
    assert.equal(f.consumerApi.restoreHelper(f.consumer, f.source, 'native-target', f.destination), false);
    delete process.env.RUSTFLAGS;
  }
  f.update({});
  assert.equal(f.consumerApi.restoreHelper(f.consumer, f.source, 'other-target', f.destination), false);
  fs.appendFileSync(path.join(f.source, 'libs/cua-driver/rust/Cargo.lock'), '\nchanged');
  assert.equal(f.consumerApi.restoreHelper(f.consumer, f.source, 'native-target', f.destination), false);
  fs.writeFileSync(path.join(f.source, 'libs/cua-driver/rust/Cargo.lock'), 'locked dependency graph');
  fs.appendFileSync(path.join(f.consumer, recipe[0]), '\n# changed compiler recipe');
  assert.equal(f.consumerApi.restoreHelper(f.consumer, f.source, 'native-target', f.destination), false);
  fs.copyFileSync(path.join(f.producer, recipe[0]), path.join(f.consumer, recipe[0]));
  fs.writeFileSync(path.join(f.source, 'registry.json'), '{"revision":2}');
  execFileSync('git', ['-C', f.source, 'add', '.']);
  f.commit('source changed');
  assert.equal(f.consumerApi.restoreHelper(f.consumer, f.source, 'native-target', f.destination), false);
});

test('a corrupt compiler cache is refused before creating the destination', async t => {
  const f = await fixture(t);
  f.producerApi.saveHelper(f.producer, f.source, 'native-target', f.binary);
  f.transfer();
  const cache = path.join(f.consumer, '.cache/client-toolchain/cua-helper');
  fs.appendFileSync(path.join(cache, fs.readdirSync(cache).find(name => name.endsWith('.bin'))), 'tampered');
  assert.equal(f.consumerApi.restoreHelper(f.consumer, f.source, 'native-target', f.destination), false);
  assert.equal(fs.existsSync(f.destination), false);
});

test('failed or warning-only compiler probes cannot create a reusable identity', async t => {
  const f = await fixture(t);
  f.update({ failure: true });
  assert.throws(() => f.consumerApi.nativeHelperResourceKey(f.consumer), /Cannot identify compiler/);
  f.update({ empty: true });
  assert.throws(() => f.consumerApi.nativeHelperResourceKey(f.consumer), /Cannot identify compiler/);
});
