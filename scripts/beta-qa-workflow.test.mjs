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

function installedBuilder(t) {
  // Default to this checkout's client dependencies. An isolated checkout without
  // submodules can explicitly reuse another client's installed dependencies read-only.
  const override = process.env.NUWAX_TEST_BUILDER_CLIENT_DIR;
  if (override) assert.ok(path.isAbsolute(override), 'NUWAX_TEST_BUILDER_CLIENT_DIR must be an absolute client directory');
  const client = override ?? path.join(root, 'nuwa-electron-shell/crates/agent-electron-client');
  const require = createRequire(import.meta.url);
  let builderFile;
  try { builderFile = require.resolve('electron-builder/package.json', { paths: [client] }); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    if (override) assert.fail(`Pinned builder dependencies unavailable in ${client}`);
    t.diagnostic('Installed builder unavailable; real builder contract not run');
    return null;
  }
  const builderRequire = createRequire(builderFile);
  assert.equal(builderRequire('./package.json').version, '25.1.8');
  builderRequire('app-builder-lib');
  return builderRequire;
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
  for (const [ref, archive, qa] of [['refs/heads/codex/beta-qa/3.0.9-qa.20261008.1', 'zip-qa', true], ['refs/tags/v3.0.9-beta.1', '', false]]) {
    const result = resolveIdentity(t, { BUILD_EVENT: 'push', BUILD_REF: ref });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.values.version, qa ? '3.0.9-qa.20261008.1' : '3.0.9-beta.1');
    assert.equal(result.values.tag, qa ? 'qa-v3.0.9-qa.20261008.1' : 'v3.0.9-beta.1');
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
    { BUILD_EVENT: 'push', BUILD_REF: 'refs/tags/v3.0.9-beta.1-qa.20261008.1' },
    { BUILD_EVENT: 'push', BUILD_REF: 'refs/tags/v3.0.9-beta.0' },
    { BUILD_EVENT: 'push', BUILD_REF: 'refs/tags/v3.0.9-beta.1$(touch "$QA_SENTINEL")' },
    { BUILD_EVENT: 'push', BUILD_REF: 'refs/heads/main' },
    { BUILD_REF: 'refs/tags/v3.0.9-beta.1' },
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
    ['push', 'refs/tags/v3.0.9-beta.1', true],
    ['push', 'refs/heads/codex/beta-qa/3.0.9-qa.20261008.1', false],
    ['workflow_dispatch', 'refs/heads/codex/client-qa', false],
    ['workflow_dispatch', 'refs/tags/v3.0.9-beta.1', false],
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
  for (const [version, qa, arch] of [['3.0.9-qa.20261008.1', true, 'x64'], ['3.0.9-qa.20261008.2', true, 'arm64'], ['3.0.9', false, 'x64']]) {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'nuwax-qa-native-version-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'fixture-client', version: '0.0.0', build: { extraResources: [{ from: 'fixture-node', to: 'node' }], mac: { extendInfo: {} }, win: {} } }));
    const run = script('Set version & commercial branding in package.json').replaceAll('${{ needs.prepare.outputs.version }}', version);
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', run], { cwd: directory, encoding: 'utf8', env: { ...process.env,
      QA_BUILD: String(qa), NATIVE_VERSION: '3.0.9', TARGET_ARCH: arch, npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false',
    } });
    assert.equal(result.status, 0, result.stderr);
    const pkg = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
    assert.equal(pkg.version, version);
    assert.equal(pkg.build.buildVersion, qa ? '3.0.9' : undefined);
    assert.equal(pkg.build.mac.bundleShortVersion, qa ? '3.0.9' : undefined);
    assert.equal(pkg.build.dmg?.artifactName, qa ? '${productName}-${version}' + (arch === 'arm64' ? '-arm64' : '') + '.${ext}' : undefined);
    assert.ok(pkg.build.extraResources.some((entry) => entry.to === 'node'), 'Unrelated complete resources must be retained');
    packages.push(pkg);
  }
  const builderRequire = installedBuilder(t);
  if (!builderRequire) return;
  const { AppInfo } = builderRequire('app-builder-lib/out/appInfo.js');
  const { validateConfiguration } = builderRequire('app-builder-lib/out/util/config/config.js');
  const pkg = packages[0];
  await validateConfiguration(pkg.build, { isEnabled: false });
  const info = new AppInfo({ metadata: pkg, config: pkg.build });
  assert.equal(info.version, '3.0.9-qa.20261008.1');
  assert.equal(info.buildVersion, '3.0.9');
  assert.equal(info.channel, 'qa');
  assert.equal(info.getVersionInWeirdWindowsForm(false), '3.0.9.0');
  const { PlatformPackager } = builderRequire('app-builder-lib/out/platformPackager.js');
  const { Arch } = builderRequire('builder-util');
  for (const [i, arch, name] of [[0, Arch.x64, 'Nuwax-3.0.9-qa.20261008.1.dmg'], [1, Arch.arm64, 'Nuwax-3.0.9-qa.20261008.2-arm64.dmg']]) {
    const qaPkg = packages[i];
    const packager = new PlatformPackager({ metadata: { ...qaPkg, name: 'nuwax', productName: 'Nuwax' }, config: { ...qaPkg.build, productName: 'Nuwax' } }, { buildConfigurationKey: 'mac' });
    const outputName = packager.expandArtifactNamePattern(qaPkg.build.dmg, 'dmg', arch, '${productName}-' + qaPkg.build.mac.bundleShortVersion + '-${arch}.${ext}', true);
    assert.equal(outputName, name, 'Real builder DMG naming must use full QA version despite numeric bundleShortVersion');
  }
});

