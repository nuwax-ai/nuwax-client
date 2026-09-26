import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import config from '../client.config.mjs';
import * as core from './client/core.mjs';
import { buildFrontend, preparePinnedFrontend } from './client/frontend.mjs';

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof contents === 'string' || Buffer.isBuffer(contents) ? contents : JSON.stringify(contents));
}

function fixture(t, { initialized = true, versionExists = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'client-frontend-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const p = core.paths(root);
  const sourceSha = 'a'.repeat(40), stamp = sourceSha.slice(0, 9);
  const generated = path.join(p.frontend, 'src/constants/version.ts');
  const original = Buffer.from('// developer-owned bytes\r\nexport const version = "local";\r\n');
  write(path.join(p.frontend, 'package.json'), { packageManager: 'pnpm@10.27.0' });
  write(path.join(p.frontend, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  if (initialized) write(path.join(p.frontend, '.git'), 'gitdir: fixture');
  if (versionExists) write(generated, original);
  const userFile = path.join(p.frontend, 'src/current-wip.ts');
  write(userFile, 'export const uncommitted = true;\n');
  const state = { sourceSha, stamp, status: '', expected: sourceSha, head: sourceSha, buildCalls: 0, installs: 0 };
  const calls = [];
  const tools = {
    ...core,
    git(dir, args) {
      calls.push(['git', dir, ...args]);
      if (args[0] === 'submodule') { write(path.join(p.frontend, '.git'), 'gitdir: fixture'); return ''; }
      if (args[0] === 'rev-parse') {
        if (args.includes('--short')) return state.stamp;
        if (args[1] === 'HEAD:nuwax') return state.sourceSha;
        if (args[1] === 'HEAD') return state.head;
        if (args[1].endsWith('^{commit}')) return state.expected;
      }
      if (args[0] === 'status') return state.status;
      return '';
    },
    pnpmRun(dir, args, options = {}) {
      calls.push(['pnpm', dir, ...args]);
      assert.equal(dir, p.frontend);
      if (args[0] === 'install') {
        state.installs++;
        if (state.installFailure) throw new Error('fixture install failed');
        write(path.join(p.frontend, 'node_modules/.modules.yaml'), 'modules marker');
        return;
      }
      assert.deepEqual(args, ['build:prod']);
      state.buildEnv = options.env;
      state.buildCalls++;
      write(generated, 'generated build version\n');
      if (state.buildFailure) throw new Error('fixture build failed');
      if (!state.skipIndex) write(path.join(p.frontend, 'dist/index.html'), state.emptyIndex ? '' : '<!doctype html><title>frontend fixture</title>');
      write(path.join(p.frontend, 'dist/version.json'), { gitHash: state.outputStamp ?? stamp });
    },
  };
  const run = (options = {}) => buildFrontend(root, { tools, ...options });
  return { root, p, state, calls, tools, generated, original, userFile, run };
}

test('standalone build installs frozen dependencies and keeps dist without moving any Git pin', async (t) => {
  const f = fixture(t);
  const result = await f.run();
  assert.equal(result.sourceSha, f.state.sourceSha);
  assert.equal(result.stamp, f.state.stamp);
  assert.equal(result.distDir, path.join(f.p.frontend, 'dist'));
  assert.equal(fs.existsSync(path.join(result.distDir, 'index.html')), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.distDir, 'version.json'))).gitHash, f.state.stamp);
  assert.ok(f.calls.some(([type, , command, flag]) => type === 'pnpm' && command === 'install' && flag === '--frozen-lockfile'));
  assert.equal(f.calls.some(([type, , command]) => type === 'git' && ['add', 'commit', 'push', 'restore', 'clean', 'checkout'].includes(command)), false);
  assert.deepEqual(fs.readFileSync(f.generated), f.original);
});

test('dependency cache reuses install but rebuilds source and reinstalls after lock changes or missing modules', async (t) => {
  const f = fixture(t);
  await f.run(); await f.run();
  assert.equal(f.state.installs, 1);
  assert.equal(f.state.buildCalls, 2);
  write(path.join(f.p.frontend, 'pnpm-lock.yaml'), 'new locked dependencies');
  await f.run();
  assert.equal(f.state.installs, 2);
  fs.rmSync(path.join(f.p.frontend, 'node_modules/.modules.yaml'));
  await f.run();
  assert.equal(f.state.installs, 3);
});

test('frontend build uses configured memory only when the user has not supplied NODE_OPTIONS', async (t) => {
  const f = fixture(t);
  const previous = process.env.NODE_OPTIONS;
  t.after(() => { if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous; });
  delete process.env.NODE_OPTIONS;
  await f.run();
  assert.equal(f.state.buildEnv.NODE_OPTIONS, config.frontend.buildNodeOptions);
  process.env.NODE_OPTIONS = '--max-old-space-size=2048 --trace-warnings';
  await f.run();
  assert.equal(f.state.buildEnv.NODE_OPTIONS, '--max-old-space-size=2048 --trace-warnings');
  process.env.NODE_OPTIONS = '';
  await f.run();
  assert.equal(f.state.buildEnv.NODE_OPTIONS, '', 'an explicitly empty user value also suppresses the default');
});

