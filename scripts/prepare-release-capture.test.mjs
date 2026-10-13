import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as core from './client/core.mjs';
import { sha256 } from './client/capture-resources.mjs';
import { captureMacSignIgnore, configureWindowsCaptureToolchain, injectReleaseCapture, prepareReleaseCapture, releaseCapturePaths, stageSignedCaptureResource, verifyReleaseCaptureOutput, WINDOWS_RUNTIME_PACKAGES, WINDOWS_RUNTIME_VERSION } from './prepare-release-capture.mjs';

function fixture(t, platform = 'win32', arch = 'x64') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-capture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = releaseCapturePaths(root, platform, arch);
  fs.mkdirSync(path.dirname(files.packageFile), { recursive: true });
  const pkg = { version: '3.0.16-beta.1', build: { extraResources: [{ from: 'frontend', to: 'nuwax-dist' }] } };
  core.atomicJson(files.packageFile, pkg);
  const captureDir = path.join(root, 'resources/capture', `${platform}-${arch}`);
  fs.mkdirSync(captureDir, { recursive: true });
  const binary = path.join(captureDir, platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  fs.writeFileSync(binary, 'verified encoding binary');
  if (platform !== 'win32') fs.chmodSync(binary, 0o755);
  const record = { platform, arch, version: '8.1.3', sha256: sha256(binary) };
  core.atomicJson(path.join(captureDir, 'resource.json'), record);
  fs.mkdirSync(path.join(files.noticesDir, 'licenses'), { recursive: true });
  fs.mkdirSync(path.join(files.noticesDir, 'sources'), { recursive: true });
  core.atomicJson(path.join(files.noticesDir, 'third-party-notices.json'), { schema: 1, components: [{ id: 'ffmpeg', usedBy: 'capture' }] });
  fs.writeFileSync(path.join(files.noticesDir, 'licenses/ffmpeg.txt'), 'license fixture');
  fs.writeFileSync(path.join(files.noticesDir, 'sources/ffmpeg.tar.xz'), 'exact source fixture');
  const output = path.join(root, 'output');
  const resources = platform === 'darwin' ? path.join(output, `mac-${arch}/Nuwax.app/Contents/Resources`) : path.join(output, `${platform === 'win32' ? 'win' : 'linux'}-unpacked/resources`);
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, 'app.asar'), 'app fixture');
  const admitted = { dir: captureDir, binary, record };
  const inspect = async () => admitted;
  const copy = (dir = captureDir) => {
    fs.cpSync(dir, path.join(resources, 'capture', `${platform}-${arch}`), { recursive: true });
    fs.cpSync(files.noticesDir, path.join(resources, 'third-party/capture'), { recursive: true });
  };
  return { root, files, pkg, captureDir, admitted, inspect, output, resources, copy, platform, arch };
}

test('release injection preserves other resources, notices and signing, replacing all stale capture entries', () => {
  const old = { mac: { identity: 'Developer ID', extraResources: [{ to: 'capture/darwin-x64' }] }, win: { extraResources: [{ to: 'capture/old' }, { to: 'git' }] }, extraResources: [{ to: 'third-party' }, { to: 'third-party/capture' }, { to: 'nuwax-dist' }] };
  const result = injectReleaseCapture(old, { platform: 'win32', arch: 'x64', captureDir: '/verified/win32-x64', noticesDir: '/notices' });
  assert.equal(result.mac.identity, old.mac.identity);
  assert.deepEqual(result.win.extraResources, [{ to: 'git' }]);
  assert.deepEqual(result.mac.extraResources, []);
  assert.deepEqual(result.extraResources.slice(0, 2), [{ to: 'third-party' }, { to: 'nuwax-dist' }]);
  assert.deepEqual(result.extraResources.slice(2), [
    { from: '/verified/win32-x64', to: 'capture/win32-x64', filter: ['ffmpeg', 'ffmpeg.exe', 'resource.json'] },
    { from: '/notices', to: 'third-party/capture', filter: ['third-party-notices.json', 'licenses/**', 'sources/**'] },
  ]);
  assert.equal(old.win.extraResources.length, 2);
});