test('public Beta keeps numeric Mac bundle versions and full DMG identity in the pinned builder', async (t) => {
  const builderRequire = installedBuilder(t);
  if (!builderRequire) { t.skip('Requires installed electron-builder 25.1.8'); return; }
  const { AppInfo } = builderRequire('app-builder-lib/out/appInfo.js');
  const { MacPackager } = builderRequire('app-builder-lib/out/macPackager.js');
  const { PlatformPackager } = builderRequire('app-builder-lib/out/platformPackager.js');
  const { validateConfiguration } = builderRequire('app-builder-lib/out/util/config/config.js');
  const { Arch } = builderRequire('builder-util');
  for (const version of ['3.0.11-beta.1', '3.0.11-beta.10']) {
    for (const arch of ['x64', 'arm64']) {
      await t.test(`${version} ${arch}`, async (t) => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'nuwax-beta-native-version-'));
        t.after(() => rmSync(directory, { recursive: true, force: true }));
        writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'fixture-client', version: '0.0.0',
          build: { extraResources: [{ from: 'complete-resource', to: 'node' }], mac: { extendInfo: {} }, win: {} } }));
        const run = script('Set version & commercial branding in package.json').replaceAll('${{ needs.prepare.outputs.version }}', version);
        const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', run], { cwd: directory, encoding: 'utf8', env: { ...process.env,
          QA_BUILD: 'false', NATIVE_VERSION: '3.0.11', TARGET_ARCH: arch, npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false',
        } });
        assert.equal(result.status, 0, result.stderr);
        const pkg = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
        assert.equal(pkg.version, version, 'Application/ASAR version must keep the complete Beta identity');
        assert.ok(pkg.build.extraResources.some((entry) => entry.to === 'node'), 'Complete integrated resources must remain present');
        await validateConfiguration(pkg.build, { isEnabled: false });
        const appInfo = new AppInfo({ metadata: pkg, config: pkg.build });
        assert.equal(appInfo.version, version);
        assert.equal(appInfo.channel, 'beta');
        const plist = {};
        await MacPackager.prototype.applyCommonInfo.call({ appInfo, getIconPath: async () => null,
          platformSpecificBuildOptions: pkg.build.mac, config: pkg.build }, plist, '/unused-fixture');
        assert.equal(plist.CFBundleShortVersionString, '3.0.11', 'Mac marketing version must use the numeric native version');
        assert.equal(plist.CFBundleVersion, '3.0.11', 'Mac build version must use the numeric native version');
        const packager = new PlatformPackager({ metadata: pkg, config: pkg.build }, { buildConfigurationKey: 'mac' });
        const outputName = packager.expandArtifactNamePattern(pkg.build.dmg, 'dmg', arch === 'arm64' ? Arch.arm64 : Arch.x64,
          '${productName}-' + pkg.build.mac.bundleShortVersion + '-${arch}.${ext}', true);
        assert.equal(outputName, `Nuwax-${version}${arch === 'arm64' ? '-arm64' : ''}.dmg`, 'Numeric native versions must not shorten or collide public Beta artifact names');
      });
    }
  }
});

