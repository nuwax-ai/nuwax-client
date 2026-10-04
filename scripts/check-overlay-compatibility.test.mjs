import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkOverlayCompatibility, assertOverlayCompatibility } from './check-overlay-compatibility.mjs';
import { run } from './client/core.mjs';

const temporary = [];
afterEach(() => { for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function git(directory, ...args) {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Overlay Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Overlay Test', GIT_COMMITTER_EMAIL: 'test@example.invalid', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false' } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function write(directory, relative, contents) {
  fs.mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true });
  fs.writeFileSync(path.join(directory, relative), contents);
}
function fixture(files = { 'shared.txt': 'old base\n', 'other.txt': 'old other\n' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-compatibility-'));
  temporary.push(root);
  const base = path.join(root, 'nuwa-electron-shell'); fs.mkdirSync(base); git(base, 'init', '--initial-branch=main');
  for (const [name, contents] of Object.entries(files)) write(base, name, contents);
  const commit = () => { git(base, 'add', '-A'); git(base, 'commit', '-m', 'test fixture'); return git(base, 'rev-parse', 'HEAD'); };
  const from = commit();
  return { root, base, from, commit, overlay(name, contents = 'commercial\n') { write(root, `overlay/${name}`, contents); } };
}
function partialCloneFixture() {
  const oldContents = Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\n') + '\n';
  const source = fixture({ 'shared.txt': 'unchanged\n', 'old.txt': oldContents });
  git(source.base, 'config', 'uploadpack.allowFilter', 'true');
  const root = path.join(source.root, 'client'), base = path.join(root, 'nuwa-electron-shell');
  fs.mkdirSync(root);
  git(root, 'clone', '--filter=blob:none', '--', pathToFileURL(source.base).href, base);
  fs.unlinkSync(path.join(source.base, 'old.txt')); write(source.base, 'new.txt', oldContents + 'different tail\n');
  const to = source.commit(), missingBlob = git(source.base, 'rev-parse', `${to}:new.txt`);
  git(base, 'fetch', '--filter=blob:none', '--prune', '--tags', 'origin', '+refs/heads/*:refs/remotes/origin/*');
  assert.ok(git(base, 'rev-list', '--objects', '--missing=print', to).split('\n').includes(`?${missingBlob}`), 'new file blob must actually remain unhydrated');
  // Make accidental lazy fetching fail even if a future implementation omits GIT_NO_LAZY_FETCH.
  git(base, 'config', 'remote.origin.url', pathToFileURL(path.join(source.root, 'unavailable-remote')).href);
  return { root, base, from: source.from, to, overlay(name, contents = 'commercial\n') { write(root, `overlay/${name}`, contents); } };
}
function recordReviews(fixture, changes) {
  write(fixture.root, 'overlay-base-reviews.json', JSON.stringify({ schemaVersion: 1, reviews: changes.map(change => ({ path: change.path, baseBlob: change.newBase?.blob ?? null, baseMode: change.newBase?.mode ?? null, overlaySha256: change.overlaySha256, note: 'Manually inspected base changes and retained commercial behavior.' })) }));
}
function cli(fixture, ...args) {
  return spawnSync(process.execPath, [fileURLToPath(new URL('./check-overlay-compatibility.mjs', import.meta.url)), '--root', fixture.root, ...args], { encoding: 'utf8' });
}

test('unrelated base changes pass, root README is excluded, nested README remains an overlay', async () => {
  const f = fixture({ 'shared.txt': 'old\n', 'README.md': 'base docs\n', 'nested/README.md': 'nested base\n' });
  f.overlay('shared.txt'); f.overlay('README.md', 'overlay docs\n'); f.overlay('nested/README.md');
  write(f.base, 'README.md', 'new docs\n'); write(f.base, 'other.txt', 'unrelated\n');
  const to = f.commit();
  const report = await checkOverlayCompatibility(f.root, { from: f.from, to });
  assert.equal(report.ok, true); assert.deepEqual(report.changes, []); assert.equal(report.overlayFiles, 2);
  write(f.base, 'nested/README.md', 'new nested base\n'); f.commit();
  const nested = await checkOverlayCompatibility(f.root, { from: f.from });
  assert.equal(nested.ok, false); assert.equal(nested.changes[0].path, 'nested/README.md');
});

test('partial clone passes unrelated similar rename without reading blobs or changing repository state', async () => {
  const f = partialCloneFixture(); f.overlay('shared.txt');
  const indexPath = path.join(f.base, '.git/index'), index = fs.readFileSync(indexPath);
  const objects = git(f.base, 'count-objects', '-v'), refs = git(f.base, 'show-ref'), head = git(f.base, 'rev-parse', 'HEAD');
  const commands = [];
  const report = await checkOverlayCompatibility(f.root, { from: f.from, to: f.to }, { run(command, args, options) {
    assert.equal(command, 'git'); assert.equal(options.env.GIT_NO_LAZY_FETCH, '1');
    commands.push(args[0]); return run(command, args, options);
  } });
  assert.equal(report.ok, true); assert.deepEqual(report.changes, []);
  assert.ok(commands.every(command => ['rev-parse', 'ls-tree'].includes(command)), 'compatibility checks must only read commit and tree metadata');
  assert.deepEqual(fs.readFileSync(indexPath), index); assert.equal(git(f.base, 'count-objects', '-v'), objects);
  assert.equal(git(f.base, 'show-ref'), refs); assert.equal(git(f.base, 'rev-parse', 'HEAD'), head);
});

test('partial clone blocks both overlay paths of a similar rename using only tree entries', async () => {
  const f = partialCloneFixture(); f.overlay('old.txt'); f.overlay('new.txt');
  const report = await checkOverlayCompatibility(f.root, { from: f.from, to: f.to });
  assert.equal(report.ok, false); assert.equal(report.unreviewed, 2);
  assert.deepEqual(report.changes.map(change => [change.path, change.kind]), [['new.txt', 'new-collision'], ['old.txt', 'deleted']]);
  recordReviews(f, report.changes);
  assert.equal((await assertOverlayCompatibility(f.root, { from: f.from, to: f.to })).ok, true);
});

test('changed base file is blocked and reports exact binding values', async () => {
  const f = fixture(); f.overlay('shared.txt'); write(f.base, 'shared.txt', 'new base\n'); const to = f.commit();
  const report = await checkOverlayCompatibility(f.root, { from: f.from, to });
  assert.equal(report.ok, false); assert.equal(report.unreviewed, 1); assert.equal(report.changes[0].review, 'missing');
  assert.equal(report.changes[0].kind, 'modified'); assert.equal(report.changes[0].oldBase.blob, git(f.base, 'rev-parse', `${f.from}:shared.txt`));
  assert.equal(report.changes[0].newBase.blob, git(f.base, 'rev-parse', `${to}:shared.txt`)); assert.equal(report.changes[0].newBase.mode, '100644');
  assert.match(report.changes[0].overlaySha256, /^[0-9a-f]{64}$/);
  await assert.rejects(assertOverlayCompatibility(f.root, { from: f.from, to }), /overlay.*兼容审查未通过/);
});

test('new base collision and deletion are blocked, deletion binds null object and mode', async () => {
  const f = fixture(); f.overlay('shared.txt'); f.overlay('added.txt');
  fs.unlinkSync(path.join(f.base, 'shared.txt')); write(f.base, 'added.txt', 'new base-owned file\n'); const to = f.commit();
  const report = await checkOverlayCompatibility(f.root, { from: f.from, to });
  assert.deepEqual(report.changes.map(change => [change.path, change.kind]), [['added.txt', 'new-collision'], ['shared.txt', 'deleted']]);
  assert.equal(report.changes[1].newBase, null); assert.equal(report.unreviewed, 2);
  recordReviews(f, report.changes);
  const reviewed = await assertOverlayCompatibility(f.root, { from: f.from, to });
  assert.equal(reviewed.ok, true); assert.equal(reviewed.unreviewed, 0);
});

test('an overlay-only file is blocked when its ancestor directory becomes a base file', async () => {
  const f = fixture({ 'a/base.txt': 'base directory\n' }); f.overlay('a/b.ts', 'commercial-only child\n');
  fs.rmSync(path.join(f.base, 'a'), { recursive: true }); write(f.base, 'a', 'base file now occupies the directory\n'); const to = f.commit();
  const report = await checkOverlayCompatibility(f.root, { from: f.from, to });
  assert.equal(report.ok, false); assert.equal(report.unreviewed, 1);
  assert.equal(report.changes[0].path, 'a/b.ts'); assert.equal(report.changes[0].blockedBy, 'a');
  assert.equal(report.changes[0].kind, 'ancestor-collision');
  recordReviews(f, report.changes);
  assert.equal((await checkOverlayCompatibility(f.root, { from: f.from, to })).ok, false, 'a review cannot make the filesystem topology compatible');
});

test('a target ancestor symlink is blocked rather than allowing overlay writes through the link', async () => {
  const f = fixture({ 'a/base.txt': 'base directory\n' }); f.overlay('a/nested/b.ts', 'commercial-only child\n');
  fs.rmSync(path.join(f.base, 'a'), { recursive: true }); write(f.base, 'a', '../outside-checkout\n');
  git(f.base, 'add', '-A'); const blob = git(f.base, 'hash-object', 'a');
  // A real symlink Git entry without requiring Windows symlink privileges.
  git(f.base, 'update-index', '--cacheinfo', `120000,${blob},a`); git(f.base, 'commit', '-m', 'directory becomes symlink');
  const to = git(f.base, 'rev-parse', 'HEAD');
  const report = await checkOverlayCompatibility(f.root, { from: f.from, to });
  assert.equal(report.ok, false); assert.equal(report.changes[0].blockedBy, 'a');
  assert.deepEqual(report.changes[0].blockingBase, { blob, mode: '120000' });
  assert.equal(report.changes[0].review, 'blocked');
  recordReviews(f, report.changes);
  await assert.rejects(assertOverlayCompatibility(f.root, { from: f.from, to }), /审查记录不能放行/);
});

for (const mode of ['040000', '120000', '160000']) {
  test(`a target overlay leaf with mode ${mode} cannot be allowed by matching review or unchanged base SHA`, async () => {
    const f = fixture({ 'leaf': 'old regular base file\n' }); f.overlay('leaf', 'regular commercial file\n');
    if (mode === '040000') {
      fs.unlinkSync(path.join(f.base, 'leaf')); write(f.base, 'leaf/child.txt', 'base directory\n'); f.commit();
    } else {
      const object = mode === '160000' ? f.from : git(f.base, 'rev-parse', `${f.from}:leaf`);
      git(f.base, 'update-index', '--cacheinfo', `${mode},${object},leaf`); git(f.base, 'commit', '-m', 'target non-file entry');
    }
    const to = git(f.base, 'rev-parse', 'HEAD');
    const report = await checkOverlayCompatibility(f.root, { from: f.from, to });
    recordReviews(f, report.changes);
    assert.equal((await checkOverlayCompatibility(f.root, { from: f.from, to })).ok, false, 'matching review must not allow an unsafe destination');
    assert.equal(report.changes[0].kind, 'path-collision'); assert.equal(report.changes[0].blockedBy, 'leaf');
    assert.equal(report.changes[0].blockingBase.mode, mode); assert.equal(report.changes[0].review, 'blocked');
    assert.equal((await checkOverlayCompatibility(f.root, { from: to, to })).ok, false, 'unchanged unsafe leaf must not be skipped');
  });
}

test('autocrlf Windows clone keeps overlay LF and binary bytes so existing raw-byte reviews remain valid', async () => {
  const binaries = Object.fromEntries(['png', 'ico', 'icns'].map((extension, index) => [`assets/icon.${extension}`, Buffer.from([0, index, 13, 10, 3, 255, 10, 13])]));
  const f = fixture({ 'shared.txt': 'old base\n', ...binaries });
  const overlayText = 'export const value = 1;\nexport const next = 2;\n'; f.overlay('shared.txt', overlayText);
  for (const [name, bytes] of Object.entries(binaries)) f.overlay(name, bytes);
  write(f.base, 'shared.txt', 'changed base\n');
  for (const [name, bytes] of Object.entries(binaries)) write(f.base, name, Buffer.concat([bytes, Buffer.from([4])]));
  const to = f.commit(); const report = await checkOverlayCompatibility(f.root, { from: f.from, to }); recordReviews(f, report.changes);
  assert.equal(report.changes.length, 4);
  git(f.root, 'init', '--initial-branch=main'); git(f.root, 'config', 'core.autocrlf', 'false');
  write(f.root, '.gitignore', 'nuwa-electron-shell/\n');
  const attributesFile = fileURLToPath(new URL('../.gitattributes', import.meta.url));
  write(f.root, '.gitattributes', fs.readFileSync(attributesFile));
  write(f.root, 'notes.txt', 'outside overlay\nsecond line\n');
  git(f.root, 'add', '-A'); git(f.root, 'commit', '-m', 'reviewed commercial fixture');
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-autocrlf-clone-')); temporary.push(clone);
  git(f.root, 'clone', '--config', 'core.autocrlf=true', '--', f.root, clone);
  git(clone, 'clone', '--', f.base, path.join(clone, 'nuwa-electron-shell'));
  assert.equal(git(clone, 'config', '--get', 'core.autocrlf'), 'true');
  assert.equal(fs.readFileSync(path.join(clone, 'notes.txt'), 'utf8'), 'outside overlay\r\nsecond line\r\n', 'fixture must actually exercise CRLF checkout outside the scoped rules');
  assert.equal(fs.readFileSync(path.join(clone, 'overlay/shared.txt'), 'utf8'), overlayText);
  for (const [name, bytes] of Object.entries(binaries)) {
    assert.deepEqual(fs.readFileSync(path.join(clone, 'overlay', name)), bytes);
    assert.match(git(clone, 'check-attr', 'text', '--', `overlay/${name}`), /: text: unset$/);
  }
  const clonedReport = await checkOverlayCompatibility(clone, { from: f.from, to });
  assert.equal(clonedReport.ok, true); assert.equal(clonedReport.changes.length, 4);
  assert.deepEqual(clonedReport.changes.map(change => change.overlaySha256), report.changes.map(change => change.overlaySha256));
});

test('base executable mode changes require review even when the blob is unchanged', async () => {
  const f = fixture(); f.overlay('shared.txt');
  git(f.base, 'update-index', '--chmod=+x', '--', 'shared.txt'); git(f.base, 'commit', '-m', 'mode only');
  const to = git(f.base, 'rev-parse', 'HEAD');
  const report = await checkOverlayCompatibility(f.root, { from: f.from, to });
  assert.equal(report.ok, false); assert.equal(report.changes[0].kind, 'mode-changed');
  assert.equal(report.changes[0].oldBase.blob, report.changes[0].newBase.blob);
  assert.equal(report.changes[0].newBase.mode, '100755');
  recordReviews(f, report.changes); assert.equal((await checkOverlayCompatibility(f.root, { from: f.from, to })).ok, true);
});

test('rename blocks deleted and added overlay endpoints without splitting tabs, newlines or spaces', async () => {
  const oldPath = 'dir/old\tline\n name.txt', newPath = 'dir/new\tline\n name.txt ';
  const f = fixture({ [oldPath]: 'identical renamed base\n' }); f.overlay(oldPath); f.overlay(newPath);
  git(f.base, 'mv', '--', oldPath, newPath); const to = f.commit();
  const report = await checkOverlayCompatibility(f.root, { from: f.from, to });
  assert.equal(report.changes.length, 2); assert.equal(report.unreviewed, 2);
  assert.deepEqual(new Set(report.changes.map(change => change.path)), new Set([oldPath, newPath]));
  assert.equal(report.changes.find(change => change.path === oldPath).kind, 'deleted');
  assert.equal(report.changes.find(change => change.path === newPath).kind, 'new-collision');
  recordReviews(f, report.changes); assert.equal((await checkOverlayCompatibility(f.root, { from: f.from, to })).ok, true);
});

test('review records expire when overlay contents, target base contents or mode changes', async () => {
  const f = fixture(); f.overlay('shared.txt'); write(f.base, 'shared.txt', 'reviewed base\n'); const reviewedTo = f.commit();
  const original = await checkOverlayCompatibility(f.root, { from: f.from, to: reviewedTo }); recordReviews(f, original.changes);
  assert.equal((await checkOverlayCompatibility(f.root, { from: f.from, to: reviewedTo })).ok, true);
  f.overlay('shared.txt', 'new commercial implementation\n');
  assert.equal((await checkOverlayCompatibility(f.root, { from: f.from, to: reviewedTo })).changes[0].review, 'stale');
  f.overlay('shared.txt'); write(f.base, 'shared.txt', 'different target base\n'); const changedTo = f.commit();
  assert.equal((await checkOverlayCompatibility(f.root, { from: f.from, to: changedTo })).changes[0].review, 'stale');
  git(f.base, 'checkout', '--detach', reviewedTo); git(f.base, 'update-index', '--chmod=+x', '--', 'shared.txt'); git(f.base, 'commit', '-m', 'mode after review');
  assert.equal((await checkOverlayCompatibility(f.root, { from: f.from })).changes[0].review, 'stale');
});

test('invalid review schema or unreasoned records fail closed', async () => {
  const f = fixture(); f.overlay('shared.txt'); write(f.base, 'shared.txt', 'new base\n'); f.commit();
  write(f.root, 'overlay-base-reviews.json', JSON.stringify({ reviews: [] }));
  await assert.rejects(checkOverlayCompatibility(f.root, { from: f.from }), /schemaVersion/);
  const reportFile = path.join(f.root, 'overlay-base-reviews.json'); fs.unlinkSync(reportFile);
  const report = await checkOverlayCompatibility(f.root, { from: f.from }); recordReviews(f, report.changes);
  const record = JSON.parse(fs.readFileSync(reportFile, 'utf8')); record.reviews[0].note = ' ';
  fs.writeFileSync(reportFile, JSON.stringify(record));
  await assert.rejects(checkOverlayCompatibility(f.root, { from: f.from }), /无效审查记录/);
});

test('read-only guard preserves dirty worktree, index, HEAD, manifest and refs; injected tools see only Git reads', async () => {
  const f = fixture(); f.overlay('shared.txt'); write(f.base, 'shared.txt', 'target\n'); const to = f.commit();
  git(f.base, 'checkout', '--detach', f.from);
  write(f.base, 'shared.txt', 'staged developer WIP\n'); git(f.base, 'add', 'shared.txt'); write(f.base, 'shared.txt', 'unstaged developer WIP\n');
  write(f.base, 'untracked.txt', 'untracked WIP\n'); write(f.root, '.overlay-sync.json', '["shared.txt"]\n');
  const indexPath = path.join(f.base, '.git/index'), index = fs.readFileSync(indexPath), status = git(f.base, 'status', '--porcelain', '-z');
  const refs = git(f.base, 'show-ref'), manifest = fs.readFileSync(path.join(f.root, '.overlay-sync.json'));
  const commands = [];
  const report = await checkOverlayCompatibility(f.root, { from: f.from, to }, { run(command, args, options) {
    assert.equal(command, 'git'); assert.ok(['rev-parse', 'ls-tree'].includes(args[0])); assert.equal(options.env.GIT_OPTIONAL_LOCKS, '0'); assert.equal(options.env.GIT_NO_LAZY_FETCH, '1');
    commands.push(args[0]); return run(command, args, options);
  } });
  assert.equal(report.ok, false); assert.ok(commands.includes('ls-tree'));
  assert.deepEqual(fs.readFileSync(indexPath), index); assert.equal(git(f.base, 'rev-parse', 'HEAD'), f.from);
  assert.equal(git(f.base, 'status', '--porcelain', '-z'), status); assert.equal(git(f.base, 'show-ref'), refs);
  assert.deepEqual(fs.readFileSync(path.join(f.root, '.overlay-sync.json')), manifest);
  assert.equal(fs.readFileSync(path.join(f.base, 'shared.txt'), 'utf8'), 'unstaged developer WIP\n');
  assert.equal(fs.readFileSync(path.join(f.base, 'untracked.txt'), 'utf8'), 'untracked WIP\n');
});

test('CLI JSON exit status distinguishes approved, unreviewed and invalid input, with --to defaulting to HEAD', async () => {
  const f = fixture(); f.overlay('shared.txt'); write(f.base, 'shared.txt', 'target\n'); const to = f.commit();
  const failed = cli(f, '--from', f.from, '--json'); assert.equal(failed.status, 1, failed.stderr);
  const report = JSON.parse(failed.stdout); assert.equal(report.to, to); recordReviews(f, report.changes);
  const passed = cli(f, '--from', f.from, '--to', to, '--json'); assert.equal(passed.status, 0, passed.stderr); assert.equal(JSON.parse(passed.stdout).ok, true);
  const invalid = cli(f, '--from', 'missing-ref', '--json'); assert.equal(invalid.status, 2); assert.equal(JSON.parse(invalid.stdout).ok, false);
  const missing = cli(f, '--json'); assert.equal(missing.status, 2); assert.match(JSON.parse(missing.stdout).error, /无效基座引用/);
});
