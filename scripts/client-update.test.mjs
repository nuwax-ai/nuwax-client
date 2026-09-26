import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { update } from './client/update.mjs';
import * as core from './client/core.mjs';

const temporary = [];
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function git(dir, ...args) {
  const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Toolchain Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Toolchain Test', GIT_COMMITTER_EMAIL: 'test@example.invalid', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false' } });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
function write(dir, name, text) { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), text); }
function commit(dir, name, contents) { write(dir, name, contents); git(dir, 'add', '-A'); git(dir, 'commit', '-m', `test: ${name}`); return git(dir, 'rev-parse', 'HEAD'); }
function fixture({ trackedDist = false } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'client-update-'));
  temporary.push(temp);
  const root = path.join(temp, 'client');
  const remotes = {}, seeds = {};
  let source;
  for (const name of ['nuwa-electron-shell', 'nuwax', 'nuwax-dist']) {
    const remote = path.join(temp, `${name}.git`), seed = path.join(temp, `${name}-seed`);
    fs.mkdirSync(remote); git(remote, 'init', '--bare', '--initial-branch=main');
    fs.mkdirSync(seed); git(seed, 'init', '--initial-branch=main');
    git(seed, 'config', 'user.name', 'Toolchain Test'); git(seed, 'config', 'user.email', 'test@example.invalid'); git(seed, 'config', 'commit.gpgsign', 'false');
    if (name === 'nuwax-dist') {
      write(seed, 'README.md', 'machine generated; retain pinned history\n');
      write(seed, 'index.html', 'initial app\n');
      write(seed, 'obsolete.js', 'old\n');
      write(seed, 'version.json', JSON.stringify({ gitHash: source.slice(0, 7) }));
      git(seed, 'add', '-A'); git(seed, 'commit', '-m', 'initial assets');
    } else {
      write(seed, '.gitignore', name === 'nuwax' ? 'dist/\nnode_modules/\n' : 'node_modules/\n');
      if (name === 'nuwax' && trackedDist) { write(seed, 'dist/tracked.txt', 'previous tracked asset\n'); git(seed, 'add', '-f', 'dist/tracked.txt'); }
      source = commit(seed, 'source.txt', 'initial\n');
    }
    git(seed, 'remote', 'add', 'origin', remote); git(seed, 'push', '-u', 'origin', 'main');
    remotes[name] = remote; seeds[name] = seed;
  }
  fs.mkdirSync(root); git(root, 'init', '--initial-branch=main');
  git(root, 'config', 'user.name', 'Toolchain Test'); git(root, 'config', 'user.email', 'test@example.invalid'); git(root, 'config', 'commit.gpgsign', 'false');
  for (const name of Object.keys(remotes)) {
    git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', remotes[name], name);
    git(root, 'config', '-f', '.gitmodules', `submodule.${name}.branch`, 'main');
    git(path.join(root, name), 'config', 'user.name', 'Toolchain Test'); git(path.join(root, name), 'config', 'user.email', 'test@example.invalid'); git(path.join(root, name), 'config', 'commit.gpgsign', 'false');
  }
  write(root, '.gitignore', '.cache/\n.overlay-sync.json\n');
  commit(root, 'notes.txt', 'original\n');
  const outerRemote = path.join(temp, 'client.git'); fs.mkdirSync(outerRemote); git(outerRemote, 'init', '--bare', '--initial-branch=main');
  git(root, 'remote', 'add', 'origin', outerRemote); git(root, 'push', '-u', 'origin', 'main');
  const advance = (name = 'nuwax') => { const sha = commit(seeds[name], 'source.txt', `advanced ${Date.now()} ${Math.random()}\n`); git(seeds[name], 'push', 'origin', 'main'); return sha; };
  let builds = 0;
  const buildFrontend = async (buildRoot, options) => {
    builds++;
    assert.equal(buildRoot, root); assert.equal(options.allowDirty, false); assert.equal(options.restoreGenerated, true); assert.equal(options.cleanDist, false);
    const dir = path.join(root, 'nuwax'), sha = git(dir, 'rev-parse', 'HEAD'), stamp = git(dir, 'rev-parse', '--short', 'HEAD');
    assert.equal(options.expectedSha, sha);
    const distDir = path.join(dir, 'dist'); fs.rmSync(distDir, { recursive: true, force: true });
    write(distDir, 'index.html', `built ${sha}\n`); write(distDir, 'app.js', 'new\n'); write(distDir, 'version.json', JSON.stringify({ gitHash: stamp }));
    return { sourceSha: sha, stamp, distDir, dirty: false };
  };
  return { root, remotes, seeds, outerRemote, advance, buildFrontend, get builds() { return builds; } };
}

