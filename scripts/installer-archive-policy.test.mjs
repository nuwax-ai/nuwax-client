import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import policy from '../overlay/crates/agent-electron-client/scripts/build/installer-archive-policy.cjs';
import { builderConfig, pack } from './client/pack.mjs';
import * as core from './client/core.mjs';

const { ENV_KEY, applyInstallerArchivePolicy, installerArchiveCliArgs, resolveBuilderPlatform, installedBuilderVersions } = policy;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = core.paths(root).client;
const pkg = JSON.parse(fs.readFileSync(path.join(client, 'package.json'), 'utf8'));
const enabled = { [ENV_KEY]: 'zip-qa' };
const versions = { electronBuilder: '25.1.8', appBuilderLib: '25.1.8' };
const zipOptions = { env: enabled, platform: 'win32', builderVersions: versions };
const configOptions = { frontendDist: '/fixture/frontend', helperDir: '/fixture/computer-use', output: '/fixture/release', version: '3.0.9-beta.1' };
const wrapperPath = path.join(root, 'overlay/crates/agent-electron-client/scripts/build/run-build-electron.js');
const wrapperSource = fs.readFileSync(wrapperPath, 'utf8');
const require = createRequire(import.meta.url);

function temporaryClient(t, build = pkg.build, versionOverrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-archive-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.0.0', build }));
  for (const [name, version] of Object.entries({ 'electron-builder': '25.1.8', 'app-builder-lib': '25.1.8', ...versionOverrides })) {
    const moduleDir = path.join(dir, 'node_modules', name);
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(path.join(moduleDir, 'package.json'), JSON.stringify({ name, version }));
  }
  return dir;
}

function runLegacy(projectRoot, argv, env = {}, platform = 'darwin') {
  const commands = [];
  const module = { exports: {} };
  const mockRequire = (name) => {
    if (name === 'child_process') return { execSync: (command, options) => commands.push({ command, options }) };
    if (name === '../utils/project-paths') return { getProjectRoot: () => projectRoot };
    if (name === './installer-archive-policy.cjs') return policy;
    return require(name);
  };
  mockRequire.main = module;
  try {
    vm.runInNewContext(wrapperSource, { module, require: mockRequire, process: { argv: ['node', wrapperPath, ...argv], env, platform, arch: 'arm64' }, console: { log() {} } }, { filename: wrapperPath });
  } catch (error) {
    error.commands = commands;
    throw error;
  }
  return commands;
}

test('unset and empty modes preserve the complete configuration and need no installed-version lookup', () => {
  for (const env of [{}, { [ENV_KEY]: '' }]) {
    const config = structuredClone(pkg.build);
    const before = structuredClone(config);
    assert.equal(applyInstallerArchivePolicy(config, { env, platform: 'linux' }), config);
    assert.deepEqual(config, before);
    assert.deepEqual(installerArchiveCliArgs(config, { env, platform: 'mixed' }), []);
  }
});

test('zip-qa changes exactly the paired archive options, preserving resources, targets and signing/publishing fields', () => {
  const config = { ...structuredClone(pkg.build), afterSign: 'fixture-after-sign.js', publish: { provider: 'generic', url: 'https://example.invalid/releases' }, win: { ...pkg.build.win, certificateSha1: 'fixture-certificate' } };
  const before = structuredClone(config);
  const result = applyInstallerArchivePolicy(config, zipOptions);
  assert.deepEqual(config, before);
  assert.deepEqual(result, { ...before, nsis: { ...before.nsis, differentialPackage: false, useZip: true } });
  assert.equal(result.extraResources, config.extraResources);
  assert.equal(result.win, config.win);
  assert.equal(result.afterSign, config.afterSign);
  assert.equal(result.publish, config.publish);
});

test('unknown archive modes are refused rather than silently falling back', () => {
  for (const mode of ['zip', '7z', 'zip-QA', ' zip-qa ', ' ']) {
    assert.throws(() => applyInstallerArchivePolicy({}, { ...zipOptions, env: { [ENV_KEY]: mode } }), /Unknown/);
  }
});