test('Windows short output covers public Beta and QA while preserving full identity and resources', (t) => {
  const block = step('Configure short output directory for Windows');
  const expression = /^\s+if: (.+)$/m.exec(block)[1];
  const applies = Function('runner', 'needs', `return (${expression});`);
  for (const [osName, qa, expected] of [['Windows', 'true', true], ['Windows', 'false', true], ['macOS', 'true', false], ['Linux', 'true', false]]) {
    assert.equal(applies({ os: osName }, { prepare: { outputs: { qa_build: qa } } }), expected);
  }
  const directory = mkdtempSync(path.join(os.tmpdir(), 'nuwax-qa-short-output-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const initial = { version: '3.0.9-qa.20261008.2', build: { directories: { output: 'release/${version}', buildResources: 'build' }, extraResources: [{ from: 'complete-resource', to: 'node' }] } };
  const clientDirectory = path.join(directory, 'nuwa-electron-shell/crates/agent-electron-client');
  mkdirSync(clientDirectory, { recursive: true });
  const packagePath = path.join(clientDirectory, 'package.json'), envPath = path.join(directory, 'github-env');
  const run = (env) => {
    writeFileSync(packagePath, JSON.stringify(initial));
    writeFileSync(envPath, '');
    return spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script('Configure short output directory for Windows').replace('node scripts/configure-windows-output.mjs', `node "${path.join(root, 'scripts/configure-windows-output.mjs')}"`)], { cwd: directory, encoding: 'utf8', env: { ...process.env, GITHUB_ENV: envPath, RUNNER_TEMP: 'D:\\a\\_temp', GITHUB_RUN_ID: '37666382509', GITHUB_RUN_ATTEMPT: '2', TARGET_ARCH: 'x64', ...env } });
  };
  const result = run({});
  assert.equal(result.status, 0, result.stderr);
  const output = 'D:/a/_temp/nw-37666382509-2-x64';
  assert.deepEqual(JSON.parse(readFileSync(packagePath, 'utf8')), { ...initial, build: { ...initial.build, directories: { ...initial.build.directories, output } } });
  assert.equal(readFileSync(envPath, 'utf8'), `NUWAX_WINDOWS_OUTPUT_DIR=${output}\n`);
  for (const env of [{ RUNNER_TEMP: 'relative-path' }, { RUNNER_TEMP: 'D:\\temp\nOTHER=1' }, { GITHUB_RUN_ID: '../escape' }, { GITHUB_RUN_ATTEMPT: '0' }]) {
    const rejected = run(env);
    assert.notEqual(rejected.status, 0);
    assert.deepEqual(JSON.parse(readFileSync(packagePath, 'utf8')), initial);
    assert.equal(readFileSync(envPath, 'utf8'), '');
  }
  assert.match(script('Stage isolated QA packages and build context'), /OUT_DIR="\$NUWAX_WINDOWS_OUTPUT_DIR"/);
  assert.match(script('Upload artifacts to Release'), /OUT_DIR="\$NUWAX_WINDOWS_OUTPUT_DIR"/);
});

