import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import archivePolicy from '../overlay/crates/agent-electron-client/scripts/build/installer-archive-policy.cjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const workflow = readFileSync(new URL('../.github/workflows/release-electron-dev.yml', import.meta.url), 'utf8');
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

function step(name) {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line === `      - name: ${name}`);
  assert.ok(start >= 0, `Missing workflow step: ${name}`);
  let end = start + 1;
  while (end < lines.length && !/^      - name:|^  [a-z][a-z-]+:/.test(lines[end])) end++;
  return lines.slice(start, end).join('\n');
}

function script(name) {
  const lines = step(name).split('\n');
  const start = lines.indexOf('        run: |');
  assert.ok(start >= 0, `Missing run script: ${name}`);
  return lines.slice(start + 1).map((line) => line.startsWith('          ') ? line.slice(10) : line).join('\n');
}

function condition(block) {
  const match = /^\s+if: \$\{\{ (.+) \}\}$/m.exec(block);
  assert.ok(match, 'Missing explicit event/ref guard');
  return (event, ref) => Function('github', 'startsWith', `return (${match[1]});`)(
    { event_name: event, ref }, (value, prefix) => value.startsWith(prefix),
  );
}

function resolveIdentity(t, env = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'nuwax-qa-identity-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'output');
  writeFileSync(output, '');
  const result = spawnSync('bash', ['-c', script('Resolve frozen build identity')], {
    cwd: root,
    env: { ...process.env, BUILD_EVENT: 'workflow_dispatch', BUILD_REF: 'refs/heads/codex/client-qa', BUILD_SHA: sourceSha,
      VERSION_INPUT: '3.0.9', WINDOWS_ARCHIVE_INPUT: 'zip-qa', GITHUB_OUTPUT: output, ...env },
    encoding: 'utf8',
  });
  const values = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  return { ...result, values, directory };
}

test('manual QA builds retain numeric identity and select only allowed Windows archive policies', (t) => {
  for (const archive of ['7z', 'zip-qa']) {
    const result = resolveIdentity(t, { WINDOWS_ARCHIVE_INPUT: archive });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.values, { version: '3.0.9', tag: 'prerelease-v3.0.9', source_sha: sourceSha, windows_archive: archive });
  }
});

test('QA branch push defaults to ZIP while public tag push preserves its original archive policy', (t) => {
  for (const [ref, archive] of [['refs/heads/codex/beta-qa/3.0.9', 'zip-qa'], ['refs/tags/prerelease-v3.0.9', '']]) {
    const result = resolveIdentity(t, { BUILD_EVENT: 'push', BUILD_REF: ref });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.values.version, '3.0.9');
    assert.equal(result.values.tag, 'prerelease-v3.0.9');
    assert.equal(result.values.windows_archive, archive);
  }
});

test('workflow archive environment agrees with the shared policy for Windows 7z and ZIP, and other platforms', () => {
  const match = /NUWAX_WINDOWS_INSTALLER_ARCHIVE: \$\{\{ (.+) \}\}/.exec(step('Build Electron app'));
  assert.ok(match, 'Missing archive environment');
  const evaluate = Function('runner', 'needs', `return (${match[1]});`);
  for (const [osName, platform, archive, expected] of [
    ['Windows', 'win32', '7z', ''], ['Windows', 'win32', 'zip-qa', 'zip-qa'],
    ['Windows', 'win32', '', ''], ['macOS', 'darwin', 'zip-qa', ''], ['Linux', 'linux', 'zip-qa', ''],
  ]) {
    const mode = evaluate({ os: osName }, { prepare: { outputs: { windows_archive: archive } } });
    assert.equal(mode, expected);
    assert.equal(archivePolicy.resolveInstallerArchiveMode({ env: { [archivePolicy.ENV_KEY]: mode }, platform }), expected);
  }
});

test('QA identity rejects malformed versions, unsupported refs, archive input and unfrozen checkouts before output', (t) => {
  const invalid = [
    ...['03.0.9', '3.0', '3.0.9-qa.1', '3.0.9\nversion=9.9.9', '3.0.9$(touch "$QA_SENTINEL")'].map((VERSION_INPUT) => ({ VERSION_INPUT })),
    { WINDOWS_ARCHIVE_INPUT: 'zip-qa$(touch "$QA_SENTINEL")' },
    { BUILD_EVENT: 'push', BUILD_REF: 'refs/heads/codex/beta-qa/nested/3.0.9' },
    { BUILD_EVENT: 'push', BUILD_REF: 'refs/heads/main' },
    { BUILD_REF: 'refs/tags/prerelease-v3.0.9' },
    { BUILD_SHA: '0'.repeat(40) },
  ];
  const sentinelDir = mkdtempSync(path.join(os.tmpdir(), 'nuwax-qa-injection-'));
  t.after(() => rmSync(sentinelDir, { recursive: true, force: true }));
  const sentinel = path.join(sentinelDir, 'must-not-exist');
  for (const env of invalid) {
    const result = resolveIdentity(t, { QA_SENTINEL: sentinel, ...env });
    assert.notEqual(result.status, 0, JSON.stringify(env));
    assert.deepEqual(result.values, {});
    assert.equal(existsSync(sentinel), false, 'Input was interpolated as executable shell text');
  }
});