test('release preparation admits exact resources before writing builder configuration', async (t) => {
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'x64'], ['linux', 'arm64']]) {
    const f = fixture(t, platform, arch), calls = [];
    const result = await prepareReleaseCapture(f.root, {
      platform, arch, nativePlatform: platform, nativeArch: arch,
      configureWindows: async () => calls.push('toolchain'),
      prepare: async () => calls.push('prepare'), inspect: async () => { calls.push('inspect'); return f.admitted; },
      notices: async (_root, { outDir }) => { calls.push('notices'); fs.mkdirSync(outDir, { recursive: true }); core.atomicJson(path.join(outDir, 'third-party-notices.json'), { components: [] }); },
    });
    assert.deepEqual(calls, [...(platform === 'win32' ? ['toolchain'] : []), 'prepare', 'inspect', 'notices']);
    assert.equal(result.captureDir, f.captureDir);
    assert.ok(core.readJson(f.files.packageFile).build.extraResources.some((entry) => entry.to === `capture/${platform}-${arch}`));
  }
});

test('wrong native runner and missing resource or notices fail before changing package config', async (t) => {
  const f = fixture(t, 'darwin', 'x64');
  const before = fs.readFileSync(f.files.packageFile, 'utf8');
  await assert.rejects(prepareReleaseCapture(f.root, { platform: 'darwin', arch: 'x64', nativePlatform: 'darwin', nativeArch: 'arm64' }), /matching native runner/);
  const options = { platform: 'darwin', arch: 'x64', nativePlatform: 'darwin', nativeArch: 'x64', prepare: async () => {}, inspect: async () => null };
  await assert.rejects(prepareReleaseCapture(f.root, options), /Missing or unverified/);
  await assert.rejects(prepareReleaseCapture(f.root, { ...options, inspect: f.inspect, notices: async () => {} }), /notices were not generated/);
  assert.equal(fs.readFileSync(f.files.packageFile, 'utf8'), before);
});

test('Linux refuses cross-platform or cross-architecture preparation before mutating the builder', async (t) => {
  const f = fixture(t, 'linux', 'x64');
  const before = fs.readFileSync(f.files.packageFile, 'utf8');
  await assert.rejects(prepareReleaseCapture(f.root, { platform: 'linux', arch: 'x64', nativePlatform: 'darwin', nativeArch: 'x64' }), /matching native runner/);
  await assert.rejects(prepareReleaseCapture(f.root, { platform: 'linux', arch: 'x64', nativePlatform: 'linux', nativeArch: 'arm64' }), /matching native runner/);
  assert.equal(fs.readFileSync(f.files.packageFile, 'utf8'), before);
});

test('post-build verification covers Windows, both macOS and both Linux runtime default paths', async (t) => {
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'x64'], ['linux', 'arm64']]) {
    const f = fixture(t, platform, arch); f.copy();
    const result = await verifyReleaseCaptureOutput(f.root, f.output, { platform, arch, inspect: f.inspect });
    assert.deepEqual(result, { roots: [f.resources], capture: true });
  }
});

test('Linux package cannot omit its encoder or OpenH264 redistribution evidence', async (t) => {
  for (const relative of ['capture/linux-arm64/ffmpeg', 'capture/linux-arm64/resource.json', 'third-party/capture/licenses/openh264.txt', 'third-party/capture/sources/openh264.tar.gz']) {
    const f = fixture(t, 'linux', 'arm64');
    fs.writeFileSync(path.join(f.files.noticesDir, 'licenses/openh264.txt'), 'BSD-2-Clause fixture');
    fs.writeFileSync(path.join(f.files.noticesDir, 'sources/openh264.tar.gz'), 'OpenH264 source fixture');
    f.copy(); fs.rmSync(path.join(f.resources, relative));
    await assert.rejects(verifyReleaseCaptureOutput(f.root, f.output, { platform: 'linux', arch: 'arm64', inspect: f.inspect }), /missing or changed/, relative);
  }
});