function runRecordStep(t, { qa, osName = 'Windows', missingCertificate = false, missingNotificationModule = false, failedTool = '', shortOutput = 'D:/a/_temp/nq-123-1' }) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'nuwax-qa-record-command-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin'), calls = path.join(directory, 'calls');
  mkdirSync(bin);
  writeFileSync(calls, '');
  for (const command of ['node', 'codesign', 'spctl', 'lipo']) {
    const lipoArguments = command === 'lipo' ? '[ "$#" = 4 ] && [[ "$1" == *.node ]] && [ "$2" = -verify_arch ] && [ "$3" = arm64 ] && [ "$4" = x86_64 ] || exit 64\n' : '';
    writeFileSync(path.join(bin, command), '#!/bin/bash\nprintf "%s\\t" "$(basename "$0")" "$@" >> "$QA_CALLS"\nprintf "\\n" >> "$QA_CALLS"\n' + lipoArguments + '[ "$(basename "$0")" != "$QA_FAILED_TOOL" ]\n', { mode: 0o755 });
  }
  const version = qa === 'true' ? '3.0.9-qa.20261008.1' : '3.0.9';
  const identity = qa === 'true' ? `qa-v${version}` : `prerelease-v${version}`;
  const out = path.join(directory, 'nuwa-electron-shell/crates/agent-electron-client/release', version);
  mkdirSync(path.join(out, 'Nuwax.app'), { recursive: true });
  if (!missingNotificationModule) {
    const modulePath = path.join(out, 'Nuwax.app/Contents/Resources/app.asar.unpacked/dist/main/mac-notification-permission.node');
    mkdirSync(path.dirname(modulePath), { recursive: true });
    writeFileSync(modulePath, 'native module fixture only');
  }
  writeFileSync(path.join(out, 'Nuwax.dmg'), 'fake fixture only');
  const run = script('Record platform source and verify macOS signature').replaceAll('${{ runner.os }}', osName);
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', run], { cwd: directory, encoding: 'utf8', env: { ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`, QA_BUILD: qa, BUILD_IDENTITY: identity, TARGET_ARCH: 'x64', BUILD_VERSION: version,
    QA_CALLS: calls, QA_FAILED_TOOL: failedTool, APPLE_CERTIFICATE: missingCertificate ? '' : 'fixture', APPLE_SIGNING_IDENTITY: 'fixture',
    APPLE_API_KEY: 'fixture', APPLE_API_KEY_ID: 'fixture', APPLE_ISSUER_ID: 'fixture',
    NUWAX_WINDOWS_OUTPUT_DIR: shortOutput,
  } });
  return { ...result, calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((line) => line.split('\t')), identity, version };
}

test('record commands isolate full QA identity from public provenance and reject invalid modes', (t) => {
  for (const qa of ['true', 'false']) {
    const result = runRecordStep(t, { qa });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls.length, 1);
    assert.deepEqual(result.calls[0].slice(0, 6), ['node', 'scripts/release-provenance.mjs', qa === 'true' ? 'record-qa' : 'record', result.identity, 'windows', 'x64']);
    assert.equal(result.calls[0][6], 'D:/a/_temp/nq-123-1');
  }
  const rejected = runRecordStep(t, { qa: 'unexpected' });
  assert.notEqual(rejected.status, 0);
  const missing = runRecordStep(t, { qa: 'true', shortOutput: '' });
  assert.notEqual(missing.status, 0);
  assert.equal(missing.calls.length, 0);
  assert.deepEqual(rejected.calls, []);
  assert.match(workflow, /qa_build: \$\{\{ steps\.version\.outputs\.qa_build \}\}/);
  assert.match(step('Record platform source and verify macOS signature'), /QA_BUILD: \$\{\{ needs\.prepare\.outputs\.qa_build \}\}/);
});

