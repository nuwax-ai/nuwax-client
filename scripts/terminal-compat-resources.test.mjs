import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as core from './client/core.mjs';
import { prepareTerminalCompatResources, inspectTerminalCompatResource, terminalCompatDirectory, verifyPackagedTerminalCompat } from './client/terminal-compat-resources.mjs';
import { builderConfig } from './client/pack.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-compat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
  const archive = 'upstream archive';
  const license = 'MIT license fixture';
  const lock = {
    schema: 1, goToolchain: 'go1.25.6',
    source: { archive: 'winpty.zip', url: 'https://example.invalid/winpty.zip', sha256: hash(archive), licenseSha256: hash(license) },
    files: Object.fromEntries(['winpty.dll', 'winpty-agent.exe'].map(name => [name, { archivePath: 'x64/bin/' + name, sha256: hash(name) }])),
  };
  write(path.join(root, 'third-party/terminal-compat-sources.json'), JSON.stringify(lock));
  write(path.join(root, 'third-party/licenses/winpty.txt'), license);
  write(path.join(root, 'native/legacy-terminal/main.go'), 'package main');
  write(path.join(root, 'native/legacy-terminal/go.mod'), 'module fixture');
  write(path.join(root, 'native/legacy-terminal/go.sum'), 'locked module');
  const calls = [];
  const state = { download: archive };
  const tools = {
    ...core,
    run(command, args, options) {
      calls.push({ command, args, options });
      if (command === 'curl') write(args[args.indexOf('--output') + 1], state.download);
      if (command === 'unzip' || command === 'powershell.exe') {
        const destination = command === 'unzip' ? args.at(-1) : /-DestinationPath '([^']+)'/.exec(args.at(-1))[1];
        write(path.join(destination, 'LICENSE'), license);
        for (const [name, entry] of Object.entries(lock.files)) write(path.join(destination, entry.archivePath), name);
      }
      if (command === 'go') write(args[args.indexOf('-o') + 1], 'MZ compatibility service ' + calls.length);
      return { status: 0, stdout: '', stderr: '' };
    },
  };
  return { root, tools, calls, state, write, options: { platform: 'win32', arch: 'x64', tools } };
}

test('non-Windows skips WinPTY and unsupported architecture fails explicitly', async t => {
  const f = fixture(t);
  assert.equal(await prepareTerminalCompatResources(f.root, { ...f.options, platform: 'darwin' }), null);
  await assert.rejects(prepareTerminalCompatResources(f.root, { ...f.options, arch: 'arm64' }), /requires x64/);
  assert.equal(f.calls.length, 0);
});

test('build verifies upstream files, pins Go toolchain and reuses identical resources', async t => {
  const f = fixture(t);
  const directory = await prepareTerminalCompatResources(f.root, f.options);
  assert.equal(directory, terminalCompatDirectory(f.root));
  assert.ok(inspectTerminalCompatResource(f.root, f.options));
  const build = f.calls.find(call => call.command === 'go');
  assert.equal(build.options.env.GOTOOLCHAIN, 'go1.25.6');
  assert.equal(build.options.env.CGO_ENABLED, '0');
  assert.equal(build.options.env.GOOS, 'windows');
  assert.equal(build.options.env.GOAMD64, 'v1');
  assert.equal(build.options.env.GOWORK, 'off');
  assert.ok(build.args.includes('-mod=readonly'));
  f.calls.length = 0;
  await prepareTerminalCompatResources(f.root, f.options);
  assert.equal(f.calls.length, 0);
});

test('modified DLL, executable or source invalidates admission and rebuilds', async t => {
  const f = fixture(t);
  const directory = await prepareTerminalCompatResources(f.root, f.options);
  for (const file of ['winpty.dll', 'ttyd-legacy.exe']) {
    f.write(path.join(directory, file), 'corrupt');
    assert.equal(inspectTerminalCompatResource(f.root, f.options), null);
    f.calls.length = 0;
    await prepareTerminalCompatResources(f.root, f.options);
    assert.ok(f.calls.some(call => call.command === 'go'));
  }
  f.write(path.join(f.root, 'native/legacy-terminal/main.go'), 'package changed');
  assert.equal(inspectTerminalCompatResource(f.root, f.options), null);
  await prepareTerminalCompatResources(f.root, f.options);
  assert.ok(inspectTerminalCompatResource(f.root, f.options));
});

test('corrupt upstream download never reaches build or resources', async t => {
  const f = fixture(t);
  f.state.download = 'corrupt archive';
  await assert.rejects(prepareTerminalCompatResources(f.root, f.options), /SHA256 mismatch/);
  assert.equal(f.calls.some(call => call.command === 'go'), false);
  assert.equal(fs.existsSync(terminalCompatDirectory(f.root)), false);
});