test('all three release mutations require a real tag push and QA artifacts use the inverse gate', () => {
  const releasePredicates = [condition(step('Create GitHub Release')), condition(step('Upload artifacts to Release')),
    condition(workflow.slice(workflow.indexOf('  publish-beta:')))];
  const qaPredicates = [condition(step('Stage isolated QA packages and build context')), condition(step('Upload isolated QA packages'))];
  for (const [event, ref, published] of [
    ['push', 'refs/tags/prerelease-v3.0.9', true],
    ['push', 'refs/heads/codex/beta-qa/3.0.9', false],
    ['workflow_dispatch', 'refs/heads/codex/client-qa', false],
    ['workflow_dispatch', 'refs/tags/prerelease-v3.0.9', false],
  ]) {
    for (const predicate of releasePredicates) assert.equal(predicate(event, ref), published, `${event}:${ref}`);
    for (const predicate of qaPredicates) assert.equal(predicate(event, ref), !published, `${event}:${ref}`);
  }
  assert.match(step('Checkout'), /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /ref: \$\{\{ needs\.prepare\.outputs\.source_sha \}\}/);
  assert.match(step('Upload isolated QA packages'), /retention-days: 7/);
});

test('QA artifact staging preserves complete package files, notes and frozen source metadata without unpacked duplication', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'nuwax-qa-stage-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  git('init', '-q');
  const shellSha = '1'.repeat(40), frontendSha = '2'.repeat(40);
  git('update-index', '--add', '--cacheinfo', `160000,${shellSha},nuwa-electron-shell`);
  git('update-index', '--add', '--cacheinfo', `160000,${frontendSha},nuwax`);
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'QA source fixture');
  const clientSha = git('rev-parse', 'HEAD');
  const out = path.join(directory, 'nuwa-electron-shell/crates/agent-electron-client/release/3.0.9');
  mkdirSync(path.join(out, 'unpacked'), { recursive: true });
  writeFileSync(path.join(out, 'Nuwax-3.0.9.AppImage'), 'package-bytes');
  writeFileSync(path.join(out, 'build-manifest-linux-x64.json'), '{"source":"fixture"}');
  writeFileSync(path.join(out, 'builder-debug.yml'), 'excluded-debug');
  writeFileSync(path.join(out, 'unpacked/runtime'), 'do-not-duplicate');
  mkdirSync(path.join(directory, 'release-notes'));
  writeFileSync(path.join(directory, 'release-notes/prerelease-v3.0.9.md'), 'Acceptance notes');
  const output = path.join(directory, 'stage-output');
  writeFileSync(output, '');
  const run = script('Stage isolated QA packages and build context')
    .replaceAll('${{ runner.os }}', 'Linux').replaceAll('${{ matrix.arch }}', 'x64');
  const result = spawnSync('bash', ['-c', run], { cwd: directory, encoding: 'utf8', env: { ...process.env,
    QA_VERSION: '3.0.9', QA_BUILD_IDENTITY: 'prerelease-v3.0.9', QA_SOURCE_SHA: clientSha,
    QA_EVENT: 'push', QA_REF: 'refs/heads/codex/beta-qa/3.0.9', QA_ARCHIVE: '',
    RUNNER_TEMP: directory, GITHUB_OUTPUT: output, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1',
  } });
  assert.equal(result.status, 0, result.stderr);
  const stage = path.join(directory, 'nuwax-qa-Linux-x64');
  assert.equal(readFileSync(path.join(stage, 'Nuwax-3.0.9.AppImage'), 'utf8'), 'package-bytes');
  assert.equal(readFileSync(path.join(stage, 'acceptance-notes.md'), 'utf8'), 'Acceptance notes');
  assert.ok(existsSync(path.join(stage, 'build-manifest-linux-x64.json')));
  assert.equal(existsSync(path.join(stage, 'unpacked')), false);
  assert.equal(existsSync(path.join(stage, 'builder-debug.yml')), false);
  const context = JSON.parse(readFileSync(path.join(stage, 'qa-build-context.json'), 'utf8'));
  assert.deepEqual(context.source, { client: clientSha, shell: shellSha, frontend: frontendSha });
  assert.equal(context.buildIdentity, 'prerelease-v3.0.9');
  assert.equal(context.tagCreated, false);
  assert.equal(context.published, false);
  assert.equal(context.updatePointersChanged, false);
});