test('artifact-only QA retains the full macOS secret and signature gates before recording', (t) => {
  for (const qa of ['true', 'false']) {
    const passed = runRecordStep(t, { qa, osName: 'macOS' });
    assert.equal(passed.status, 0, passed.stderr);
    assert.deepEqual(passed.calls.map((call) => call[0]), ['lipo', 'codesign', 'codesign', 'spctl', 'node']);
    assert.deepEqual(passed.calls[0].slice(2, 5), ['-verify_arch', 'arm64', 'x86_64']);
    assert.match(passed.calls[1][3], /app\.asar\.unpacked\/dist\/main\/mac-notification-permission\.node$/);
    assert.equal(passed.calls[4][2], qa === 'true' ? 'record-qa' : 'record');
    const missing = runRecordStep(t, { qa, osName: 'macOS', missingCertificate: true });
    assert.notEqual(missing.status, 0);
    assert.deepEqual(missing.calls, []);
    const failed = runRecordStep(t, { qa, osName: 'macOS', failedTool: 'codesign' });
    assert.notEqual(failed.status, 0);
    assert.deepEqual(failed.calls.map((call) => call[0]), ['lipo', 'codesign']);
    const missingModule = runRecordStep(t, { qa, osName: 'macOS', missingNotificationModule: true });
    assert.notEqual(missingModule.status, 0);
    assert.deepEqual(missingModule.calls, []);
    const wrongArch = runRecordStep(t, { qa, osName: 'macOS', failedTool: 'lipo' });
    assert.notEqual(wrongArch.status, 0);
    assert.deepEqual(wrongArch.calls.map((call) => call[0]), ['lipo']);
  }
});

test('macOS notification architecture gate executes real lipo and rejects a missing slice', { skip: process.platform !== 'darwin' }, (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'nuwax native architecture '));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'fixture.c');
  writeFileSync(source, 'int notification_fixture(void) { return 0; }\n');
  const slices = ['arm64', 'x86_64'].map((arch) => {
    const output = path.join(directory, `${arch}.o`);
    execFileSync('xcrun', ['--sdk', 'macosx', 'clang', '-arch', arch, '-c', source, '-o', output]);
    return output;
  });
  const universal = path.join(directory, 'notification.node');
  execFileSync('xcrun', ['lipo', '-create', ...slices, '-output', universal]);
  const command = script('Record platform source and verify macOS signature').split('\n').find(line => /^\s*lipo /.test(line));
  assert.ok(command, 'Missing production architecture gate');
  const verify = (file) => spawnSync('bash', ['-e', '-u', '-c', command], {
    env: { ...process.env, NOTIFICATION_MODULE: file }, encoding: 'utf8',
  });
  const passed = verify(universal);
  assert.equal(passed.status, 0, passed.stderr);
  assert.notEqual(verify(slices[0]).status, 0);
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
  const shortOut = path.join(directory, 'short-output');
  mkdirSync(shortOut);
  writeFileSync(path.join(shortOut, `Nuwax-${version}.exe`), 'complete-windows-package-bytes');
  for (const [osName, shortOutput] of [['Linux', ''], ['Windows', shortOut], ['Windows', '']]) {
    const run = script('Stage isolated QA packages and build context')
      .replaceAll('${{ runner.os }}', osName).replaceAll('${{ matrix.arch }}', 'x64');
    const runnerTemp = path.join(directory, `runner-${osName}-${shortOutput ? 'valid' : 'missing'}`);
    mkdirSync(runnerTemp);
    const result = spawnSync('bash', ['-c', run], { cwd: directory, encoding: 'utf8', env: { ...process.env,
      QA_VERSION: version, QA_BUILD_IDENTITY: `qa-v${version}`, QA_SOURCE_SHA: clientSha, QA_PLATFORM: osName,
      QA_EVENT: 'push', QA_REF: `refs/heads/codex/beta-qa/${version}`, QA_ARCHIVE: osName === 'Windows' ? 'zip-qa' : '',
      NUWAX_WINDOWS_OUTPUT_DIR: shortOutput, RUNNER_TEMP: runnerTemp, GITHUB_OUTPUT: output,
      GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1',
    } });
    const stage = path.join(runnerTemp, `nuwax-qa-${osName}-x64`);
    if (osName === 'Windows' && !shortOutput) {
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(stage), false);
      continue;
    }
    assert.equal(result.status, 0, result.stderr);
    if (osName === 'Windows') {
      assert.equal(readFileSync(path.join(stage, `Nuwax-${version}.exe`), 'utf8'), 'complete-windows-package-bytes');
      assert.equal(existsSync(path.join(stage, `Nuwax-${version}.AppImage`)), false, 'Stale default output must not be collected');
    } else {
      assert.equal(readFileSync(path.join(stage, `Nuwax-${version}.AppImage`), 'utf8'), 'package-bytes');
      assert.ok(existsSync(path.join(stage, 'build-manifest-linux-x64.json')));
    }
    assert.equal(readFileSync(path.join(stage, 'acceptance-notes.md'), 'utf8'), 'Acceptance notes');
    assert.equal(existsSync(path.join(stage, 'unpacked')), false);
    assert.equal(existsSync(path.join(stage, 'builder-debug.yml')), false);
    const context = JSON.parse(readFileSync(path.join(stage, 'qa-build-context.json'), 'utf8'));
    assert.deepEqual(context.source, { client: clientSha, shell: shellSha, frontend: frontendSha });
    assert.equal(context.buildIdentity, `qa-v${version}`);
    assert.equal(context.tagCreated, false);
    assert.equal(context.published, false);
    assert.equal(context.updatePointersChanged, false);
  }
});