test('full chain updates both pins, publishes assets, keeps README, and removes scratch', async () => {
  const f = fixture({ trackedDist: true }), target = f.advance();
  const result = await update(f.root, {}, { buildFrontend: f.buildFrontend });
  assert.equal(result.sourceSha, target); assert.equal(f.builds, 1);
  const dist = path.join(f.root, 'nuwax-dist');
  assert.equal(git(f.remotes['nuwax-dist'], 'rev-parse', 'main'), result.distSha);
  assert.equal(git(f.root, 'rev-parse', 'HEAD:nuwax'), target);
  assert.equal(git(f.root, 'rev-parse', 'HEAD:nuwax-dist'), result.distSha);
  assert.match(git(dist, 'log', '-1', '--format=%s'), /^build\(dist\): refresh client assets at /);
  assert.equal(fs.readFileSync(path.join(dist, 'README.md'), 'utf8'), 'machine generated; retain pinned history\n');
  assert.equal(fs.existsSync(path.join(dist, 'obsolete.js')), false);
  assert.equal(git(path.join(f.root, 'nuwax'), 'status', '--porcelain'), '');
  assert.equal(fs.readFileSync(path.join(f.root, 'nuwax/dist/tracked.txt'), 'utf8'), 'previous tracked asset\n');
  assert.equal(fs.existsSync(path.join(f.root, 'nuwax/dist/app.js')), false);
  const repeat = await update(f.root, {}, { buildFrontend: f.buildFrontend });
  assert.equal(f.builds, 1); assert.deepEqual(repeat.changed, []);
});

test('--force preserves unrelated staged changes and commits only changed gitlinks', async () => {
  const f = fixture(); f.advance();
  write(f.root, 'notes.txt', 'developer WIP\n'); git(f.root, 'add', 'notes.txt');
  await assert.rejects(update(f.root, {}, { buildFrontend: f.buildFrontend }), /外层有未提交改动/);
  await update(f.root, { force: true }, { buildFrontend: f.buildFrontend });
  assert.equal(git(f.root, 'show', 'HEAD:notes.txt'), 'original');
  assert.equal(git(f.root, 'diff', '--cached', '--name-only'), 'notes.txt');
  assert.equal(fs.readFileSync(path.join(f.root, 'notes.txt'), 'utf8'), 'developer WIP\n');
});

test('source WIP is rejected even with --force before changing checkouts', async () => {
  const f = fixture(), previous = git(path.join(f.root, 'nuwax'), 'rev-parse', 'HEAD'); f.advance();
  write(path.join(f.root, 'nuwax'), 'source.txt', 'developer changes\n');
  await assert.rejects(update(f.root, { force: true }, { buildFrontend: f.buildFrontend }), /有源码改动/);
  assert.equal(git(path.join(f.root, 'nuwax'), 'rev-parse', 'HEAD'), previous);
  assert.equal(f.builds, 0);
});

test('unchanged shell HEAD permits existing overlay edits, movement refuses them', async () => {
  const f = fixture(); f.advance(); const shell = path.join(f.root, 'nuwa-electron-shell');
  write(shell, 'source.txt', 'synchronized overlay\n');
  await update(f.root, {}, { buildFrontend: f.buildFrontend });
  assert.equal(fs.readFileSync(path.join(shell, 'source.txt'), 'utf8'), 'synchronized overlay\n');
  f.advance('nuwa-electron-shell');
  await assert.rejects(update(f.root, {}, { buildFrontend: f.buildFrontend }), /有未托管改动/);
});