test('Unix packages cannot silently lose encoder execute permission despite matching bytes', { skip: process.platform === 'win32' }, async (t) => {
  for (const platform of ['linux', 'darwin']) {
    const f = fixture(t, platform, 'arm64'); f.copy();
    fs.chmodSync(path.join(f.resources, `capture/${platform}-arm64/ffmpeg`), 0o644);
    await assert.rejects(verifyReleaseCaptureOutput(f.root, f.output, { platform, arch: 'arm64', inspect: f.inspect }), /not executable/);
  }
});

test('post-build missing encoder, metadata, license or exact source fails closed', async (t) => {
  for (const relative of ['capture/win32-x64/ffmpeg.exe', 'capture/win32-x64/resource.json', 'third-party/capture/third-party-notices.json', 'third-party/capture/licenses/ffmpeg.txt', 'third-party/capture/sources/ffmpeg.tar.xz']) {
    const f = fixture(t); f.copy();
    fs.rmSync(path.join(f.resources, relative));
    await assert.rejects(verifyReleaseCaptureOutput(f.root, f.output, { platform: 'win32', arch: 'x64', inspect: f.inspect }), /missing or changed/, relative);
  }
});

test('post-build changed binary or metadata and resources at another architecture path are rejected', async (t) => {
  for (const relative of ['capture/win32-x64/ffmpeg.exe', 'capture/win32-x64/resource.json', 'third-party/capture/sources/ffmpeg.tar.xz']) {
    const f = fixture(t); f.copy();
    fs.appendFileSync(path.join(f.resources, relative), 'changed');
    await assert.rejects(verifyReleaseCaptureOutput(f.root, f.output, { platform: 'win32', arch: 'x64', inspect: f.inspect }), /missing or changed/);
  }
  const f = fixture(t); f.copy();
  fs.renameSync(path.join(f.resources, 'capture/win32-x64'), path.join(f.resources, 'capture/win32-arm64'));
  await assert.rejects(verifyReleaseCaptureOutput(f.root, f.output, { platform: 'win32', arch: 'x64', inspect: f.inspect }), /missing or changed/);
});

test('post-build cannot pass with no unpacked app or no currently admitted source', async (t) => {
  const f = fixture(t); f.copy();
  await assert.rejects(verifyReleaseCaptureOutput(f.root, f.output, { platform: 'win32', arch: 'x64', inspect: async () => null }), /no longer verified/);
  fs.rmSync(path.join(f.resources, 'app.asar'));
  await assert.rejects(verifyReleaseCaptureOutput(f.root, f.output, { platform: 'win32', arch: 'x64', inspect: f.inspect }), /were not found/);
});

function fakeSigner() {
  const calls = [];
  const tools = { ...core, run: async (command, args) => {
    assert.equal(command, 'codesign');
    calls.push(args);
    if (args.includes('--sign')) fs.appendFileSync(args.at(-1), '\nsigned bytes');
    else assert.ok(fs.readFileSync(args.at(-1), 'utf8').includes('signed bytes'));
    return { status: 0, stdout: '', stderr: '' };
  } };
  return { tools, calls };
}

test('Mac pre-signing records final bytes and unsigned provenance without changing admitted source', async (t) => {
  const f = fixture(t, 'darwin', 'arm64'), signer = fakeSigner();
  const before = sha256(f.admitted.binary), recordBefore = sha256(path.join(f.captureDir, 'resource.json'));
  const staged = await stageSignedCaptureResource(f.root, f.admitted, { arch: 'arm64', identity: 'Developer ID test fixture', keychain: '/ci keychain', tools: signer.tools });
  assert.equal(staged.dir, f.files.signingDir);
  assert.notEqual(staged.record.sha256, before);
  assert.equal(staged.record.sha256, sha256(staged.binary));
  assert.deepEqual(staged.record.signing, { sourceHash: before, identity: 'Developer ID test fixture' });
  assert.equal(sha256(f.admitted.binary), before);
  assert.equal(sha256(path.join(f.captureDir, 'resource.json')), recordBefore);
  assert.ok(signer.calls[0].includes('--timestamp'));
  assert.ok(signer.calls[0].includes('--options'));
  assert.ok(signer.calls[0].includes('/ci keychain'));
  assert.deepEqual(signer.calls[1].slice(0, 3), ['--verify', '--strict', '--verbose=2']);
});