test('Beta Mac build commands override maximum with the stable compression level in both SDK archive paths', (t) => {
  const builderRequire = installedBuilder(t);
  if (!builderRequire) { t.skip('Requires installed electron-builder 25.1.8'); return; }
  const { compute7zCompressArgs, computeZipCompressArgs } = builderRequire('app-builder-lib/out/targets/archive.js');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'nuwax-mac-archive-level-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin'), capture = path.join(directory, 'level');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'npm'), '#!/bin/bash\nprintf "%s" "${ELECTRON_BUILDER_COMPRESSION_LEVEL-unset}" > "$ARCHIVE_LEVEL_CAPTURE"\n', { mode: 0o755 });
  const initialLevel = process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL;
  try {
    delete process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL;
    assert.ok(compute7zCompressArgs('zip', { compression: 'maximum' }).includes('-mx=9'));
    assert.ok(computeZipCompressArgs({ compression: 'maximum' }).includes('-9'));
    for (const [osName, arch] of [['macOS', 'arm64'], ['macOS', 'x64'], ['Windows', 'x64'], ['Linux', 'arm64']]) {
      const run = script('Build Electron app').replaceAll('${{ runner.os }}', osName)
        .replaceAll('${{ matrix.arch }}', arch).replaceAll('${{ matrix.dist_cmd }}', `dist:mac:${arch}`)
        .replaceAll("${{ secrets.APPLE_CERTIFICATE || '' }}", 'fixture').replaceAll('${{ secrets.APPLE_SIGNING_IDENTITY }}', 'fixture');
      const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ARCHIVE_LEVEL_CAPTURE: capture };
      delete env.ELECTRON_BUILDER_COMPRESSION_LEVEL;
      const result = spawnSync('bash', ['-e', '-u', '-o', 'pipefail', '-c', run], { cwd: directory, env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const level = readFileSync(capture, 'utf8');
      assert.equal(level, osName === 'macOS' ? '1' : 'unset');
      if (osName === 'macOS') {
        process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL = level;
        assert.ok(compute7zCompressArgs('zip', { compression: 'maximum' }).includes('-mx=1'));
        assert.ok(computeZipCompressArgs({ compression: 'maximum' }).includes('-1'));
        delete process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL;
      }
    }
  } finally {
    if (initialLevel === undefined) delete process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL;
    else process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL = initialLevel;
  }
});