test('zip-qa cannot apply to macOS, Linux or mixed targets', () => {
  for (const platform of ['darwin', 'linux', 'mixed', undefined]) {
    assert.throws(() => applyInstallerArchivePolicy({}, { ...zipOptions, platform }), /exclusive Windows/);
  }
});

test('legacy target detection covers builder aliases, combined flags and native fallback', () => {
  for (const argv of [['--win'], ['--windows=nsis'], ['-w'], ['--win', 'nsis', '--x64']]) assert.equal(resolveBuilderPlatform(argv, 'darwin'), 'win32');
  for (const argv of [['--macos'], ['-o'], ['--mac=dmg']]) assert.equal(resolveBuilderPlatform(argv, 'win32'), 'darwin');
  assert.equal(resolveBuilderPlatform(['-mwl'], 'win32'), 'mixed');
  assert.equal(resolveBuilderPlatform(['--win', '--linux'], 'win32'), 'mixed');
  assert.equal(resolveBuilderPlatform(['--x64'], 'win32'), 'win32');
});

test('both actually installed builder packages must be exactly the audited version', (t) => {
  const dir = temporaryClient(t);
  assert.deepEqual(installedBuilderVersions(dir), versions);
  for (const builderVersions of [undefined, {}, { ...versions, electronBuilder: '25.1.9' }, { ...versions, appBuilderLib: '26.0.0' }]) {
    assert.throws(() => applyInstallerArchivePolicy({}, { ...zipOptions, builderVersions }), /installed.*25\.1\.8/);
  }
});

test('compatible configured halves are paired, but explicit opposite or nonboolean values are rejected', () => {
  for (const nsis of [{}, { useZip: true }, { differentialPackage: false }, { useZip: true, differentialPackage: false }]) {
    assert.deepEqual(applyInstallerArchivePolicy({ nsis }, zipOptions).nsis, { ...nsis, differentialPackage: false, useZip: true });
  }
  for (const nsis of [{ useZip: false }, { differentialPackage: true }, { useZip: 'true' }, { differentialPackage: 'false' }]) assert.throws(() => applyInstallerArchivePolicy({ nsis }, zipOptions), /Conflicting configured/);
});

test('ZIP policy owns the unique archive CLI pair and rejects callers supplying either field', () => {
  for (const argv of [['--config.nsis.useZip=true'], ['-c.nsis.differentialPackage', 'false'], ['--config.nsis.useZip'], ['--no-config.nsis.differentialPackage']]) {
    assert.throws(() => installerArchiveCliArgs({}, { ...zipOptions, argv: [...argv, '--publish', 'never'] }), /archive CLI|owns|nsis/);
  }
});

test('ZIP legacy publishing requires explicit never and refuses every conflicting supplied value', () => {
  for (const argv of [['--publish', 'never'], ['--publish=never'], ['-p', 'never'], ['-p=never']]) {
    assert.deepEqual(installerArchiveCliArgs({}, { ...zipOptions, argv }), ['--config.nsis.differentialPackage=false', '--config.nsis.useZip=true']);
  }
  for (const argv of [[], ['--publish'], ['--publish', 'always'], ['--publish=onTag'], ['-p', 'onTagOrDraft'], ['-p=always'], ['-pnever'], ['--no-publish'], ['--publish=always', '--publish=never'], ['-p=never', '--publish=always'], ['-p=never', '--publish', 'never']]) {
    assert.throws(() => installerArchiveCliArgs({}, { ...zipOptions, argv }), /publish|short/);
  }
});

test('conflicting CLI booleans and opaque config overrides fail safely', () => {
  for (const argv of [['--config.nsis.useZip=false'], ['-c.nsis.differentialPackage=true'], ['--config.nsis.differentialPackage'], ['--no-config.nsis.useZip'], ['--config', 'other.json'], ['-c=other.json'], ['--config.nsis={useZip:false}']]) {
    assert.throws(() => installerArchiveCliArgs({}, { ...zipOptions, argv }), /archive CLI|external config|whole nsis/);
  }
});

