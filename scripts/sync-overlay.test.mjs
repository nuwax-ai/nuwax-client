import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-safety-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, 'nuwa-electron-shell');
  const write = (dir, name, value) => { const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
  const git = (...args) => execFileSync('git', ['-C', base, ...args], { encoding: 'utf8' }).trim();
  fs.mkdirSync(base); fs.mkdirSync(path.join(root, 'overlay'));
  write(root, 'scripts/sync-overlay.js', fs.readFileSync(new URL('./sync-overlay.js', import.meta.url)));
  git('init', '-q'); write(base, 'a.txt', 'base-a'); write(base, 'b.txt', 'base-b'); git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(root, 'no-hooks')}`, 'commit', '-qm', 'baseline');
  const run = (...args) => spawnSync(process.execPath, [path.join(root, 'scripts/sync-overlay.js'), ...args], { encoding: 'utf8' });
  const overlay = (name, value) => write(path.join(root, 'overlay'), name, value);
  const manifest = values => write(root, '.overlay-sync.json', JSON.stringify(values));
  return { root, base, git, write, overlay, manifest, run, read: name => fs.readFileSync(path.join(base, name), 'utf8') };
}

test('check is read-only and normal sync/update/prune/clean preserve unrelated files', t => {
  const f = fixture(t); f.overlay('a.txt', 'overlay-a'); f.overlay('nested/new.txt', 'generated');
  assert.equal(f.run('--check').status, 1); assert.equal(f.read('a.txt'), 'base-a');
  assert.equal(fs.existsSync(path.join(f.root, '.overlay-sync.json')), false);
  assert.equal(f.run().status, 0); assert.equal(f.run('--check').status, 0);
  const stamp = fs.statSync(path.join(f.base, 'a.txt')).mtimeMs;
  assert.equal(f.run().status, 0); assert.equal(fs.statSync(path.join(f.base, 'a.txt')).mtimeMs, stamp);
  f.overlay('a.txt', 'new-overlay-a'); assert.equal(f.run().status, 0); assert.equal(f.read('a.txt'), 'new-overlay-a');
  fs.unlinkSync(path.join(f.root, 'overlay/nested/new.txt')); assert.equal(f.run().status, 0);
  assert.equal(fs.existsSync(path.join(f.base, 'nested/new.txt')), false);
  f.write(f.base, 'notes.txt', 'unrelated developer WIP'); assert.equal(f.run('--clean').status, 0);
  assert.equal(f.read('a.txt'), 'base-a'); assert.equal(f.read('notes.txt'), 'unrelated developer WIP');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, '.overlay-sync.json'), 'utf8')), []);
});

test('all targets are checked before the first overwrite when a later tracked file contains WIP', t => {
  const f = fixture(t); f.overlay('a.txt', 'overlay-a'); f.overlay('b.txt', 'overlay-b'); f.write(f.base, 'b.txt', 'developer WIP');
  const result = f.run(); assert.equal(result.status, 1); assert.match(result.stderr, /b\.txt/);
  assert.equal(f.read('a.txt'), 'base-a'); assert.equal(f.read('b.txt'), 'developer WIP');
  assert.equal(fs.existsSync(path.join(f.root, '.overlay-sync.json')), false);
});

test('untracked collisions are rejected without changing either file', t => {
  const f = fixture(t); f.overlay('a.txt', 'overlay-a'); f.overlay('new.txt', 'generated'); f.write(f.base, 'new.txt', 'untracked user content');
  assert.equal(f.run().status, 1); assert.equal(f.read('a.txt'), 'base-a'); assert.equal(f.read('new.txt'), 'untracked user content');
});

test('staged changes are refused even when their bytes match the requested overlay', t => {
  const f = fixture(t); f.overlay('a.txt', 'staged content'); f.write(f.base, 'a.txt', 'staged content'); f.git('add', 'a.txt');
  const before = f.git('diff', '--cached', '--binary'); assert.equal(f.run().status, 1);
  assert.equal(f.git('diff', '--cached', '--binary'), before); assert.equal(f.read('a.txt'), 'staged content');
});

test('edited synchronized files cannot be pruned or cleaned', t => {
  const f = fixture(t); f.overlay('a.txt', 'overlay-a'); f.overlay('new.txt', 'generated'); assert.equal(f.run().status, 0);
  const manifest = fs.readFileSync(path.join(f.root, '.overlay-sync.json')); f.write(f.base, 'new.txt', 'developer changed generated file');
  assert.equal(f.run('--clean').status, 1); assert.equal(f.read('a.txt'), 'overlay-a');
  fs.unlinkSync(path.join(f.root, 'overlay/new.txt')); assert.equal(f.run().status, 1);
  assert.equal(f.read('new.txt'), 'developer changed generated file'); assert.deepEqual(fs.readFileSync(path.join(f.root, '.overlay-sync.json')), manifest);
});

test('legacy path arrays do not authorize discarding unknown bytes', t => {
  const f = fixture(t); f.overlay('a.txt', 'desired overlay'); f.manifest(['a.txt']); f.write(f.base, 'a.txt', 'unknown old bytes');
  assert.equal(f.run().status, 1); assert.equal(f.run('--clean').status, 1); assert.equal(f.read('a.txt'), 'unknown old bytes');
});

test('an exactly matching legacy sync can establish ownership without rewriting the file', t => {
  const f = fixture(t); f.overlay('a.txt', 'old overlay'); f.manifest(['a.txt']); f.write(f.base, 'a.txt', 'old overlay');
  const stamp = fs.statSync(path.join(f.base, 'a.txt')).mtimeMs; assert.equal(f.run().status, 0);
  assert.equal(fs.statSync(path.join(f.base, 'a.txt')).mtimeMs, stamp);
  f.overlay('a.txt', 'new overlay'); assert.equal(f.run().status, 0); assert.equal(f.read('a.txt'), 'new overlay');
  assert.equal(f.run('--clean').status, 0); assert.equal(f.read('a.txt'), 'base-a');
});

test('malformed or unsafe manifests fail closed', t => {
  const f = fixture(t); f.overlay('a.txt', 'overlay-a');
  for (const value of ['{', '{"files":[]}', '["a.txt","a.txt"]', '["../outside.txt"]', '[".git/config"]', '["a\\\\b"]']) {
    f.write(f.root, '.overlay-sync.json', value); assert.equal(f.run().status, 1, value); assert.equal(f.read('a.txt'), 'base-a');
    assert.equal(fs.readFileSync(path.join(f.root, '.overlay-sync.json'), 'utf8'), value);
  }
});

test('a legacy clean cannot follow traversal paths outside the base', t => {
  const f = fixture(t); f.write(f.root, 'outside.txt', 'keep outside'); f.manifest(['../outside.txt']);
  assert.equal(f.run('--clean').status, 1); assert.equal(fs.readFileSync(path.join(f.root, 'outside.txt'), 'utf8'), 'keep outside');
});

test('source and destination directory symlinks are rejected before any overwrite', t => {
  const f = fixture(t); f.overlay('a.txt', 'overlay-a');
  const external = path.join(f.root, 'external'); fs.mkdirSync(external); f.write(external, 'value.txt', 'outside');
  fs.symlinkSync(external, path.join(f.root, 'overlay/link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(f.run().status, 1); assert.equal(f.read('a.txt'), 'base-a');
  fs.unlinkSync(path.join(f.root, 'overlay/link')); f.overlay('link/value.txt', 'overlay');
  fs.symlinkSync(external, path.join(f.base, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(f.run().status, 1); assert.equal(f.read('a.txt'), 'base-a'); assert.equal(fs.readFileSync(path.join(external, 'value.txt'), 'utf8'), 'outside');
});

test('replacement keeps a persistent backup of original bytes and the prior manifest', t => {
  const f = fixture(t); f.overlay('a.txt', 'overlay-a'); assert.equal(f.run().status, 0);
  const backups = path.join(f.root, '.cache/overlay-sync/backups'); const transactions = fs.readdirSync(backups); assert.equal(transactions.length, 1);
  const backup = path.join(backups, transactions[0]); const journal = JSON.parse(fs.readFileSync(path.join(backup, 'transaction.json'), 'utf8'));
  assert.equal(journal.status, 'committed'); const original = journal.files.find(file => file.path === 'a.txt');
  assert.equal(fs.readFileSync(path.join(backup, original.backup), 'utf8'), 'base-a'); assert.equal(journal.manifest.exists, false);
});

test('Git restore failure rolls back prior writes and preserves a recoverable backup', t => {
  const f = fixture(t); f.overlay('a.txt', 'overlay-a'); f.overlay('b.txt', 'overlay-b'); assert.equal(f.run().status, 0);
  const beforeManifest = fs.readFileSync(path.join(f.root, '.overlay-sync.json'));
  f.overlay('a.txt', 'updated-a'); fs.unlinkSync(path.join(f.root, 'overlay/b.txt')); f.write(f.base, '.git/index.lock', 'fixture lock');
  const result = f.run(); assert.equal(result.status, 1); assert.match(result.stderr, /backup|备份|恢复/);
  assert.equal(f.read('a.txt'), 'overlay-a'); assert.equal(f.read('b.txt'), 'overlay-b'); assert.deepEqual(fs.readFileSync(path.join(f.root, '.overlay-sync.json')), beforeManifest);
  const journals = fs.readdirSync(path.join(f.root, '.cache/overlay-sync/backups')).map(name => JSON.parse(fs.readFileSync(path.join(f.root, '.cache/overlay-sync/backups', name, 'transaction.json'), 'utf8')));
  assert.ok(journals.some(journal => journal.status === 'rolled-back'));
});