test('Mac builder skip pattern matches only the pre-signed runtime binary and unsigned preparation removes stale capture skip', () => {
  for (const arch of ['arm64', 'x64']) {
    const old = { mac: { signIgnore: ['existing-plugin$', captureMacSignIgnore(arch === 'arm64' ? 'x64' : 'arm64')] } };
    const signed = injectReleaseCapture(old, { platform: 'darwin', arch, captureDir: '/signed', noticesDir: '/notices', macPreSigned: true });
    assert.deepEqual(signed.mac.signIgnore, ['existing-plugin$', captureMacSignIgnore(arch)]);
    // app-builder-lib 25.1.8 uses new RegExp(pattern).test(fullPath), and
    // osx-sign checks ignore before its --force pass over each Mach-O child.
    const skip = new RegExp(signed.mac.signIgnore.at(-1));
    assert.ok(skip.test(`/output/mac/Nuwax.app/Contents/Resources/capture/darwin-${arch}/ffmpeg`));
    for (const file of [`/output/mac/Nuwax.app/Contents/Resources/capture/darwin-${arch}/ffmpeg-other`, '/output/mac/Nuwax.app/Contents/MacOS/Nuwax', `/output/mac/Nuwax.app/Contents/Resources/other/darwin-${arch}/ffmpeg`]) assert.equal(skip.test(file), false);
    const unsigned = injectReleaseCapture(signed, { platform: 'darwin', arch, captureDir: '/unsigned', noticesDir: '/notices' });
    assert.deepEqual(unsigned.mac.signIgnore, ['existing-plugin$']);
  }
});

test('Mac signed release preparation injects staging only after signing succeeds; unsigned release never requests signing', async (t) => {
  const f = fixture(t, 'darwin', 'arm64'), signer = fakeSigner();
  const common = { platform: 'darwin', arch: 'arm64', nativePlatform: 'darwin', nativeArch: 'arm64', prepare: async () => {}, inspect: f.inspect, notices: async (_root, { outDir }) => { fs.mkdirSync(outDir, { recursive: true }); core.atomicJson(path.join(outDir, 'third-party-notices.json'), { components: [] }); } };
  const before = fs.readFileSync(f.files.packageFile, 'utf8');
  await assert.rejects(prepareReleaseCapture(f.root, { ...common, macSigning: true, signIdentity: '', tools: signer.tools }), /explicit signing identity/);
  await assert.rejects(prepareReleaseCapture(f.root, { ...common, macSigning: true, signIdentity: 'test', tools: { ...signer.tools, run: async (command, args) => {
    if (args.includes('--verify')) throw new Error('signature verification failed');
    return signer.tools.run(command, args);
  } } }), /signature verification failed/);
  assert.equal(fs.readFileSync(f.files.packageFile, 'utf8'), before);
  const signed = await prepareReleaseCapture(f.root, { ...common, macSigning: true, signIdentity: 'test', tools: signer.tools });
  assert.equal(signed.captureDir, f.files.signingDir);
  assert.ok(core.readJson(f.files.packageFile).build.mac.signIgnore.includes(captureMacSignIgnore('arm64')));
  const unsigned = await prepareReleaseCapture(f.root, { ...common, macSigning: false, stageSigned: () => assert.fail('unsigned release must not pre-sign') });
  assert.equal(unsigned.captureDir, f.captureDir);
  assert.deepEqual(core.readJson(f.files.packageFile).build.mac.signIgnore, []);
});