test('local builderConfig keeps its full existing behavior, and ZIP only adds the two NSIS fields', () => {
  const before = structuredClone(pkg);
  const defaultConfig = builderConfig(pkg, { ...configOptions, env: {}, platform: 'win32' });
  const emptyConfig = builderConfig(pkg, { ...configOptions, env: { [ENV_KEY]: '' }, platform: 'win32' });
  const zipConfig = builderConfig(pkg, { ...configOptions, ...zipOptions });
  assert.deepEqual(defaultConfig, emptyConfig);
  assert.deepEqual(zipConfig, { ...defaultConfig, nsis: { ...defaultConfig.nsis, differentialPackage: false, useZip: true } });
  assert.deepEqual(pkg, before);
  assert.deepEqual(zipConfig.extraResources, defaultConfig.extraResources);
  assert.deepEqual(zipConfig.win.extraResources, defaultConfig.win.extraResources);
});

test('legacy default command, prepare arch, and complete config forwarding remain unchanged', (t) => {
  const dir = temporaryClient(t);
  const argv = ['--win', '--x64', '--publish', 'never', '--config.nsis.shortcutName="女娲Nuwax"'];
  for (const env of [{}, { [ENV_KEY]: '' }]) {
    const commands = runLegacy(dir, argv, env);
    assert.equal(commands.length, 2);
    assert.equal(commands[0].command, 'npm run prepare:all');
    assert.equal(commands[0].options.env.TARGET_ARCH, 'x64');
    assert.equal(commands[1].command, `npx electron-builder --config.compression=maximum ${argv.join(' ')}`);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).build, pkg.build);
});

test('legacy explicit ZIP forwards only the paired options, including a native Windows default target', (t) => {
  const dir = temporaryClient(t);
  for (const argv of [['--windows', '--x64', '--publish', 'never'], ['--x64', '-p=never']]) {
    const commands = runLegacy(dir, argv, { ...enabled, SKIP_PREPARE: '1' }, 'win32');
    assert.equal(commands.length, 1);
    assert.equal(commands[0].command, `npx electron-builder --config.compression=maximum ${argv.join(' ')} --config.nsis.differentialPackage=false --config.nsis.useZip=true`);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).build, pkg.build);
});

test('ZIP legacy missing or conflicting publishing fails before any prepare or builder command', (t) => {
  const dir = temporaryClient(t);
  for (const argv of [['--win'], ['--win', '--publish=always'], ['--win', '-p', 'onTag'], ['--win', '-p=never', '--publish=always']]) {
    assert.throws(() => runLegacy(dir, argv, enabled), (error) => error.commands.length === 0 && /publish/.test(error.message));
  }
});

test('ZIP legacy parser ambiguities fail before any command, while default forwarding remains unchanged', (t) => {
  const dir = temporaryClient(t);
  const ambiguous = [
    ['--win', '--publish=never', '-p=never'],
    ['--win', '--publish=never', '--p=always'],
    ['--win', '--publish=never', '--no-p'],
    ['--win', '--publish=never', '--c=other.json'],
    ['--win', '--publish=never', '--m'],
    ['--win', '--publish=never', '-wp=always'],
    ['--win', '--publish=never', '-lp=always'],
    ['--win', '--publish=never', '-cp'],
    ['--win', '--publish=never', '-xz'],
    ['--win', '--publish=never', '--'],
    ['--win', '--publish=never', '--config.nsis.useZip=true'],
    ['--win', '--publish=never', '-c.nsis.differentialPackage=false'],
  ];
  for (const argv of ambiguous) {
    assert.throws(() => runLegacy(dir, argv, enabled), (error) => error.commands.length === 0);
    for (const env of [{}, { [ENV_KEY]: '' }]) {
      const commands = runLegacy(dir, argv, { ...env, SKIP_PREPARE: '1' });
      assert.equal(commands[0].command, `npx electron-builder --config.compression=maximum ${argv.join(' ')}`);
    }
  }
});

