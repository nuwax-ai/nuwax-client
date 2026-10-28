import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import updater from '../nuwa-electron-shell/crates/agent-electron-client/scripts/build/app-update-config.cjs';
import { configureSystemAppName } from './client/system-app-name.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const buildDir = path.join(root, 'nuwa-electron-shell/crates/agent-electron-client/scripts/build');
const helperFile = path.join(buildDir, 'windows-installer-orchestration.cjs');
const wrapperFile = path.join(buildDir, 'run-build-electron.js');
const originalPackage = JSON.parse(fs.readFileSync(path.join(root, 'nuwa-electron-shell/crates/agent-electron-client/package.json')));
const policy = require(path.join(buildDir, 'installer-archive-policy.cjs'));
const helper = () => require(helperFile);
const versions = { electronBuilder: '25.1.8', appBuilderLib: '25.1.8' };

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-inst-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function write(file, content = 'fixture') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function standardBuild(output, channel = 'beta') {
  const build = configureSystemAppName(updater.configureUpdater(structuredClone(originalPackage.build), {
    feedBase: 'https://nuwa-packages.oss-rg-china-mainland.aliyuncs.com/nuwax-electron',
  }), { platform: 'win32', arch: 'x64' });
  build.appId = 'com.nuwax-ai.nuwax';
  build.productName = 'Nuwax';
  build.extraMetadata = { ...build.extraMetadata, name: 'nuwax' };
  build.directories.output = output;
  build.nsis.warningsAsErrors = false;
  build.extraResources.push({ from: '../../../nuwax/dist', to: 'nuwax-dist' });
  return { ...originalPackage, version: channel === 'beta' ? '3.0.23-beta.8' : '3.0.23', build };
}
function standardEnv(output) {
  return { GITHUB_ACTIONS: 'true', NUWAX_APP_IDENTIFIER: 'nuwax', NUWAX_WINDOWS_OUTPUT_DIR: output, TARGET_ARCH: 'x64', CSC_NAME: 'Developer ID Application: fixture (macOS only)' };
}

test('the standard commercial Windows wrapper dispatches a parallel installer coordinator instead of the serial builder command', (t) => {
  const dir = temporary(t);
  const output = 'D:/a/_temp/nw-40358051690-1-x64';
  write(path.join(dir, 'package.json'), JSON.stringify(standardBuild(output)));
  for (const name of ['electron-builder', 'app-builder-lib']) write(path.join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ version: '25.1.8' }));
  const commands = [];
  const module = { exports: {} };
  const mockedRequire = name => {
    if (name === 'child_process') return { execSync: (...args) => commands.push({ type: 'shell', args }), execFileSync: (...args) => commands.push({ type: 'file', args }) };
    if (name === '../utils/project-paths') return { getProjectRoot: () => dir };
    if (name === './installer-archive-policy.cjs') return policy;
    if (name === './windows-installer-orchestration.cjs') return helper();
    return require(name);
  };
  mockedRequire.main = module;
  vm.runInNewContext(fs.readFileSync(wrapperFile, 'utf8'), { module, require: mockedRequire, process: { execPath: process.execPath, argv: ['node', wrapperFile, '--win', '--publish', 'never'], env: { ...standardEnv(output), SKIP_PREPARE: '1' }, platform: 'win32', arch: 'x64' }, __dirname: buildDir, console: { log() {} } }, { filename: wrapperFile });
  assert.ok(commands.some(command => command.type === 'file' && command.args[1].includes(helperFile)), 'standard release must reach the coordinator');
  assert.ok(commands.every(command => command.type !== 'shell'), 'must not invoke the legacy serial npx command');
});

test('both release configurations opt in, preserving updater, archive and NSIS recovery configuration', () => {
  const output = 'D:/a/_temp/nw-40358051690-1-x64';
  for (const channel of ['beta', 'stable']) {
    const pkg = standardBuild(output, channel);
    const before = structuredClone(pkg);
    const result = helper().parallelInstallerEligibility({ pkg, argv: ['--win', '--publish', 'never'], env: standardEnv(output), platform: 'win32', arch: 'x64', builderVersions: versions });
    assert.deepEqual(result, { eligible: true, reason: 'standard unsigned Windows release', output, arch: 'x64' });
    assert.deepEqual(pkg, before);
  }
});

