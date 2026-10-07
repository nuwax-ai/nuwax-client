import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
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
      VERSION_INPUT: '3.0.9-qa.20261008.1', WINDOWS_ARCHIVE_INPUT: 'zip-qa', GITHUB_OUTPUT: output, ...env },
    encoding: 'utf8',
  });
  const values = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  return { ...result, values, directory };
}

test('manual QA builds use separate full QA identities and select only allowed Windows archive policies', (t) => {
  for (const archive of ['7z', 'zip-qa']) {
    const result = resolveIdentity(t, { WINDOWS_ARCHIVE_INPUT: archive });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.values, { version: '3.0.9-qa.20261008.1', tag: 'qa-v3.0.9-qa.20261008.1', source_sha: sourceSha, windows_archive: archive, qa_build: 'true', native_version: '3.0.9' });
  }
});

test('QA branch push defaults to ZIP while public tag push preserves its original archive policy', (t) => {
  for (const [ref, archive, qa] of [['refs/heads/codex/beta-qa/3.0.9-qa.20261008.1', 'zip-qa', true], ['refs/tags/prerelease-v3.0.9', '', false]]) {
    const result = resolveIdentity(t, { BUILD_EVENT: 'push', BUILD_REF: ref });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.values.version, qa ? '3.0.9-qa.20261008.1' : '3.0.9');
    assert.equal(result.values.tag, qa ? 'qa-v3.0.9-qa.20261008.1' : 'prerelease-v3.0.9');
    assert.equal(result.values.windows_archive, archive);
    assert.equal(result.values.qa_build, String(qa));
    assert.equal(result.values.native_version, '3.0.9');
  }
});

test('strict QA date accepts a leap day and keeps a positive semver attempt', (t) => {
  const result = resolveIdentity(t, { VERSION_INPUT: '0.0.0-qa.20240229.2' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.values.version, '0.0.0-qa.20240229.2');
  assert.equal(result.values.tag, 'qa-v0.0.0-qa.20240229.2');
  assert.equal(result.values.native_version, '0.0.0');
  assert.equal(result.values.qa_build, 'true');
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
    ...['3.0.9', '03.0.9-qa.20261008.1', '3.0', '3.0.9-qa.1', '3.0.9-qa.2026108.1', '3.0.9-qa.20261008.01', '3.0.9-qa.20261008.0', '3.0.9-qa.20260230.1', '3.0.9-qa.20261308.1', '3.0.9-qa.20260229.1', '3.0.9-beta.20261008.1', '3.0.9-qa.20261008.1\nversion=9.9.9', '3.0.9-qa.20261008.1$(touch "$QA_SENTINEL")'].map((VERSION_INPUT) => ({ VERSION_INPUT })),
    { WINDOWS_ARCHIVE_INPUT: 'zip-qa$(touch "$QA_SENTINEL")' },
    { BUILD_EVENT: 'push', BUILD_REF: 'refs/heads/codex/beta-qa/nested/3.0.9' },
    { BUILD_EVENT: 'push', BUILD_REF: 'refs/heads/codex/beta-qa/3.0.9' },
    { BUILD_EVENT: 'push', BUILD_REF: 'refs/tags/prerelease-v3.0.9-qa.20261008.1' },
    { BUILD_EVENT: 'push', BUILD_REF: 'refs/tags/prerelease-v3.0.9-beta.1' },
    { BUILD_EVENT: 'push', BUILD_REF: 'refs/tags/prerelease-v3.0.9$(touch "$QA_SENTINEL")' },
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
    ['push', 'refs/heads/codex/beta-qa/3.0.9-qa.20261008.1', false],
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

test('QA native package fields remain numeric while the full app version and public defaults are preserved', async (t) => {
  const packages = [];
  for (const [version, qa] of [['3.0.9-qa.20261008.1', true], ['3.0.9', false]]) {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'nuwax-qa-native-version-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'fixture-client', version: '0.0.0', build: { extraResources: [{ from: 'fixture-node', to: 'node' }], mac: { extendInfo: {} }, win: {} } }));
    const run = script('Set version & commercial branding in package.json').replaceAll('${{ needs.prepare.outputs.version }}', version);
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', run], { cwd: directory, encoding: 'utf8', env: { ...process.env,
      QA_BUILD: String(qa), NATIVE_VERSION: '3.0.9', npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false',
    } });
    assert.equal(result.status, 0, result.stderr);
    const pkg = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
    assert.equal(pkg.version, version);
    assert.equal(pkg.build.buildVersion, qa ? '3.0.9' : undefined);
    assert.equal(pkg.build.mac.bundleShortVersion, qa ? '3.0.9' : undefined);
    assert.ok(pkg.build.extraResources.some((entry) => entry.to === 'node'), 'Unrelated complete resources must be retained');
    packages.push(pkg);
  }
  const require = createRequire(import.meta.url);
  let builderFile;
  try { builderFile = require.resolve('electron-builder/package.json', { paths: [path.join(root, 'nuwa-electron-shell/crates/agent-electron-client')] }); }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; t.diagnostic('Installed builder unavailable; native shell behavior passed, real schema contract not run'); return; }
  const builderRequire = createRequire(builderFile);
  assert.equal(builderRequire('./package.json').version, '25.1.8');
  builderRequire('app-builder-lib');
  const { AppInfo } = builderRequire('app-builder-lib/out/appInfo.js');
  const { validateConfiguration } = builderRequire('app-builder-lib/out/util/config/config.js');
  const pkg = packages[0];
  await validateConfiguration(pkg.build, { isEnabled: false });
  const info = new AppInfo({ metadata: pkg, config: pkg.build });
  assert.equal(info.version, '3.0.9-qa.20261008.1');
  assert.equal(info.buildVersion, '3.0.9');
  assert.equal(info.channel, 'qa');
  assert.equal(info.getVersionInWeirdWindowsForm(false), '3.0.9.0');
});