test('legacy invalid targets, conflicts and installed-version drift fail before preparation or packaging', (t) => {
  const dir = temporaryClient(t);
  for (const argv of [['--mac'], ['-mwl'], ['--win', '--config.nsis.useZip=false'], ['--win', '--config=other.json']]) {
    assert.throws(() => runLegacy(dir, argv, enabled), (error) => error.commands.length === 0);
  }
  const drifted = temporaryClient(t, pkg.build, { 'app-builder-lib': '26.0.0' });
  assert.throws(() => runLegacy(drifted, ['--win'], enabled), (error) => error.commands.length === 0 && /25\.1\.8/.test(error.message));
});

test('local pack rejects an invalid mode or non-Windows ZIP before preparation', async (t) => {
  const previous = process.env[ENV_KEY];
  t.after(() => { if (previous === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = previous; });
  let prepared = false;
  for (const mode of ['typo', 'zip-qa']) {
    process.env[ENV_KEY] = mode;
    await assert.rejects(pack('/fixture-client', { platform: 'darwin', prepare: async () => { prepared = true; } }), /Unknown|exclusive Windows/);
  }
  assert.equal(prepared, false);
});

test('generated ZIP config is accepted by installed 25.1.8 schema and selects matching vendor ZIP defines', async (t) => {
  let builderFile;
  try { builderFile = require.resolve('electron-builder/package.json', { paths: [client] }); } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    t.skip('Install the audited builder dependencies to run the real schema contract check.');
    return;
  }
  assert.deepEqual(installedBuilderVersions(client), versions);
  const builderRequire = createRequire(builderFile);
  builderRequire('app-builder-lib');
  const { configureBuildCommand, normalizeOptions } = builderRequire('./out/builder.js');
  const parse = (argv) => normalizeOptions(configureBuildCommand(builderRequire('yargs/yargs')(argv).parserConfiguration({ 'camel-case-expansion': false }).exitProcess(false)).parse());
  const duplicatePublish = parse(['--win', '--publish=never', '-p=never']);
  assert.deepEqual(duplicatePublish.publish, ['never', 'never']);
  const compactPublish = parse(['--win', '--publish=never', '-wp=always']);
  assert.deepEqual(compactPublish.publish, ['never', 'always']);
  const longAliasPublish = parse(['--win', '--publish=never', '--p=always']);
  assert.deepEqual(longAliasPublish.publish, ['never', 'always']);
  const duplicateArchive = parse(['--win', '--publish=never', '--config.nsis.useZip=true', '--config.nsis.useZip=true', '--config.nsis.differentialPackage=false', '--config.nsis.differentialPackage=false']);
  assert.deepEqual(duplicateArchive.config.nsis.useZip, [true, true]);
  assert.deepEqual(duplicateArchive.config.nsis.differentialPackage, [false, false]);
  const { validateConfiguration } = builderRequire('app-builder-lib/out/util/config/config.js');
  const { NsisTarget } = builderRequire('app-builder-lib/out/targets/nsis/NsisTarget.js');
  const generated = builderConfig(pkg, { ...configOptions, ...zipOptions });
  await validateConfiguration(generated, { isEnabled: false });
  const differentialGetter = Object.getOwnPropertyDescriptor(NsisTarget.prototype, 'isBuildDifferentialAware').get;
  assert.equal(differentialGetter.call({ isPortable: false, options: generated.nsis }), false);
  const defines = { APP_FILENAME: 'Nuwax' };
  NsisTarget.prototype.configureDefinesForAllTypeOfInstaller.call({ options: generated.nsis, isWebInstaller: false, packager: { appInfo: { productFilename: 'Nuwax', updaterCacheDirName: 'nuwax-updater' } } }, defines);
  assert.equal(defines.COMPRESSION_METHOD, 'zip');
  assert.ok(Object.hasOwn(defines, 'ZIP_COMPRESSION'));
});