test('unsupported entry points and signing retain the original path with a useful reason', () => {
  const output = 'D:/a/_temp/nw-40358051690-1-x64';
  const options = { pkg: standardBuild(output), argv: ['--win', '--publish', 'never'], env: standardEnv(output), platform: 'win32', arch: 'x64', builderVersions: versions };
  const cases = [
    { platform: 'darwin' }, { arch: 'arm64' }, { env: { ...options.env, GITHUB_ACTIONS: 'false' } },
    { env: { ...options.env, NUWAX_WINDOWS_PARALLEL_INSTALLERS: '0' } }, { env: { ...options.env, NUWAX_WINDOWS_INSTALLER_ARCHIVE: '7z-qa' } },
    { argv: ['--win', 'nsis', '--publish', 'never'] }, { argv: ['--win', '--dir', '--publish', 'never'] },
    { argv: ['--win', '--prepackaged', 'app', '--publish', 'never'] }, { argv: ['--win', '--publish', 'always'] },
    { argv: ['--win', '--publish', 'never', '--config.nsis.shortcutName=custom'] },
    { env: { ...options.env, CSC_LINK: 'fixture.pfx' } }, { env: { ...options.env, WINDOWS_CERTIFICATE_SHA1: 'fixture' } },
    { pkg: { ...options.pkg, build: { ...options.pkg.build, win: { ...options.pkg.build.win, target: ['nsis'] } } } },
    { pkg: { ...options.pkg, build: { ...options.pkg.build, afterPack: 'custom.cjs' } } },
    { pkg: { ...options.pkg, build: { ...options.pkg.build, afterSign: 'custom.cjs' } } },
    { pkg: { ...options.pkg, build: { ...options.pkg.build, win: { ...options.pkg.build.win, sign: 'hardware-sign.cjs' } } } },
    { builderVersions: { ...versions, appBuilderLib: '26.0.0' } },
  ];
  for (const changes of cases) {
    const result = helper().parallelInstallerEligibility({ ...options, ...changes });
    assert.equal(result.eligible, false, JSON.stringify(changes));
    assert.ok(result.reason.length > 8);
  }
});

function sdk() {
  const project = process.env.NUWAX_TEST_BUILDER_CLIENT_DIR || path.join(root, 'nuwa-electron-shell/crates/agent-electron-client');
  const sdkRequire = createRequire(require.resolve('electron-builder/package.json', { paths: [project] }));
  assert.equal(sdkRequire('electron-builder/package.json').version, '25.1.8');
  assert.equal(sdkRequire('app-builder-lib/package.json').version, '25.1.8');
  return { api: sdkRequire('app-builder-lib'), ...sdkRequire('app-builder-lib/out/util/config/config.js') };
}

test('real pinned SDK receives dir then distinct prepackaged target maps with the complete unchanged product configuration', async (t) => {
  const { api, getConfig, validateConfiguration } = sdk();
  const projectRoot = temporary(t);
  const pkg = standardBuild('D:/a/_temp/final');
  write(path.join(projectRoot, 'package.json'), JSON.stringify(pkg));
  const before = structuredClone(pkg);
  for (const stage of ['app', 'msi', 'nsis', 'serial']) {
    const job = { stage, arch: 'x64', projectRoot, output: `/fixture/${stage}/o`, app: `/fixture/${stage}/a` };
    const options = helper().createBuilderOptions(pkg, job, api);
    const effective = await getConfig(projectRoot, null, structuredClone(options.config));
    await validateConfiguration(effective, { isEnabled: false });
    api.checkBuildRequestOptions(options);
    assert.equal(options.publish, 'never');
    assert.equal(options.prepackaged, stage === 'app' ? undefined : job.app);
    assert.deepEqual([...options.targets.get(api.Platform.WINDOWS).get(api.Arch.x64)], stage === 'serial' ? ['msi', 'nsis'] : [stage === 'app' ? 'dir' : stage]);
    assert.equal(effective.nsis.useZip, true);
    assert.equal(effective.nsis.differentialPackage, false);
    assert.equal(effective.nsis.include, pkg.build.nsis.include);
    assert.equal(effective.nsis.shortcutName, pkg.build.nsis.shortcutName);
    assert.equal(effective.nsis.shortcutName, '女娲Nuwax');
    assert.equal(effective.nsis.warningsAsErrors, false);
    assert.equal(effective.msi.artifactName, pkg.build.msi.artifactName);
    assert.equal(effective.afterPack, pkg.build.afterPack);
    assert.equal(effective.afterSign, pkg.build.afterSign);
    assert.equal(effective.compression, 'normal');
    assert.equal(effective.afterAllArtifactBuild, policy.BLOCKMAP_HOOK);
    assert.equal(effective.directories.output, job.output);
    assert.equal(effective.appId, pkg.build.appId);
    assert.equal(effective.productName, pkg.build.productName);
    assert.deepEqual(effective.publish, pkg.build.publish);
    assert.deepEqual(effective.extraMetadata, pkg.build.extraMetadata);
    assert.deepEqual(effective.win.extraResources, pkg.build.win.extraResources);
    assert.deepEqual(effective.nsis, { ...pkg.build.nsis, differentialPackage: false, useZip: true });
  }
  assert.deepEqual(pkg, before);
  // This calls the SDK's real early-return path: it must not touch filesystem,
  // dependencies, application hooks or signing when handed an isolated copy.
  await api.PlatformPackager.prototype.doPack.call({ packagerOptions: { prepackaged: '/fixture/a' } }, '/fixture/o', '/fixture/a', 'win32', api.Arch.x64, [], null);
});