test('Mac post-build verifies signed staging provenance and final signed bytes, rejecting re-signing or forged provenance', async (t) => {
  const f = fixture(t, 'darwin', 'arm64'), signer = fakeSigner();
  const staged = await stageSignedCaptureResource(f.root, f.admitted, { arch: 'arm64', identity: 'test', tools: signer.tools });
  const pkg = core.readJson(f.files.packageFile);
  pkg.build = injectReleaseCapture(pkg.build, { captureDir: staged.dir, noticesDir: f.files.noticesDir, platform: 'darwin', arch: 'arm64', macPreSigned: true });
  core.atomicJson(f.files.packageFile, pkg);
  f.copy(staged.dir);
  const verify = () => verifyReleaseCaptureOutput(f.root, f.output, { platform: 'darwin', arch: 'arm64', inspect: f.inspect, tools: signer.tools });
  assert.equal((await verify()).capture, true);
  assert.equal(sha256(path.join(f.resources, 'capture/darwin-arm64/ffmpeg')), staged.record.sha256);
  fs.appendFileSync(path.join(f.resources, 'capture/darwin-arm64/ffmpeg'), 'builder re-sign');
  await assert.rejects(verify(), /missing or changed/);
  f.copy(staged.dir);
  const recordFile = path.join(staged.dir, 'resource.json');
  core.atomicJson(recordFile, { ...staged.record, signing: { ...staged.record.signing, sourceHash: 'not-original-source' } });
  await assert.rejects(verify(), /no longer matches/);
  core.atomicJson(recordFile, staged.record);
  pkg.build.mac.signIgnore = [];
  core.atomicJson(f.files.packageFile, pkg);
  await assert.rejects(verify(), /not protected/);
});

function runtimeFixture(t) {
  const f = fixture(t);
  const calls = [], env = { Path: 'node-path' };
  let version = WINDOWS_RUNTIME_VERSION, wrongHash = false, signatureError = false;
  const tools = {
    readJson: () => ({ resources: { capture: { components: [{ id: 'winpthreads', toolchainPackageVersion: version }] } } }),
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      if (args.includes('capture-runtime-signature') && signatureError) throw new Error('untrusted signature');
      return { status: 0, stdout: args[1]?.includes('gcc -dumpmachine') ? 'x86_64-w64-mingw32\n' : `mingw-w64-x86_64-winpthreads ${WINDOWS_RUNTIME_VERSION}\n` };
    },
  };
  const options = { location: '/msys2 with spaces', arch: 'x64', env, tools, hash: (file) => wrongHash ? 'bad' : WINDOWS_RUNTIME_PACKAGES.find((entry) => file.endsWith(entry.archive)).sha256 };
  return { ...f, calls, env, options, wrongVersion: () => { version = 'new-version'; }, wrongHash: () => { wrongHash = true; }, signatureError: () => { signatureError = true; } };
}

test('Windows CI pins both official split archives, verifies signatures, installs together, then checks actual compiler/runtime', async (t) => {
  const f = runtimeFixture(t);
  await configureWindowsCaptureToolchain(f.root, f.options);
  const downloads = f.calls.filter((call) => call.command === 'curl');
  assert.equal(downloads.length, 4);
  for (const entry of WINDOWS_RUNTIME_PACKAGES) {
    assert.ok(downloads.some((call) => call.args.includes(`https://repo.msys2.org/mingw/mingw64/${entry.archive}`)));
    assert.ok(downloads.some((call) => call.args.includes(`https://repo.msys2.org/mingw/mingw64/${entry.archive}.sig`)));
  }
  const signatures = f.calls.filter((call) => call.args.includes('capture-runtime-signature'));
  assert.equal(signatures.length, 2);
  const install = f.calls.findIndex((call) => call.args.includes('capture-runtime-install'));
  assert.ok(install > f.calls.indexOf(signatures[1]));
  assert.equal(f.calls[install].args.slice(-2).length, 2);
  assert.match(f.env.Path, /mingw64\/bin;.*usr\/bin;node-path$/);
  assert.equal(f.env.NUWAX_CAPTURE_BUILD_BASH, '/msys2 with spaces/usr/bin/bash.exe');
  assert.ok(f.calls.slice(install + 1).some((call) => call.args[1]?.includes('pacman -Qoq')));
});

test('Windows declaration drift, changed archive and untrusted signature are rejected before install', async (t) => {
  for (const [mutate, message] of [['wrongVersion', /package lock/], ['wrongHash', /SHA256 mismatch/], ['signatureError', /untrusted signature/]]) {
    const f = runtimeFixture(t); f[mutate]();
    await assert.rejects(configureWindowsCaptureToolchain(f.root, f.options), message);
    assert.equal(f.calls.some((call) => call.args.includes('capture-runtime-install')), false);
  }
});