function runRecordStep(t, { qa, osName = 'Windows', missingCertificate = false, failedTool = '' }) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'nuwax-qa-record-command-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin'), calls = path.join(directory, 'calls');
  mkdirSync(bin);
  writeFileSync(calls, '');
  for (const command of ['node', 'codesign', 'spctl']) {
    writeFileSync(path.join(bin, command), '#!/bin/bash\nprintf "%s\\t" "$(basename "$0")" "$@" >> "$QA_CALLS"\nprintf "\\n" >> "$QA_CALLS"\n[ "$(basename "$0")" != "$QA_FAILED_TOOL" ]\n', { mode: 0o755 });
  }
  const version = qa === 'true' ? '3.0.9-qa.20261008.1' : '3.0.9';
  const identity = qa === 'true' ? `qa-v${version}` : `prerelease-v${version}`;
  const out = path.join(directory, 'nuwa-electron-shell/crates/agent-electron-client/release', version);
  mkdirSync(path.join(out, 'Nuwax.app'), { recursive: true });
  writeFileSync(path.join(out, 'Nuwax.dmg'), 'fake fixture only');
  const run = script('Record platform source and verify macOS signature').replaceAll('${{ runner.os }}', osName);
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', run], { cwd: directory, encoding: 'utf8', env: { ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`, QA_BUILD: qa, BUILD_IDENTITY: identity, TARGET_ARCH: 'x64', BUILD_VERSION: version,
    QA_CALLS: calls, QA_FAILED_TOOL: failedTool, APPLE_CERTIFICATE: missingCertificate ? '' : 'fixture', APPLE_SIGNING_IDENTITY: 'fixture',
    APPLE_API_KEY: 'fixture', APPLE_API_KEY_ID: 'fixture', APPLE_ISSUER_ID: 'fixture',
  } });
  return { ...result, calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((line) => line.split('\t')), identity, version };
}