const fixtureWorker = String.raw`
const fs = require('node:fs'); const path = require('node:path');
const job = JSON.parse(fs.readFileSync(process.argv[2]));
const write = (file, text) => { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file,text); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  if (job.stage === 'app') {
    const app = path.join(job.output, 'win-unpacked');
    write(path.join(app,'Nuwax.exe'),'signed-app');
    write(path.join(app,'resources','app-update.yml'),'provider: generic');
    write(path.join(app,'resources','uninstall.json'),'uninstall inventory');
    write(path.join(job.cache,'winCodeSign','rcedit.exe'),'warmed compiler');
    write(job.receipt,JSON.stringify({output:job.output,appOutDir:app})); return;
  }
  if (fs.readFileSync(path.join(job.cache,'winCodeSign','rcedit.exe'),'utf8') !== 'warmed compiler') throw Error('cache was not warmed');
  if (fs.readFileSync(path.join(job.app,'resources','app-update.yml'),'utf8') !== 'provider: generic') throw Error('missing prepared app');
  if (fs.readFileSync(path.join(process.env.FIXTURE_CACHE,'seed'),'utf8') !== 'unchanged source') throw Error('source cache changed');
  const state = { app:job.app, cache:job.cache, temp:process.env.TEMP, output:job.output, inode:fs.statSync(path.join(job.app,'Nuwax.exe')).ino };
  write(path.join(process.env.FIXTURE_BARRIER,job.stage+'.json'),JSON.stringify(state));
  if(job.stage==='serial') {
    if(process.env.FIXTURE_FAIL==='serial') throw Error('deliberate serial failure');
    write(path.join(job.output,'Nuwax.msi'),'signed msi');
    write(path.join(job.app,'resources','elevate.exe'),'signed elevate');
    write(path.join(job.output,'Nuwax-Setup.exe'),'signed nsis');
    write(path.join(job.output,'Nuwax-Setup.exe.blockmap'),'verified blockmap');
    write(path.join(job.output,'latest.yml'),'path: Nuwax-Setup.exe');
    write(path.join(job.output,'builder-debug.yml'),'serial debug');
    write(job.receipt,JSON.stringify({output:job.output,appOutDir:job.app})); return;
  }
  for(let i=0;!fs.existsSync(path.join(process.env.FIXTURE_BARRIER,(job.stage==='msi'?'nsis':'msi')+'.json'));i++) { if(i>300) throw Error('builders did not overlap'); await wait(10); }
  if(process.env.FIXTURE_FAIL===job.stage) { await wait(20); throw Error('deliberate target failure'); }
  if(job.stage==='nsis') {
    write(path.join(job.app,'resources','elevate.exe'),'signed elevate');
    write(path.join(job.output,'Nuwax-Setup.exe'),'signed nsis');
    write(path.join(job.output,'Nuwax-Setup.exe.blockmap'),'verified blockmap');
    write(path.join(job.output,'latest.yml'),'path: Nuwax-Setup.exe');
  } else {
    if(fs.existsSync(path.join(job.app,'resources','elevate.exe'))) throw Error('MSI copy was mutated by NSIS');
    write(path.join(job.output,'Nuwax.msi'),'signed msi');
  }
  if(process.env.FIXTURE_CONFLICT) write(path.join(job.output,'shared.yml'),job.stage);
  write(path.join(job.output,'builder-effective-config.yaml'),job.stage+' diagnostics');
  write(path.join(job.output,'builder-debug.yml'),job.stage+' debug');
  await wait(job.stage==='nsis'?60:10);
  write(path.join(process.env.FIXTURE_BARRIER,job.stage+'.done'),'done');
  write(job.receipt,JSON.stringify({output:job.output,appOutDir:job.app}));
})().catch(error => { console.error(error.message); process.exitCode=1; });
`;

