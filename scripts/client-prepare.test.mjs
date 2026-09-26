import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as core from './client/core.mjs';
import { prepare, resourceSpecs, inputDigest, validatePinnedFrontend, packageReady } from './client/prepare.mjs';

function write(file, contents = 'fixture') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
}

function fixture(t, { platform = 'darwin', arch = 'arm64' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'client-prepare-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const p = core.paths(root);
  const calls = [];
  const sourceSha = 'a'.repeat(40);
  const distSha = 'b'.repeat(40);
  for (const name of ['nuwa-electron-shell', 'nuwax', 'nuwax-dist']) write(path.join(root, name, '.git'));
  write(path.join(p.dist, 'index.html'), '<!doctype html>');
  write(path.join(p.dist, 'version.json'), { gitHash: sourceSha.slice(0, 9) });
  write(path.join(p.base, 'package.json'), { packageManager: 'pnpm@9.15.5' });
  write(path.join(p.base, 'pnpm-lock.yaml'), 'lock');
  write(path.join(p.base, 'pnpm-workspace.yaml'), 'workspace');
  const kit = path.join(p.base, 'crates/agent-kit');
  write(path.join(kit, 'package.json'), { packageManager: 'pnpm@9.15.5' });
  write(path.join(kit, 'src/index.ts'), 'export const value = 1');
  const bundledSources = Object.fromEntries(['nuwax-file-server', 'claude-code-acp-ts'].map((name) => [name, { url: `https://example.invalid/${name}.git`, branch: 'main' }]));
  write(path.join(p.client, 'package.json'), { bundledSources });
  for (const name of ['sandboxed-bash-mcp', 'sandboxed-fs-mcp']) write(path.join(p.client, 'resources', name, `${name}.mjs`), 'source');
  write(path.join(p.frontend, 'package.json'), { packageManager: 'pnpm@10.0.0' });
  const success = { status: 0, stdout: '', stderr: '' };
  const tools = {
    ...core,
    git(dir, args) {
      calls.push(['git', dir, ...args]);
      if (args[0] === 'config') return ['nuwa-electron-shell', 'nuwax', 'nuwax-dist'].map((name) => `submodule.${name}.path ${name}`).join('\n');
      if (args[0] === 'ls-tree') return `160000 commit ${sourceSha}\tnuwax\n160000 commit ${distSha}\tnuwax-dist`;
      if (args[0] === 'status') return '';
      if (args[0] === 'rev-parse') return dir === p.dist ? distSha : dir === p.frontend ? sourceSha : 'c'.repeat(40);
      return '';
    },
    run(command, args, options) {
      calls.push(['run', command, ...args]);
      if (command === 'git' && args[0] === 'clone') {
        const destination = args.at(-1);
        write(path.join(destination, '.git'));
        write(path.join(destination, 'package.json'), { main: 'dist/index.js', scripts: { build: 'fixture' } });
      }
      if (command === 'npm' && ['install', 'ci'].includes(args[0])) write(path.join(options.cwd, 'node_modules/dependency/index.js'));
      if (args[0] === '-p') return { ...success, stdout: '143\n' };
      return success;
    },
    pnpmRun(dir, args) {
      calls.push(['pnpm', dir, ...args]);
      if (dir === kit && args[0] === 'run') for (const name of ['index.js', 'index.cjs', 'index.d.ts']) write(path.join(kit, 'dist', name));
      if (dir === p.base && args[0] === 'install') {
        for (const name of ['electron', 'vite', 'better-sqlite3', '@nuwax-ai/agent-kit', 'agent-gui-server']) write(path.join(p.client, 'node_modules', name, 'package.json'), { version: '1.0.0' });
        write(path.join(p.client, 'node_modules/electron/path.txt'), 'electron');
        write(path.join(p.client, 'node_modules/electron/dist/electron'));
      }
      if (dir === p.frontend) write(path.join(p.frontend, 'node_modules/@umijs/max/package.json'), { version: '1' });
      return success;
    },
    npmRun(dir, script) {
      calls.push(['npm', dir, script]);
      if (script === 'electron-rebuild') write(path.join(p.client, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'));
      if (script === 'build' && dir.includes(path.join('.cache', 'client-toolchain', 'sources'))) write(path.join(dir, 'dist/index.js'));
      const spec = resourceSpecs(p.client, platform, arch).find((item) => item.script === script);
      if (spec) {
        for (const file of spec.files) write(file);
        if (spec.name === 'sandbox-runtime') write(spec.files[0], { skipped: true });
        if (spec.name === 'windows-mcp') {
          write(spec.files[0], { files: ['windows_mcp.whl'] });
          write(path.join(p.client, 'resources/windows-mcp/wheels/windows_mcp.whl'));
        }
      }
      return success;
    },
  };
  return { root, p, kit, tools, calls, platform, arch, sourceSha };
}

test('preparation orders agent-kit before workspace and reuses unchanged inputs', async (t) => {
  const f = fixture(t);
  const options = { tools: f.tools, platform: f.platform, arch: f.arch };
  await prepare(f.root, options);
  const kitBuild = f.calls.findIndex((call) => call[0] === 'pnpm' && call[1] === f.kit && call[2] === 'run');
  const workspaceInstall = f.calls.findIndex((call) => call[0] === 'pnpm' && call[1] === f.p.base && call[2] === 'install');
  assert.ok(kitBuild >= 0 && workspaceInstall > kitBuild);
  assert.ok(f.calls.some((call) => call[0] === 'pnpm' && call[1] === f.kit && call.includes('--lockfile=false')));
  f.calls.length = 0;
  await prepare(f.root, options);
  assert.equal(f.calls.filter((call) => ['pnpm', 'npm'].includes(call[0])).length, 0);
  assert.equal(f.calls.filter((call) => call.includes('fetch')).length, 0);
  assert.ok(f.calls.some((call) => call.includes('-e')), 'actual SQLite probe runs on cache reuse');
});

test('agent-kit uses frozen install when its own lock exists', async (t) => {
  const f = fixture(t);
  write(path.join(f.kit, 'pnpm-lock.yaml'), 'standalone lock');
  const git = f.tools.git;
  f.tools.git = (dir, args) => args[0] === 'ls-files' && args.at(-1) === 'crates/agent-kit/pnpm-lock.yaml' ? 'crates/agent-kit/pnpm-lock.yaml' : git(dir, args);
  await prepare(f.root, { tools: f.tools, platform: f.platform, arch: f.arch });
  const install = f.calls.find((call) => call[0] === 'pnpm' && call[1] === f.kit && call[2] === 'install');
  assert.ok(install.includes('--frozen-lockfile'));
  assert.equal(install.includes('--lockfile=false'), false);
});

test('ignored standalone lock generated by postinstall does not invalidate warm cache', async (t) => {
  const f = fixture(t);
  const pnpmRun = f.tools.pnpmRun;
  f.tools.pnpmRun = (dir, args) => {
    if (dir === f.p.base && args[0] === 'install') write(path.join(f.kit, 'pnpm-lock.yaml'), 'generated by inherited postinstall');
    return pnpmRun(dir, args);
  };
  const options = { tools: f.tools, platform: f.platform, arch: f.arch };
  await prepare(f.root, options);
  f.calls.length = 0;
  await prepare(f.root, options);
  assert.equal(f.calls.filter((call) => ['pnpm', 'npm'].includes(call[0])).length, 0);
});

test('kit edits invalidate workspace; ABI and missing native artifacts invalidate rebuild', async (t) => {
  const f = fixture(t);
  const options = { tools: f.tools, platform: f.platform, arch: f.arch };
  await prepare(f.root, options);
  write(path.join(f.kit, 'src/index.ts'), 'export const value = 2');
  f.calls.length = 0;
  await prepare(f.root, options);
  assert.ok(f.calls.some((call) => call[0] === 'pnpm' && call[1] === f.p.base && call.includes('--force')));
  f.calls.length = 0;
  fs.rmSync(path.join(f.p.client, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'));
  await prepare(f.root, options);
  assert.ok(f.calls.some((call) => call.includes('electron-rebuild')));
  f.calls.length = 0;
  const run = f.tools.run;
  f.tools.run = (...args) => args[1][0] === '-p' ? { status: 0, stdout: '144', stderr: '' } : run(...args);
  await prepare(f.root, options);
  assert.ok(f.calls.some((call) => call.includes('electron-rebuild')));
});

test('managed source refresh preserves developer checkout and only fetches explicitly', async (t) => {
  const f = fixture(t);
  const original = path.join(f.p.client, 'sources/nuwax-file-server/important.ts');
  write(original, 'developer work');
  const options = { tools: f.tools, platform: f.platform, arch: f.arch };
  await prepare(f.root, options);
  f.calls.length = 0;
  await prepare(f.root, { ...options, refreshResources: true });
  assert.ok(f.calls.some((call) => call.includes('fetch')));
  assert.equal(fs.readFileSync(original, 'utf8'), 'developer work');
  assert.equal(f.calls.some((call) => call.includes('reset') || call.includes('clean')), false);
});

test('source resource preparation preserves a developer checkout in resources', async (t) => {
  const f = fixture(t);
  const destination = path.join(f.p.client, 'resources/nuwax-file-server');
  write(path.join(destination, '.git'), 'developer repository');
  write(path.join(destination, 'src/important.ts'), 'developer work');
  await assert.rejects(prepare(f.root, { tools: f.tools, platform: f.platform, arch: f.arch }), /拒绝覆盖资源中的源码检出/);
  assert.equal(fs.readFileSync(path.join(destination, 'src/important.ts'), 'utf8'), 'developer work');
});

test('unknown plain legacy payload is backed up before automatic migration', async (t) => {
  const f = fixture(t);
  const destination = path.join(f.p.client, 'resources/nuwax-file-server');
  write(path.join(destination, 'dist/old.js'), 'legacy work');
  write(path.join(destination, 'notes.txt'), 'keep this note');
  await prepare(f.root, { tools: f.tools, platform: f.platform, arch: f.arch });
  const backups = fs.readdirSync(path.join(f.p.cache, 'legacy-resources'));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^nuwax-file-server-/);
  const backup = path.join(f.p.cache, 'legacy-resources', backups[0]);
  assert.equal(fs.readFileSync(path.join(backup, 'notes.txt'), 'utf8'), 'keep this note');
  assert.equal(fs.readFileSync(path.join(backup, 'dist/old.js'), 'utf8'), 'legacy work');
  assert.ok(fs.existsSync(path.join(destination, 'dist/index.js')));
  assert.ok(fs.existsSync(path.join(destination, '.toolchain-resource.json')));
});

test('managed source resources with local edits are preserved on refresh', async (t) => {
  const f = fixture(t);
  const options = { tools: f.tools, platform: f.platform, arch: f.arch };
  await prepare(f.root, options);
  const entry = path.join(f.p.client, 'resources/nuwax-file-server/dist/index.js');
  write(entry, 'developer edit');
  await assert.rejects(prepare(f.root, { ...options, refreshResources: true }), /资源目录含本地改动/);
  assert.equal(fs.readFileSync(entry, 'utf8'), 'developer edit');
});

test('Windows sandbox helper success without actual exe is rejected', async (t) => {
  const f = fixture(t, { platform: 'win32', arch: 'x64' });
  const npm = f.tools.npmRun;
  f.tools.npmRun = (dir, script) => script === 'prepare:sandbox-helper-win' ? { status: 0, stdout: '', stderr: '' } : npm(dir, script);
  await assert.rejects(prepare(f.root, { tools: f.tools, platform: 'win32', arch: 'x64' }), /sandbox-helper-win.*产物缺失/);
  assert.equal(fs.existsSync(path.join(f.p.cache, 'prepare.lock')), false);
});

test('default dist pin rejects stale stamp and dirty artifact tree', async (t) => {
  const f = fixture(t);
  write(path.join(f.p.dist, 'version.json'), { gitHash: 'wronghash' });
  await assert.rejects(validatePinnedFrontend(f.root, f.tools), /产物戳/);
  write(path.join(f.p.dist, 'version.json'), { gitHash: f.sourceSha.slice(0, 9) });
  const git = f.tools.git;
  f.tools.git = (dir, args) => args[0] === 'status' && dir === f.p.dist ? ' M index.html' : git(dir, args);
  await assert.rejects(validatePinnedFrontend(f.root, f.tools), /未对齐/);
});

test('overlay preparation refuses to overwrite unowned base edits', async (t) => {
  const f = fixture(t);
  const relative = 'crates/agent-electron-client/src/main/changed.ts';
  write(path.join(f.root, 'overlay', relative), 'commercial overlay');
  write(path.join(f.p.base, relative), 'developer work');
  const git = f.tools.git;
  f.tools.git = (dir, args) => dir === f.p.base && args[0] === 'status' && args.at(-1) === relative ? ` M ${relative}` : git(dir, args);
  await assert.rejects(prepare(f.root, { tools: f.tools, platform: f.platform, arch: f.arch }), /覆盖基座本地改动/);
  assert.equal(fs.readFileSync(path.join(f.p.base, relative), 'utf8'), 'developer work');
  assert.equal(f.calls.some((call) => call[0] === 'pnpm'), false);
});

test('input hashing ignores build/cache and catches source contents; packageReady checks declared entry', (t) => {
  const f = fixture(t);
  const before = inputDigest([f.kit]);
  write(path.join(f.kit, 'dist/index.js'), 'build changes');
  assert.equal(inputDigest([f.kit]), before);
  write(path.join(f.kit, 'src/index.ts'), 'source changes');
  assert.notEqual(inputDigest([f.kit]), before);
  write(path.join(f.kit, 'package.json'), { main: 'dist/missing.js' });
  assert.equal(packageReady(f.kit), false);
});
