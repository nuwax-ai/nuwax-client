import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configurePackagePayload, preparePackagePayload, verifyPackagePayload } from './client/package-payload.mjs';
import { packagedResources } from './prepare-release-updater.mjs';

const cli = fileURLToPath(new URL('./client/package-payload.mjs', import.meta.url));
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-package-payload-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(file, content = 'fixture') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test('resource filtering is immutable and idempotent, preserving hooks, runtime allowlists and business archives', () => {
  const build = {
    afterPack: 'existing-hook.cjs', afterSign: 'existing-sign.cjs',
    extraResources: [
      { from: '/fixture/resources/node', to: 'node', filter: ['**/*', '!docs/**'] },
      { from: '/fixture/frontend', to: 'nuwax-dist', filter: ['**/*'] },
      { from: '/fixture/capture', to: 'capture', filter: ['ffmpeg', 'resource.json'] },
    ],
    win: { extraResources: [{ from: 'resources\\git', to: 'git', filter: '**/*' }] },
    mac: { extraResources: ['resources/ripgrep'] },
    linux: { extraResources: [{ from: 'resources/uv/bin', to: 'uv/bin' }] },
  };
  const before = structuredClone(build);
  const next = configurePackagePayload(build);
  assert.deepEqual(build, before);
  assert.deepEqual(configurePackagePayload(next), next);
  assert.equal(next.afterPack, before.afterPack);
  assert.equal(next.afterSign, before.afterSign);
  assert.deepEqual(next.extraResources.slice(1), before.extraResources.slice(1));
  assert.deepEqual(next.linux, before.linux);
  assert.ok(next.extraResources[0].filter.includes('!docs/**'));
  assert.ok(next.win.extraResources[0].filter.some(value => value.includes('.cache')));
  assert.ok(next.mac.extraResources.some(value => value.startsWith('!resources/git/.cache')));
  assert.throws(() => configurePackagePayload({ extraResources: [{ from: 'resources/git/.cache/payload.zip', to: 'git.zip' }] }), /build cache/i);
});

test('package CLI applies the same resource policy without rewriting identity or deleting source caches', (t) => {
  const root = temporary(t);
  const file = path.join(root, 'package.json');
  const cache = path.join(root, 'resources/git/.cache/archive.zip');
  const pkg = { name: 'nuwax', version: '3.0.23-beta.8', build: { appId: 'com.nuwax-ai.nuwax', win: { extraResources: [{ from: 'resources/git', to: 'git' }] } } };
  write(file, JSON.stringify(pkg)); write(cache, 'retained archive');
  const run = spawnSync(process.execPath, [cli, '--package', file], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { ...pkg, build: configurePackagePayload(pkg.build) });
  assert.equal(fs.readFileSync(cache, 'utf8'), 'retained archive');
  const once = fs.readFileSync(file);
  preparePackagePayload(file);
  assert.deepEqual(fs.readFileSync(file), once);
});

test('read-only packaged scan rejects cache roots but keeps nested runtime indexes, archives and licenses', (t) => {
  const root = temporary(t);
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'arm64'], ['linux', 'arm64']]) {
    const output = path.join(root, platform);
    const resources = packagedResources(output, platform, arch);
    write(path.join(resources, 'git/bin/git.exe'));
    write(path.join(resources, 'git/share/.cache/runtime-index'));
    write(path.join(resources, 'git/LICENSE.txt'));
    write(path.join(resources, 'nuwax-dist/assets/download.zip'));
    write(path.join(resources, 'nuwax-dist/.cache/user-data'));
    assert.equal(verifyPackagePayload(output, { platform, arch }).resources, resources);
    const leaked = path.join(resources, 'resources/ripgrep/.cache/download.tar.gz');
    write(leaked, 'not shipped');
    assert.throws(() => verifyPackagePayload(output, { platform, arch }), /build cache.*ripgrep/i);
    assert.equal(fs.readFileSync(leaked, 'utf8'), 'not shipped', 'verification must never repair signed output');
  }
});

test('verification CLI fails on absent output and validates the current platform by default', (t) => {
  const root = temporary(t);
  assert.throws(() => verifyPackagePayload(root), /resource directory/i);
  const resources = packagedResources(root, process.platform, process.arch);
  write(path.join(resources, 'git/bin/git.exe'));
  const run = spawnSync(process.execPath, [cli, '--verify-output', root, '--arch', process.arch], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /no build caches/i);
  assert.equal(spawnSync(process.execPath, [cli, '--package', '/absent', '--verify-output', root]).status, 1);
});