test('managed overlay permits shell movement and resync; other source WIP remains protected', async () => {
  const f = fixture(), shell = path.join(f.root, 'nuwa-electron-shell');
  write(f.root, 'overlay/source.txt', 'commercial generated overlay\n');
  write(f.root, 'scripts/sync-overlay.js', fs.readFileSync(new URL('./sync-overlay.js', import.meta.url), 'utf8'));
  commit(f.root, 'overlay/README.md', 'overlay fixture\n');
  write(f.root, '.overlay-sync.json', JSON.stringify(['source.txt']));
  write(shell, 'source.txt', 'commercial generated overlay\n');
  const target = f.advance('nuwa-electron-shell'); f.advance();
  await update(f.root, {}, { buildFrontend: f.buildFrontend });
  assert.equal(git(shell, 'rev-parse', 'HEAD'), target);
  assert.equal(git(f.root, 'rev-parse', 'HEAD:nuwa-electron-shell'), target);
  assert.equal(fs.readFileSync(path.join(shell, 'source.txt'), 'utf8'), 'commercial generated overlay\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, '.overlay-sync.json'), 'utf8')), ['source.txt']);
  write(shell, 'developer.ts', 'developer WIP\n'); f.advance('nuwa-electron-shell');
  await assert.rejects(update(f.root, {}, { buildFrontend: f.buildFrontend }), /developer.ts 有未托管改动/);
  assert.equal(git(shell, 'rev-parse', 'HEAD'), target);
  assert.equal(fs.readFileSync(path.join(shell, 'developer.ts'), 'utf8'), 'developer WIP\n');
  assert.equal(fs.readFileSync(path.join(shell, 'source.txt'), 'utf8'), 'commercial generated overlay\n');
});

test('overlay movement refuses staged changes and mismatching previous generated files', async () => {
  const f = fixture(), shell = path.join(f.root, 'nuwa-electron-shell');
  write(f.root, 'overlay/source.txt', 'commercial generated overlay\n'); commit(f.root, 'overlay/README.md', 'overlay fixture\n');
  write(f.root, '.overlay-sync.json', JSON.stringify(['source.txt']));
  write(shell, 'source.txt', 'commercial generated overlay\n'); git(shell, 'add', 'source.txt'); f.advance('nuwa-electron-shell');
  await assert.rejects(update(f.root, {}, { buildFrontend: f.buildFrontend }), /壳子模块有暂存改动/);
  git(shell, 'restore', '--staged', 'source.txt'); write(shell, 'source.txt', 'developer changed generated file\n');
  await assert.rejects(update(f.root, {}, { buildFrontend: f.buildFrontend }), /source.txt 有未托管改动/);
  assert.equal(fs.readFileSync(path.join(shell, 'source.txt'), 'utf8'), 'developer changed generated file\n');
});

function makeShallow(f, name, pin) {
  const dir = path.join(f.root, name); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
  git(dir, 'clone', '--depth=1', pathToFileURL(f.remotes[name]).href, '.');
  if (pin) { git(dir, 'fetch', '--depth=1', 'origin', pin); git(dir, 'checkout', '--detach', pin); }
  assert.equal(git(dir, 'rev-parse', '--is-shallow-repository'), 'true');
  return dir;
}

test('shallow historical pin is not mistaken for a fork when updating to branch tip', async () => {
  const f = fixture(), original = git(path.join(f.root, 'nuwax'), 'rev-parse', 'HEAD'); f.advance(); const target = f.advance();
  const dir = makeShallow(f, 'nuwax', original);
  await update(f.root, {}, { buildFrontend: f.buildFrontend });
  assert.equal(git(dir, 'rev-parse', 'HEAD'), target);
  assert.equal(git(dir, 'rev-parse', '--is-shallow-repository'), 'false');
});

test('explicit historical SHA outside shallow depth is fetched and proved reachable', async () => {
  const f = fixture(), target = f.advance(); f.advance(); const dir = makeShallow(f, 'nuwax');
  await update(f.root, { nuwax: target }, { buildFrontend: f.buildFrontend });
  assert.equal(git(dir, 'rev-parse', 'HEAD'), target);
  assert.equal(git(f.root, 'rev-parse', 'HEAD:nuwax'), target);
});

test('explicit branch outside single-branch clone is fetched without changing user refs', async () => {
  const f = fixture(), seed = f.seeds.nuwax;
  git(seed, 'checkout', '-b', 'feature'); const target = commit(seed, 'feature.txt', 'feature branch\n'); git(seed, 'push', 'origin', 'feature'); git(seed, 'checkout', 'main');
  const dir = makeShallow(f, 'nuwax');
  await update(f.root, { nuwax: 'feature' }, { buildFrontend: f.buildFrontend });
  assert.equal(git(dir, 'rev-parse', 'HEAD'), target);
  assert.equal(git(dir, 'rev-parse', 'main'), git(seed, 'rev-parse', 'main'));
});

test('--no-commit prevents all commits and pushes while leaving reviewable artifacts', async () => {
  const f = fixture(), before = git(f.root, 'rev-parse', 'HEAD'), distBefore = git(f.remotes['nuwax-dist'], 'rev-parse', 'main'); f.advance();
  await update(f.root, { noCommit: true }, { buildFrontend: f.buildFrontend, run(command, args, options) { assert.ok(!args.includes('push'), 'no remote push allowed'); return core.run(command, args, options); } });
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), before);
  assert.equal(git(f.remotes['nuwax-dist'], 'rev-parse', 'main'), distBefore);
  assert.match(git(path.join(f.root, 'nuwax-dist'), 'status', '--porcelain'), /app.js/);
  assert.equal(git(path.join(f.root, 'nuwax'), 'status', '--porcelain'), '');
  await assert.rejects(update(f.root, { noCommit: true, push: true }), /不能与 --push/);
});