function pipelineFixture(t, env = {}) {
  const dir = temporary(t);
  const output = path.join(dir, 'final');
  const workerFile = path.join(dir, 'worker.cjs');
  const cache = path.join(dir, 'original-cache');
  write(workerFile, fixtureWorker);
  write(path.join(cache, 'seed'), 'unchanged source');
  return { dir, output, options: { projectRoot: dir, output, arch: 'x64', env: { ...process.env, ELECTRON_BUILDER_CACHE: cache, FIXTURE_CACHE: cache, FIXTURE_BARRIER: path.join(dir, 'barrier'), ...env } }, dependencies: { workerFile, keepWork: true, statfs: () => ({ bsize: 1n, bavail: 1024n ** 5n }) } };
}

test('parallel disk estimate reserves two app/cache copies and separate archive/output working bytes', () => {
  const { parallelSpaceRequirement, PARALLEL_DISK_RESERVE_BYTES } = helper();
  assert.equal(PARALLEL_DISK_RESERVE_BYTES, 1024n ** 3n);
  assert.equal(parallelSpaceRequirement(100n, 20n), 6n * 100n + 2n * 20n + PARALLEL_DISK_RESERVE_BYTES);
});

test('real child processes overlap only after one app build, using physical app copies, warm independent caches and temporary/output directories', async (t) => {
  const fixture = pipelineFixture(t);
  const result = await helper().orchestrateInstallers(fixture.options, fixture.dependencies);
  assert.equal(result.mode, 'parallel');
  assert.ok(result.space.appBytes > 0n && result.space.cacheBytes > 0n, 'measure the actual prepared fixture');
  assert.ok(result.space.availableBytes >= result.space.requiredBytes);
  const states = ['msi','nsis'].map(stage => JSON.parse(fs.readFileSync(path.join(fixture.dir, 'barrier', stage+'.json'))));
  for (const key of ['app','cache','temp','output','inode']) assert.notEqual(states[0][key], states[1][key], key+' must be isolated');
  assert.notEqual(states[0].inode, fs.statSync(path.join(fixture.output, 'win-unpacked/Nuwax.exe')).ino, 'copies must not be hardlinks');
  assert.equal(fs.readFileSync(path.join(fixture.output, 'win-unpacked/resources/elevate.exe'), 'utf8'), 'signed elevate');
  assert.equal(fs.readFileSync(path.join(fixture.output, 'win-unpacked/resources/uninstall.json'), 'utf8'), 'uninstall inventory');
  assert.deepEqual(fs.readdirSync(fixture.output).sort(), ['Nuwax-Setup.exe','Nuwax-Setup.exe.blockmap','Nuwax.msi','latest.yml','win-unpacked'].sort());
  assert.equal(fs.readFileSync(path.join(fixture.dir, 'original-cache/seed'), 'utf8'), 'unchanged source');
  assert.ok(fs.existsSync(path.join(result.work, 'nsis/o/builder-debug.yml')), 'diagnostics are kept outside the uploaded directory');
  assert.equal(fs.readFileSync(path.join(states[0].app, 'Nuwax.exe'), 'utf8'), 'signed-app');
});

for (const [name, statfs] of [
  ['low free disk', () => ({ bsize: 1n, bavail: 1n })],
  ['unreadable free disk', () => { throw new Error('fixture statfs unavailable'); }],
]) {
  test(`${name} reuses the prepared application and warm cache in one serial installer process`, async (t) => {
    const fixture = pipelineFixture(t);
    const result = await helper().orchestrateInstallers(fixture.options, { ...fixture.dependencies, statfs });
    assert.equal(result.mode, 'serial');
    assert.match(result.space.reason, /space|disk|statfs/i);
    const state = JSON.parse(fs.readFileSync(path.join(fixture.dir, 'barrier/serial.json')));
    assert.equal(state.app, path.join(result.work, 'app/o/win-unpacked'));
    assert.equal(state.cache, path.join(result.work, 'app/c'));
    assert.equal(state.inode, fs.statSync(path.join(fixture.output, 'win-unpacked/Nuwax.exe')).ino, 'serial fallback must not copy the application');
    for (const stage of ['msi', 'nsis']) {
      assert.equal(fs.existsSync(path.join(fixture.dir, 'barrier', stage + '.json')), false, 'must not launch separate target workers');
      assert.equal(fs.existsSync(path.join(result.work, stage, 'a')), false, 'must not create application copies');
      assert.equal(fs.existsSync(path.join(result.work, stage, 'c')), false, 'must not create cache copies');
    }
    assert.deepEqual(fs.readdirSync(fixture.output).sort(), ['Nuwax-Setup.exe', 'Nuwax-Setup.exe.blockmap', 'Nuwax.msi', 'latest.yml', 'win-unpacked'].sort());
    assert.equal(fs.readFileSync(path.join(fixture.output, 'win-unpacked/resources/elevate.exe'), 'utf8'), 'signed elevate');
    assert.equal(fs.readFileSync(path.join(fixture.dir, 'original-cache/seed'), 'utf8'), 'unchanged source');
  });
}