test('corrupt install cache is repaired without failing the build', async (t) => {
  const f = fixture(t);
  write(path.join(f.p.cache, 'frontend-install.json'), '{broken json');
  await f.run();
  assert.equal(f.state.installs, 1);
  assert.match(JSON.parse(fs.readFileSync(path.join(f.p.cache, 'frontend-install.json'))).key, /^[0-9a-f]{64}$/);
});

test('expected source reference resolves to a commit and mismatch fails before install/build', async (t) => {
  const f = fixture(t);
  await f.run({ expectedSha: f.state.sourceSha.slice(0, 9) });
  assert.ok(f.calls.some((call) => call.includes(`${f.state.sourceSha.slice(0, 9)}^{commit}`)));
  f.state.expected = 'b'.repeat(40);
  await assert.rejects(f.run({ expectedSha: 'other-source' }), /HEAD does not match expected SHA/);
  assert.equal(f.state.buildCalls, 1);
});

test('publishing refuses source WIP while standalone builds preserve it', async (t) => {
  const f = fixture(t); f.state.status = ' M src/current-wip.ts';
  const before = fs.readFileSync(f.userFile);
  await assert.rejects(f.run({ allowDirty: false }), /source edits/);
  assert.equal(f.state.installs, 0);
  const result = await f.run();
  assert.equal(result.dirty, true);
  assert.deepEqual(fs.readFileSync(f.userFile), before);
  assert.deepEqual(fs.readFileSync(f.generated), f.original);
});

test('generated version bytes are restored on failed build, including pre-existing developer edits', async (t) => {
  const f = fixture(t); f.state.buildFailure = true; f.state.status = ' M src/constants/version.ts';
  await assert.rejects(f.run(), /fixture build failed/);
  assert.deepEqual(fs.readFileSync(f.generated), f.original);
  assert.equal(f.calls.some(([type, , command]) => type === 'git' && ['restore', 'reset', 'checkout'].includes(command)), false);
});

test('a generated version file absent before a failed build is removed again', async (t) => {
  const f = fixture(t, { versionExists: false }); f.state.buildFailure = true;
  await assert.rejects(f.run(), /fixture build failed/);
  assert.equal(fs.existsSync(f.generated), false);
});

test('install failures never mark a usable cache and preserve source bytes', async (t) => {
  const f = fixture(t); f.state.installFailure = true;
  await assert.rejects(f.run(), /fixture install failed/);
  assert.equal(fs.existsSync(path.join(f.p.cache, 'frontend-install.json')), false);
  assert.equal(f.state.buildCalls, 0);
  assert.deepEqual(fs.readFileSync(f.generated), f.original);
});

test('build acceptance requires exact git stamp and a nonempty index file', async (t) => {
  const f = fixture(t); f.state.outputStamp = 'b'.repeat(9);
  await assert.rejects(f.run(), /stamp .* differs from source/);
  f.state.outputStamp = f.state.stamp;
  f.state.emptyIndex = true;
  await assert.rejects(f.run(), /did not produce index.html/);
  assert.deepEqual(fs.readFileSync(f.generated), f.original);
});

test('a missing frontend initializes only the pinned source with depth 1', async (t) => {
  const f = fixture(t, { initialized: false });
  await f.run();
  assert.ok(f.calls.some((call) => call[0] === 'git' && call[2] === 'submodule' && call.includes('--depth') && call.includes('1') && call.at(-1) === 'nuwax'));
  assert.equal(f.calls.some((call) => call.includes('fetch')), false);
});

test('dry-run does not install, generate versions, initialize submodules or create caches', async (t) => {
  const f = fixture(t, { initialized: false });
  const result = await f.run({ dryRun: true });
  assert.equal(result.planned, true);
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(path.join(f.p.frontend, '.git')), false);
  assert.equal(fs.existsSync(f.p.cache), false);
  assert.deepEqual(fs.readFileSync(f.generated), f.original);
});

test('CI pinned entry normalizes short expectedSha when SKIP_NUWAX_BUILD is set', async (t) => {
  const f = fixture(t);
  const previous = process.env.SKIP_NUWAX_BUILD;
  process.env.SKIP_NUWAX_BUILD = '1';
  t.after(() => { if (previous === undefined) delete process.env.SKIP_NUWAX_BUILD; else process.env.SKIP_NUWAX_BUILD = previous; });
  await preparePinnedFrontend(f.root, { expectedSha: f.state.sourceSha.slice(0, 9), tools: f.tools });
  assert.equal(f.state.buildCalls, 0);
  assert.ok(f.calls.some((call) => call.includes(`${f.state.sourceSha.slice(0, 9)}^{commit}`)));
  f.state.expected = 'b'.repeat(40);
  await assert.rejects(preparePinnedFrontend(f.root, { expectedSha: 'other', tools: f.tools }), /differs from source gitlink/);
});

test('CI pinned entry enforces clean source even if allowDirty is supplied', async (t) => {
  const f = fixture(t); f.state.status = ' M src/current-wip.ts';
  await assert.rejects(preparePinnedFrontend(f.root, { expectedSha: f.state.sourceSha, allowDirty: true, tools: f.tools }), /source edits/);
  assert.equal(f.state.installs, 0);
});