test('--no-build requires matching assets; --force-build rebuilds matching assets', async () => {
  const f = fixture(); await update(f.root, { noBuild: true }, { buildFrontend: f.buildFrontend }); assert.equal(f.builds, 0);
  await update(f.root, { forceBuild: true }, { buildFrontend: f.buildFrontend }); assert.equal(f.builds, 1);
  f.advance(); await assert.rejects(update(f.root, { noBuild: true }, { buildFrontend: f.buildFrontend }), /--no-build 要求/);
  await assert.rejects(update(f.root, { noBuild: true, forceBuild: true }), /不能与 --force-build/);
});

test('failed build restores tracked scratch and removes ignored build output', async () => {
  const f = fixture({ trackedDist: true }); f.advance();
  await assert.rejects(update(f.root, {}, { buildFrontend: async (...args) => { await f.buildFrontend(...args); throw new Error('mock build failed'); } }), /mock build failed/);
  const source = path.join(f.root, 'nuwax');
  assert.equal(git(source, 'status', '--porcelain'), '');
  assert.equal(fs.existsSync(path.join(source, 'dist/app.js')), false);
  assert.equal(fs.readFileSync(path.join(source, 'dist/tracked.txt'), 'utf8'), 'previous tracked asset\n');
});

test('explicit remote branch/tag/hash supported; unpublished explicit reference rejected', async () => {
  const f = fixture(), target = f.advance();
  git(f.seeds.nuwax, 'tag', 'client-v1'); git(f.seeds.nuwax, 'push', 'origin', 'client-v1');
  await update(f.root, { nuwax: 'client-v1' }, { buildFrontend: f.buildFrontend });
  await update(f.root, { nuwax: target }, { buildFrontend: f.buildFrontend });
  await update(f.root, { nuwax: 'main' }, { buildFrontend: f.buildFrontend });
  const local = commit(path.join(f.root, 'nuwax'), 'source.txt', 'unpublished\n');
  await assert.rejects(update(f.root, { nuwax: local }, { buildFrontend: f.buildFrontend }), /尚不可从 origin 获取/);
});

test('default local source ahead allowed locally, forks rejected, outer push requires published pin', async () => {
  const f = fixture(), source = path.join(f.root, 'nuwax');
  commit(source, 'source.txt', 'local ahead\n');
  await assert.rejects(update(f.root, { push: true }, { buildFrontend: f.buildFrontend }), /pin .* 尚不可从 origin 获取/);
  assert.notEqual(git(f.root, 'rev-parse', 'HEAD:nuwax'), git(f.outerRemote, 'rev-parse', 'main:nuwax'));
  f.advance();
  await assert.rejects(update(f.root, {}, { buildFrontend: f.buildFrontend }), /分叉/);
});

test('artifact push race rebuilds only this invocation commit once and preserves new README', async () => {
  const f = fixture(); f.advance(); let pushes = 0;
  await update(f.root, {}, { buildFrontend: f.buildFrontend, run(command, args, options) {
    if (command === 'git' && args[0] === 'push' && options.cwd === path.join(f.root, 'nuwax-dist') && ++pushes === 1) {
      commit(f.seeds['nuwax-dist'], 'README.md', 'remote README update\n'); git(f.seeds['nuwax-dist'], 'push', 'origin', 'main');
    }
    return core.run(command, args, options);
  } });
  assert.equal(pushes, 2);
  assert.equal(fs.readFileSync(path.join(f.root, 'nuwax-dist/README.md'), 'utf8'), 'remote README update\n');
  assert.equal(git(f.remotes['nuwax-dist'], 'rev-parse', 'main'), git(f.root, 'rev-parse', 'HEAD:nuwax-dist'));
});

test('artifact race never discards preexisting unpublished commits', async () => {
  const f = fixture(), dist = path.join(f.root, 'nuwax-dist');
  const existing = commit(dist, 'README.md', 'local unpublished documentation\n'); f.advance();
  await assert.rejects(update(f.root, {}, { buildFrontend: f.buildFrontend, run(command, args, options) {
    if (command === 'git' && args[0] === 'push' && options.cwd === dist) {
      commit(f.seeds['nuwax-dist'], 'README.md', 'remote documentation\n'); git(f.seeds['nuwax-dist'], 'push', 'origin', 'main');
    }
    return core.run(command, args, options);
  } }), /保留本地提交/);
  git(dist, 'merge-base', '--is-ancestor', existing, 'HEAD');
  assert.equal(fs.readFileSync(path.join(dist, 'README.md'), 'utf8'), 'local unpublished documentation\n');
});