test('record commands isolate full QA identity from public provenance and reject invalid modes', (t) => {
  for (const qa of ['true', 'false']) {
    const result = runRecordStep(t, { qa });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls.length, 1);
    assert.deepEqual(result.calls[0].slice(0, 6), ['node', 'scripts/release-provenance.mjs', qa === 'true' ? 'record-qa' : 'record', result.identity, 'windows', 'x64']);
    assert.equal(result.calls[0][6], `nuwa-electron-shell/crates/agent-electron-client/release/${result.version}`);
  }
  const rejected = runRecordStep(t, { qa: 'unexpected' });
  assert.notEqual(rejected.status, 0);
  assert.deepEqual(rejected.calls, []);
  assert.match(workflow, /qa_build: \$\{\{ steps\.version\.outputs\.qa_build \}\}/);
  assert.match(step('Record platform source and verify macOS signature'), /QA_BUILD: \$\{\{ needs\.prepare\.outputs\.qa_build \}\}/);
});

test('artifact-only QA retains the full macOS secret and signature gates before recording', (t) => {
  for (const qa of ['true', 'false']) {
    const passed = runRecordStep(t, { qa, osName: 'macOS' });
    assert.equal(passed.status, 0, passed.stderr);
    assert.deepEqual(passed.calls.map((call) => call[0]), ['codesign', 'spctl', 'node']);
    assert.equal(passed.calls[2][2], qa === 'true' ? 'record-qa' : 'record');
    const missing = runRecordStep(t, { qa, osName: 'macOS', missingCertificate: true });
    assert.notEqual(missing.status, 0);
    assert.deepEqual(missing.calls, []);
    const failed = runRecordStep(t, { qa, osName: 'macOS', failedTool: 'codesign' });
    assert.notEqual(failed.status, 0);
    assert.deepEqual(failed.calls.map((call) => call[0]), ['codesign']);
  }
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
  const version = '3.0.9-qa.20261008.1';
  const out = path.join(directory, `nuwa-electron-shell/crates/agent-electron-client/release/${version}`);
  mkdirSync(path.join(out, 'unpacked'), { recursive: true });
  writeFileSync(path.join(out, `Nuwax-${version}.AppImage`), 'package-bytes');
  writeFileSync(path.join(out, 'build-manifest-linux-x64.json'), '{"source":"fixture"}');
  writeFileSync(path.join(out, 'builder-debug.yml'), 'excluded-debug');
  writeFileSync(path.join(out, 'unpacked/runtime'), 'do-not-duplicate');
  mkdirSync(path.join(directory, 'release-notes'));
  writeFileSync(path.join(directory, `release-notes/qa-v${version}.md`), 'Acceptance notes');
  const output = path.join(directory, 'stage-output');
  writeFileSync(output, '');
  const run = script('Stage isolated QA packages and build context')
    .replaceAll('${{ runner.os }}', 'Linux').replaceAll('${{ matrix.arch }}', 'x64');
  const result = spawnSync('bash', ['-c', run], { cwd: directory, encoding: 'utf8', env: { ...process.env,
    QA_VERSION: version, QA_BUILD_IDENTITY: `qa-v${version}`, QA_SOURCE_SHA: clientSha,
    QA_EVENT: 'push', QA_REF: `refs/heads/codex/beta-qa/${version}`, QA_ARCHIVE: '',
    RUNNER_TEMP: directory, GITHUB_OUTPUT: output, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1',
  } });
  assert.equal(result.status, 0, result.stderr);
  const stage = path.join(directory, 'nuwax-qa-Linux-x64');
  assert.equal(readFileSync(path.join(stage, `Nuwax-${version}.AppImage`), 'utf8'), 'package-bytes');
  assert.equal(readFileSync(path.join(stage, 'acceptance-notes.md'), 'utf8'), 'Acceptance notes');
  assert.ok(existsSync(path.join(stage, 'build-manifest-linux-x64.json')));
  assert.equal(existsSync(path.join(stage, 'unpacked')), false);
  assert.equal(existsSync(path.join(stage, 'builder-debug.yml')), false);
  const context = JSON.parse(readFileSync(path.join(stage, 'qa-build-context.json'), 'utf8'));
  assert.deepEqual(context.source, { client: clientSha, shell: shellSha, frontend: frontendSha });
  assert.equal(context.buildIdentity, `qa-v${version}`);
  assert.equal(context.tagCreated, false);
  assert.equal(context.published, false);
  assert.equal(context.updatePointersChanged, false);
});
