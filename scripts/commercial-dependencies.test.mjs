import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as core from './client/core.mjs';
import { ensureCommercialDependencies } from './client/commercial-dependencies.mjs';

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'commercial-dependencies-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(path.join(root, 'package.json'), { dependencies: { ws: '8.19.0' }, devDependencies: { '@types/ws': '8.18.1' } });
  write(path.join(root, 'pnpm-lock.yaml'), 'commercial-lock');
  const baseManifest = path.join(root, 'nuwa-electron-shell/package.json');
  const baseLock = path.join(root, 'nuwa-electron-shell/pnpm-lock.yaml');
  write(baseManifest, 'community-manifest');
  write(baseLock, 'community-lock');
  const calls = [];
  const tools = { ...core, pnpmRun(dir, args, options) {
    calls.push({ dir, args, options });
    assert.equal(dir, root);
    const pkg = core.readJson(path.join(root, 'package.json'));
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }))
      write(path.join(root, 'node_modules', name, 'package.json'), { version });
  } };
  return { root, tools, calls, baseManifest, baseLock };
}

test('commercial install uses its own frozen lock and leaves neutral base manifests untouched', async (t) => {
  const f = fixture(t);
  await ensureCommercialDependencies(f.root, f.tools);
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].args.includes('--frozen-lockfile'));
  assert.ok(f.calls[0].args.includes('--ignore-scripts'));
  assert.ok(f.calls[0].args.includes('--prod=false'));
  await ensureCommercialDependencies(f.root, f.tools);
  assert.equal(f.calls.length, 1, 'warm commercial entry performs no install');
  assert.equal(fs.readFileSync(f.baseManifest, 'utf8'), 'community-manifest');
  assert.equal(fs.readFileSync(f.baseLock, 'utf8'), 'community-lock');
});

test('changed lock or missing type entry invalidates commercial dependency cache', async (t) => {
  const f = fixture(t);
  await ensureCommercialDependencies(f.root, f.tools);
  write(path.join(f.root, 'pnpm-lock.yaml'), 'updated-lock');
  await ensureCommercialDependencies(f.root, f.tools);
  fs.rmSync(path.join(f.root, 'node_modules/@types/ws'), { recursive: true });
  await ensureCommercialDependencies(f.root, f.tools);
  assert.equal(f.calls.length, 3);
});

test('failed commercial installation is never cached and releases its preparation lock', async (t) => {
  const f = fixture(t);
  f.tools.pnpmRun = () => { throw new Error('fixture-install-failed'); };
  await assert.rejects(ensureCommercialDependencies(f.root, f.tools), /fixture-install-failed/);
  const cache = core.paths(f.root).cache;
  assert.equal(fs.existsSync(path.join(cache, 'commercial-dependencies.json')), false);
  assert.equal(fs.existsSync(path.join(cache, 'commercial-dependencies.lock')), false);
});

test('community wrapper skips commercial dependency preparation; commercial test entry prepares it', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'scripts'), { recursive: true });
  fs.copyFileSync(new URL('./in-base.js', import.meta.url), path.join(f.root, 'scripts/in-base.js'));
  write(path.join(f.root, 'scripts/sync-overlay.js'), 'process.exitCode = 0;');
  const marker = path.join(f.root, 'commercial-prepared');
  write(path.join(f.root, 'scripts/client/commercial-dependencies.mjs'),
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'prepared');`);
  const run = flag => spawnSync(process.execPath, [path.join(f.root, 'scripts/in-base.js'), flag, '--', process.execPath, '-e', ''], { encoding: 'utf8' });
  const community = run('--no-inject');
  assert.equal(community.status, 0, community.stderr);
  assert.equal(fs.existsSync(marker), false);
  const commercial = run('--no-env');
  assert.equal(commercial.status, 0, commercial.stderr);
  assert.equal(fs.existsSync(marker), true);
});