test('changed license text blocks preparation', async t => {
  const f = fixture(t);
  f.write(path.join(f.root, 'third-party/licenses/winpty.txt'), 'wrong license');
  await assert.rejects(prepareTerminalCompatResources(f.root, f.options), /SHA256 mismatch/);
  assert.equal(f.calls.some(call => call.command === 'go'), false);
});

test('real package admission rejects omitted or changed runtime payload', async t => {
  const f = fixture(t);
  const prepared = await prepareTerminalCompatResources(f.root, f.options);
  const output = path.join(f.root, 'release');
  fs.mkdirSync(output);
  assert.throws(() => verifyPackagedTerminalCompat(f.root, output, f.options), /missing compatibility resources/);
  const packaged = path.join(output, 'win-unpacked/resources/ttyd/legacy/win32-x64');
  fs.mkdirSync(path.dirname(packaged), { recursive: true });
  fs.cpSync(prepared, packaged, { recursive: true });
  assert.deepEqual(verifyPackagedTerminalCompat(f.root, output, f.options), [packaged]);
  f.write(path.join(packaged, 'winpty-agent.exe'), 'wrong');
  assert.throws(() => verifyPackagedTerminalCompat(f.root, output, f.options), /Packaged resource mismatch/);
});

test('macOS and Linux packages exclude Windows compatibility payloads', () => {
  const pkg = { build: { extraResources: [{ from: 'resources/ttyd', to: 'ttyd', filter: ['**/*'] }] } };
  for (const platform of ['darwin', 'linux', 'win32']) {
    const config = builderConfig(pkg, { platform, frontendDist: '/frontend', output: '/out', version: '3.0.16',
      builderVersions: { electronBuilder: '25.1.8', appBuilderLib: '25.1.8' } });
    const ttyd = config.extraResources.find(entry => entry.to === 'ttyd');
    assert.equal(ttyd.filter.includes('!legacy/**'), platform !== 'win32');
  }
});

test('CI and release builders use the locked Go toolchain and Windows regression', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const lock = core.readJson(path.join(root, 'third-party/terminal-compat-sources.json'));
  assert.match(fs.readFileSync(path.join(root, 'native/legacy-terminal/go.mod'), 'utf8'), new RegExp('toolchain ' + lock.goToolchain.replaceAll('.', '\\.')));
  const runtime = core.readJson(path.join(root, 'third-party/manifest.json')).resources.ttyd.components.find(component => component.id === 'go-runtime-terminal');
  assert.equal(runtime.version, lock.goToolchain.slice(2));
  for (const name of ['release-electron.yml', 'release-electron-dev.yml']) {
    const workflow = fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8');
    assert.ok(workflow.includes(`go-version: '${runtime.version}'`));
    assert.ok(workflow.indexOf('node scripts/prepare-terminal-compat.mjs') < workflow.indexOf('- name: Build Electron app'));
    assert.ok(workflow.includes('node scripts/prepare-terminal-compat.mjs --platform win32 --arch "$TARGET_ARCH" --verify-output "$OUT_DIR"'));
    const gate = workflow.indexOf('- name: Verify packaged Windows terminal compatibility resources');
    assert.ok(gate > workflow.indexOf('- name: Verify packaged updater configuration'));
    assert.ok(gate < workflow.indexOf('- name: Upload artifacts to Release'));
  }
  const gates = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.ok(gates.includes('node scripts/acceptance/terminal-compat.mjs'));
  assert.ok(gates.includes('go test -race ./...'));
});

test('Windows Git checkout preserves the upstream license SHA256', t => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-license-checkout-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const file = 'third-party/licenses/winpty.txt';
  fs.mkdirSync(path.join(temporary, path.dirname(file)), { recursive: true });
  fs.copyFileSync(path.join(root, file), path.join(temporary, file));
  fs.copyFileSync(path.join(root, '.gitattributes'), path.join(temporary, '.gitattributes'));
  const git = args => execFileSync('git', ['-C', temporary, '-c', 'core.autocrlf=true', ...args], { stdio: 'pipe' });
  git(['init', '-q']);
  git(['add', '.gitattributes', file]);
  const checkout = path.join(temporary, 'windows-checkout');
  fs.mkdirSync(checkout);
  git(['checkout-index', '--force', '--prefix=' + checkout.replaceAll('\\', '/') + '/', '--all']);
  const expected = core.readJson(path.join(root, 'third-party/terminal-compat-sources.json')).source.licenseSha256;
  assert.equal(core.fileHash(path.join(checkout, file)), expected);
});
