import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-failure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, 'nuwa-electron-shell');
  const write = (dir, name, value) => { const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
  const git = (...args) => execFileSync('git', ['-C', base, ...args], { encoding: 'utf8' }).trim();
  fs.mkdirSync(base); fs.mkdirSync(path.join(root, 'overlay'));
  write(root, 'scripts/sync-overlay.js', fs.readFileSync(new URL('./sync-overlay.js', import.meta.url)));
  git('init', '-q'); write(base, 'a.txt', 'base-a'); write(base, 'b.txt', 'base-b'); git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(root, 'no-hooks')}`, 'commit', '-qm', 'baseline');
  const run = (...args) => spawnSync(process.execPath, [path.join(root, 'scripts/sync-overlay.js'), ...args], { encoding: 'utf8' });
  const injected = (code, args = []) => {
    write(root, 'fault.cjs', `const fs = require('node:fs'); const path = require('node:path'); const cp = require('node:child_process'); const root = __dirname; const base = path.join(root, 'nuwa-electron-shell');\n${code}`);
    return spawnSync(process.execPath, ['--require', path.join(root, 'fault.cjs'), path.join(root, 'scripts/sync-overlay.js'), ...args], { encoding: 'utf8' });
  };
  const journals = () => fs.readdirSync(path.join(root, '.cache/overlay-sync/backups')).sort().map(name => ({ directory: path.join(root, '.cache/overlay-sync/backups', name), ...JSON.parse(fs.readFileSync(path.join(root, '.cache/overlay-sync/backups', name, 'transaction.json'))) }));
  return { root, base, git, write, run, injected, journals, overlay: (name, value) => write(path.join(root, 'overlay'), name, value), read: name => fs.readFileSync(path.join(base, name), 'utf8') };
}

for (const flag of ['--assume-unchanged', '--skip-worktree']) {
  test(`${flag} cannot hide unknown worktree bytes from preflight`, t => {
    const f = fixture(t); f.overlay('a.txt', 'overlay-a'); f.overlay('b.txt', 'overlay-b');
    f.git('update-index', flag, 'b.txt'); f.write(f.base, 'b.txt', 'hidden developer WIP');
    assert.equal(f.git('diff', '--name-only'), '', 'fixture really hides WIP from git diff');
    const result = f.run(); assert.equal(result.status, 1); assert.match(result.stderr, /b\.txt/);
    assert.equal(f.read('a.txt'), 'base-a'); assert.equal(f.read('b.txt'), 'hidden developer WIP');
  });
}

test('case-only collisions across previous and next manifests reject on every platform', t => {
  const f = fixture(t); f.overlay('Foo.txt', 'old overlay'); assert.equal(f.run().status, 0);
  const manifest = fs.readFileSync(path.join(f.root, '.overlay-sync.json'));
  fs.unlinkSync(path.join(f.root, 'overlay/Foo.txt')); f.overlay('foo.txt', 'new overlay');
  const result = f.run(); assert.equal(result.status, 1); assert.match(result.stderr, /大小写|case/i);
  assert.equal(f.read('Foo.txt'), 'old overlay'); assert.deepEqual(fs.readFileSync(path.join(f.root, '.overlay-sync.json')), manifest);
});

test('an existing mutex rejects writes while check remains read-only', t => {
  const f = fixture(t); f.overlay('a.txt', 'overlay-a'); f.write(f.root, '.cache/overlay-sync/lock.json', '{"pid":1234}');
  assert.equal(f.run().status, 1); assert.equal(f.read('a.txt'), 'base-a');
  assert.equal(f.run('--check').status, 1); assert.equal(f.read('a.txt'), 'base-a');
  assert.equal(fs.readFileSync(path.join(f.root, '.cache/overlay-sync/lock.json'), 'utf8'), '{"pid":1234}');
  assert.equal(fs.existsSync(path.join(f.root, '.overlay-sync.json')), false);
});

test('ledger corruption and ledger/manifest disagreement fail closed', t => {
  const f = fixture(t); f.overlay('a.txt', 'overlay-a'); assert.equal(f.run().status, 0); f.overlay('a.txt', 'next overlay');
  for (const value of ['{', '{"schema":1,"files":{}}', '{"schema":1,"files":{"a.txt":{"sha256":"bad","mode":420}}}']) {
    f.write(f.root, '.cache/overlay-sync/state.json', value); const result = f.run(); assert.equal(result.status, 1, value);
    assert.equal(f.read('a.txt'), 'overlay-a'); assert.equal(fs.readFileSync(path.join(f.root, '.cache/overlay-sync/state.json'), 'utf8'), value);
  }
});

test('manifest paths cannot use Git metadata or Windows aliases', t => {
  const f = fixture(t); f.overlay('a.txt', 'overlay-a');
  for (const entry of ['x/.GiT/config', 'C:/escape', 'x/file:stream', 'x/CON.txt', 'x/lpt1', 'x/trailing.', 'x/trailing ', '/absolute', 'x//file']) {
    f.write(f.root, '.overlay-sync.json', JSON.stringify([entry]));
    assert.equal(f.run().status, 1, entry); assert.equal(f.read('a.txt'), 'base-a');
  }
});

test('base and overlay roots cannot be directory symlinks', t => {
  const f = fixture(t); f.overlay('a.txt', 'overlay-a');
  for (const name of ['overlay', 'nuwa-electron-shell']) {
    fs.renameSync(path.join(f.root, name), path.join(f.root, `${name}-real`));
    fs.symlinkSync(path.join(f.root, `${name}-real`), path.join(f.root, name), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(f.run().status, 1, name); assert.equal(f.read('a.txt'), 'base-a');
    fs.unlinkSync(path.join(f.root, name)); fs.renameSync(path.join(f.root, `${name}-real`), path.join(f.root, name));
  }
});

test('ledger and backup storage cannot follow symlinks', t => {
  const f = fixture(t); f.overlay('a.txt', 'overlay-a');
  const external = path.join(f.root, 'external'); fs.mkdirSync(external); f.write(external, 'state.json', 'outside bytes');
  for (const target of ['.cache/overlay-sync', '.cache/overlay-sync/backups']) {
    fs.mkdirSync(path.dirname(path.join(f.root, target)), { recursive: true });
    fs.symlinkSync(external, path.join(f.root, target), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(f.run().status, 1, target); assert.equal(f.read('a.txt'), 'base-a'); fs.unlinkSync(path.join(f.root, target));
  }
  fs.symlinkSync(path.join(external, 'state.json'), path.join(f.root, '.cache/overlay-sync/state.json'));
  assert.equal(f.run().status, 1); assert.equal(fs.readFileSync(path.join(external, 'state.json'), 'utf8'), 'outside bytes');
});

test('a failure after file rename still rolls the in-flight target back', t => {
  const f = fixture(t); f.overlay('a.txt', 'overlay-a');
  const result = f.injected(`const rename = fs.renameSync; let failed = false; fs.renameSync = (from, to) => { rename(from, to); if (!failed && to === path.join(base, 'a.txt')) { failed = true; throw new Error('injected post-rename failure'); } };`);
  assert.equal(result.status, 1); assert.equal(f.read('a.txt'), 'base-a'); assert.equal(f.journals().at(-1).status, 'rolled-back');
});

test('a post-write read failure cannot leave a changed target marked rolled back', t => {
  const f = fixture(t); f.overlay('a.txt', 'overlay-a');
  const result = f.injected(`const rename = fs.renameSync; const read = fs.readFileSync; let failRead = false; fs.renameSync = (from, to) => { rename(from, to); if (to === path.join(base, 'a.txt')) failRead = true; }; fs.readFileSync = (file, ...args) => { if (file === path.join(base, 'a.txt') && failRead) { failRead = false; throw new Error('injected post-write read failure'); } return read(file, ...args); };`);
  assert.equal(result.status, 1); assert.equal(f.read('a.txt'), 'base-a'); assert.equal(f.journals().at(-1).status, 'rolled-back');
});

test('Git restore that changed bytes before reporting failure restores all touched targets', t => {
  const f = fixture(t); f.overlay('a.txt', 'overlay-a'); f.overlay('b.txt', 'overlay-b'); assert.equal(f.run().status, 0);
  const manifest = fs.readFileSync(path.join(f.root, '.overlay-sync.json')); f.overlay('a.txt', 'next-a'); fs.unlinkSync(path.join(f.root, 'overlay/b.txt'));
  const result = f.injected(`const spawn = cp.spawnSync; let failed = false; cp.spawnSync = (command, args, options) => { const result = spawn(command, args, options); if (!failed && command === 'git' && args[0] === 'checkout') { failed = true; return { ...result, status: 1, stderr: 'injected partial checkout failure' }; } return result; };`);
  assert.equal(result.status, 1); assert.equal(f.read('a.txt'), 'overlay-a'); assert.equal(f.read('b.txt'), 'overlay-b');
  assert.deepEqual(fs.readFileSync(path.join(f.root, '.overlay-sync.json')), manifest); assert.equal(f.journals().at(-1).status, 'rolled-back');
});

test('a ledger commit failure restores target bytes and both prior metadata files', t => {
  const f = fixture(t); f.overlay('a.txt', 'overlay-a'); assert.equal(f.run().status, 0);
  const manifest = fs.readFileSync(path.join(f.root, '.overlay-sync.json')); const ledger = fs.readFileSync(path.join(f.root, '.cache/overlay-sync/state.json'));
  f.overlay('a.txt', 'next overlay');
  const result = f.injected(`const rename = fs.renameSync; let failed = false; fs.renameSync = (from, to) => { if (!failed && to === path.join(root, '.cache/overlay-sync/state.json')) { failed = true; throw new Error('injected ledger commit failure'); } return rename(from, to); };`);
  assert.equal(result.status, 1); assert.equal(f.read('a.txt'), 'overlay-a');
  assert.deepEqual(fs.readFileSync(path.join(f.root, '.overlay-sync.json')), manifest); assert.deepEqual(fs.readFileSync(path.join(f.root, '.cache/overlay-sync/state.json')), ledger);
  assert.equal(f.journals().at(-1).status, 'rolled-back');
});

test('external metadata edits during commit are preserved and require explicit recovery', t => {
  const f = fixture(t); f.overlay('a.txt', 'overlay-a');
  const result = f.injected(`const rename = fs.renameSync; let failed = false; fs.renameSync = (from, to) => { if (!failed && to === path.join(root, '.cache/overlay-sync/state.json')) { failed = true; fs.writeFileSync(path.join(root, '.overlay-sync.json'), 'external metadata'); throw new Error('injected concurrent metadata failure'); } return rename(from, to); };`);
  assert.equal(result.status, 1); assert.equal(f.read('a.txt'), 'base-a');
  assert.equal(fs.readFileSync(path.join(f.root, '.overlay-sync.json'), 'utf8'), 'external metadata');
  const journal = f.journals().at(-1); assert.equal(journal.status, 'recovery-required'); assert.match(result.stderr, new RegExp(journal.directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('external target edits during a failing write are preserved with recovery-required status', t => {
  const f = fixture(t); f.overlay('a.txt', 'overlay-a');
  const result = f.injected(`const rename = fs.renameSync; let failed = false; fs.renameSync = (from, to) => { rename(from, to); if (!failed && to === path.join(base, 'a.txt')) { failed = true; fs.writeFileSync(to, 'concurrent developer WIP'); throw new Error('injected concurrent target failure'); } };`);
  assert.equal(result.status, 1); assert.equal(f.read('a.txt'), 'concurrent developer WIP');
  const journal = f.journals().at(-1); assert.equal(journal.status, 'recovery-required');
  assert.equal(fs.readFileSync(path.join(journal.directory, journal.files[0].backup), 'utf8'), 'base-a');
  assert.equal(f.run().status, 1, 'unfinished transaction blocks further mutation');
});

test('backup write failure happens before target mutation and leaves a named recovery directory', t => {
  const f = fixture(t); f.overlay('a.txt', 'overlay-a');
  const result = f.injected(`const open = fs.openSync; fs.openSync = (file, ...args) => { if (typeof file === 'string' && file.endsWith('file-0.original')) throw new Error('injected backup disk failure'); return open(file, ...args); };`);
  assert.equal(result.status, 1); assert.equal(f.read('a.txt'), 'base-a'); assert.match(result.stderr, /backups/);
  assert.equal(fs.existsSync(path.join(f.root, '.overlay-sync.json')), false);
});