test('--no-push-dist leaves local commit and blocks --push until remote can retrieve it', async () => {
  const f = fixture(), previous = git(f.remotes['nuwax-dist'], 'rev-parse', 'main'); f.advance();
  await assert.rejects(update(f.root, { noPushDist: true, push: true }, { buildFrontend: f.buildFrontend }), /nuwax-dist pin .* 尚不可从 origin 获取/);
  assert.equal(git(f.remotes['nuwax-dist'], 'rev-parse', 'main'), previous);
  const result = await update(f.root, {}, { buildFrontend: f.buildFrontend });
  assert.equal(git(f.remotes['nuwax-dist'], 'rev-parse', 'main'), result.distSha);
});

test('outer push compares actual remote tip and never forces concurrent changes', async () => {
  const f = fixture(); f.advance();
  const elsewhere = path.join(path.dirname(f.root), 'other-client'); fs.mkdirSync(elsewhere); git(elsewhere, 'clone', f.outerRemote, '.');
  git(elsewhere, 'config', 'user.name', 'Toolchain Test'); git(elsewhere, 'config', 'user.email', 'test@example.invalid');
  commit(elsewhere, 'remote.txt', 'concurrent outer change\n'); git(elsewhere, 'push', 'origin', 'main');
  const remote = git(f.outerRemote, 'rev-parse', 'main');
  await assert.rejects(update(f.root, { push: true }, { buildFrontend: f.buildFrontend }), /被更新/);
  assert.equal(git(f.outerRemote, 'rev-parse', 'main'), remote);
});

test('--push publishes the outer commit after all three pins are remotely reachable', async () => {
  const f = fixture(), target = f.advance();
  await update(f.root, { push: true }, { buildFrontend: f.buildFrontend });
  assert.equal(git(f.outerRemote, 'rev-parse', 'main'), git(f.root, 'rev-parse', 'HEAD'));
  assert.equal(git(f.outerRemote, 'rev-parse', 'main:nuwax'), target);
  assert.equal(git(f.outerRemote, 'rev-parse', 'main:nuwax-dist'), git(f.remotes['nuwax-dist'], 'rev-parse', 'main'));
});

test('ordinary failed artifact push preserves its commit and rerun resumes without rebuilding', async () => {
  const f = fixture(), outer = git(f.root, 'rev-parse', 'HEAD'); f.advance();
  await assert.rejects(update(f.root, {}, { buildFrontend: f.buildFrontend, run(command, args, options) {
    if (command === 'git' && args[0] === 'push' && options.cwd === path.join(f.root, 'nuwax-dist')) return { status: 1, stdout: '', stderr: 'mock network unavailable' };
    return core.run(command, args, options);
  } }), /认证或网络/);
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), outer);
  const pending = git(path.join(f.root, 'nuwax-dist'), 'rev-parse', 'HEAD');
  await update(f.root, {}, { buildFrontend: f.buildFrontend });
  assert.equal(f.builds, 1);
  assert.equal(git(f.remotes['nuwax-dist'], 'rev-parse', 'main'), pending);
});

test('--with-test failure gates artifact and outer pushes while keeping the local build', async () => {
  const f = fixture(), outer = git(f.root, 'rev-parse', 'HEAD'), published = git(f.remotes['nuwax-dist'], 'rev-parse', 'main'); f.advance();
  await assert.rejects(update(f.root, { withTest: true, push: true }, { buildFrontend: f.buildFrontend, isolatedTests: async () => { throw new Error('commercial test failure'); } }), /commercial test failure/);
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), outer);
  assert.equal(git(f.remotes['nuwax-dist'], 'rev-parse', 'main'), published);
  assert.notEqual(git(path.join(f.root, 'nuwax-dist'), 'rev-parse', 'HEAD'), published);
  assert.equal(git(path.join(f.root, 'nuwax'), 'status', '--porcelain'), '');
});

test('dry-run never changes tracked state or remote refs; with-test uses isolation seam', async () => {
  const f = fixture(), before = git(f.root, 'rev-parse', 'HEAD'); f.advance();
  await update(f.root, { dryRun: true }, { buildFrontend: () => { throw new Error('must not build'); } });
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), before);
  assert.equal(git(f.root, 'status', '--porcelain'), '');
  let tested = false;
  await update(f.root, { withTest: true }, { buildFrontend: f.buildFrontend, isolatedTests: async (root, modules) => { tested = true; assert.equal(root, f.root); assert.equal(Object.keys(modules).length, 3); } });
  assert.equal(tested, true);
});