test('a serial fallback failure never promotes an installer or updater metadata set', async (t) => {
  const fixture = pipelineFixture(t, { FIXTURE_FAIL: 'serial' });
  await assert.rejects(helper().orchestrateInstallers(fixture.options, {
    ...fixture.dependencies, statfs: () => ({ bsize: 1n, bavail: 1n }),
  }), /serial.*failed/i);
  assert.ok(fs.existsSync(path.join(fixture.dir, 'barrier/serial.json')));
  assert.equal(fs.existsSync(fixture.output), false);
});

test('promotion moves installer bytes within the work volume instead of keeping a second complete installer set', async (t) => {
  const fixture = pipelineFixture(t);
  const result = await helper().orchestrateInstallers(fixture.options, fixture.dependencies);
  for (const [stage, names] of [['msi', ['Nuwax.msi']], ['nsis', ['Nuwax-Setup.exe', 'Nuwax-Setup.exe.blockmap', 'latest.yml']]]) {
    for (const name of names) {
      assert.equal(fs.existsSync(path.join(result.work, stage, 'o', name)), false, `${name} must be moved, not copied`);
      assert.ok(fs.statSync(path.join(fixture.output, name)).size);
    }
    assert.ok(fs.existsSync(path.join(result.work, stage, 'o/builder-debug.yml')), 'diagnostics remain in the private target directory');
  }
});

test('a Windows cleanup lock after promotion reports its directory without failing the complete build', async (t) => {
  const fixture = pipelineFixture(t);
  const originalRm = fs.rmSync, originalWarn = console.warn, originalError = console.error;
  const warnings = [], errors = [];
  let result;
  try {
    fs.rmSync = (file, options) => {
      if (String(file).startsWith(path.join(fixture.dir, 'ni-'))) throw Object.assign(new Error('fixture file locked'), { code: 'EBUSY' });
      return originalRm(file, options);
    };
    console.warn = (...args) => warnings.push(args.join(' '));
    console.error = (...args) => errors.push(args.join(' '));
    result = await helper().orchestrateInstallers(fixture.options, { ...fixture.dependencies, keepWork: false });
  } finally { fs.rmSync = originalRm; console.warn = originalWarn; console.error = originalError; }
  assert.ok(fs.existsSync(path.join(fixture.output, 'Nuwax.msi')));
  assert.ok(fs.existsSync(path.join(fixture.output, 'Nuwax-Setup.exe')));
  assert.ok(fs.existsSync(result.work));
  assert.equal(errors.length, 0, 'complete promotion must not print a no-promotion error');
  assert.ok(warnings.some(warning => warning.includes(result.work)), 'cleanup warning must identify the retained directory');
});

test('a failed target waits for its sibling and never promotes a partial installer or metadata set', async (t) => {
  const fixture = pipelineFixture(t, { FIXTURE_FAIL: 'msi' });
  await assert.rejects(helper().orchestrateInstallers(fixture.options, fixture.dependencies), /msi.*failed/i);
  assert.ok(fs.existsSync(path.join(fixture.dir, 'barrier/nsis.done')), 'sibling must be reaped before failure returns');
  assert.equal(fs.existsSync(fixture.output), false);
});

test('conflicting metadata is rejected before any public output is promoted', async (t) => {
  const fixture = pipelineFixture(t, { FIXTURE_CONFLICT: '1' });
  await assert.rejects(helper().orchestrateInstallers(fixture.options, fixture.dependencies), /conflict.*shared.yml/i);
  assert.equal(fs.existsSync(fixture.output), false);
});

test('an existing release directory is protected before running child processes', async (t) => {
  const fixture = pipelineFixture(t);
  write(path.join(fixture.output, 'previous.exe'), 'existing release');
  await assert.rejects(helper().orchestrateInstallers(fixture.options, fixture.dependencies), /output.*empty/i);
  assert.equal(fs.readFileSync(path.join(fixture.output, 'previous.exe'), 'utf8'), 'existing release');
  assert.equal(fs.existsSync(path.join(fixture.dir, 'barrier')), false);
});
