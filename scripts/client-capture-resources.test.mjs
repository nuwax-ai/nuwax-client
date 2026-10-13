import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertCaptureWindowsToolchain, captureBuildArguments, captureBuildPaths, captureResourceDir, inspectCaptureResource, prepareCaptureResources, readCaptureSourceLock, sha256 } from './client/capture-resources.mjs';

const root = path.resolve(import.meta.dirname, '..');
const locked = readCaptureSourceLock(root);
function fixture(t, platform = 'darwin') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-resource-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'third-party'), { recursive: true });
  const lock = structuredClone(locked);
  const sourcesDir = path.join(dir, 'resources/capture/sources');
  fs.mkdirSync(sourcesDir, { recursive: true });
  for (const name of ['ffmpeg', 'libvpx']) {
    const file = path.join(sourcesDir, lock[name].archive);
    fs.writeFileSync(file, `${name} source fixture`);
    lock[name].sha256 = sha256(file);
  }
  fs.writeFileSync(path.join(dir, 'third-party/capture-sources.json'), JSON.stringify(lock));
  const arch = platform === 'win32' ? 'x64' : 'arm64';
  const resourceDir = captureResourceDir(dir, platform, arch);
  fs.mkdirSync(resourceDir, { recursive: true });
  const binary = path.join(resourceDir, platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  fs.writeFileSync(binary, 'fixture binary');
  const record = { schema: 1, platform, arch, version: lock.ffmpeg.version, sha256: sha256(binary), configuration: '--disable-gpl --disable-nonfree --enable-videotoolbox', sources: lock };
  const manifest = { resources: { capture: { components: [] } } };
  let runtime, runtimeArchive;
  const writeManifest = () => fs.writeFileSync(path.join(dir, 'third-party/manifest.json'), JSON.stringify(manifest));
  if (platform === 'win32') {
    runtime = JSON.parse(fs.readFileSync(path.join(root, 'third-party/manifest.json'), 'utf8')).resources.capture.components.find((entry) => entry.id === 'winpthreads');
    runtimeArchive = path.join(dir, runtime.sourceFile);
    fs.writeFileSync(runtimeArchive, 'fixed thread runtime source');
    runtime.sourceSha256 = sha256(runtimeArchive);
    manifest.resources.capture.components.push(runtime);
    writeManifest();
    record.sources.winpthreads = { version: runtime.version, toolchainPackageVersion: runtime.toolchainPackageVersion, url: runtime.sourceUrl, sha256: runtime.sourceSha256, archive: path.basename(runtimeArchive) };
  }
  const writeRecord = () => fs.writeFileSync(path.join(resourceDir, 'resource.json'), JSON.stringify(record));
  writeRecord();
  const tools = { readJson: (file) => JSON.parse(fs.readFileSync(file, 'utf8')), run: async () => ({ status: 0, stdout: `ffmpeg version ${lock.ffmpeg.version} fixture\nconfiguration: ${record.configuration}\n` }) };
  return { dir, resourceDir, record, writeRecord, tools, lock, runtime, runtimeArchive, writeManifest };
}

test('the source lock pins HTTPS versions/commits with actual SHA256, never latest assets', () => {
  assert.equal(locked.ffmpeg.version, '8.1.3');
  assert.equal(locked.libvpx.commit.length, 40);
  for (const source of [locked.ffmpeg, locked.libvpx]) {
    assert.match(source.sha256, /^[a-f0-9]{64}$/);
    assert.match(source.url, /^https:\/\//);
    assert.doesNotMatch(source.url, /latest/);
  }
});

test('native platform recipes disable GPL/nonfree and use OS H264 plus VP9/GIF', () => {
  for (const platform of ['darwin', 'win32']) for (const arch of ['x64', 'arm64']) {
    const args = captureBuildArguments(locked, { platform, arch, prefix: '/prefix', compiler: '/clang', sdk: '/sdk' });
    assert.ok(args.ffmpeg.includes('--disable-autodetect'));
    assert.ok(args.ffmpeg.includes('--disable-gpl'));
    assert.ok(args.ffmpeg.includes('--disable-nonfree'));
    assert.ok(args.ffmpeg.some((arg) => arg.includes(platform === 'darwin' ? 'h264_videotoolbox' : 'h264_mf')));
    // FFmpeg 8.1 MediaFoundation uses D3D11 context types even for system-memory input.
    assert.equal(args.ffmpeg.includes('--enable-d3d11va'), platform === 'win32');
    assert.equal(args.ffmpeg.includes('--extra-ldflags=-L/prefix/lib -static'), platform === 'win32');
    assert.ok(args.ffmpeg.some((arg) => arg.includes('libvpx_vp9,gif')));
    assert.ok(args.ffmpeg.some((arg) => arg.includes('palettegen,paletteuse')));
    assert.doesNotMatch(args.ffmpeg.join(' '), /x264|enable-gpl|enable-nonfree/);
  }
  assert.throws(() => captureBuildArguments(locked, { platform: 'linux', arch: 'x64', prefix: '/prefix' }), /不支持/);
});

test('Windows configure uses the chosen MSYS shell to convert native paths without shell interpolation', async () => {
  const nativePrefix = String.raw`D:\Capture builds\prefix`;
  const shell = 'C:/msys64/usr/bin/bash.exe';
  const calls = [];
  const result = await captureBuildPaths(nativePrefix, { platform: 'win32', shell, tools: { run: async (...args) => {
    calls.push(args);
    return { status: 0, stdout: '/d/Capture builds/prefix\r\n' };
  } } });
  assert.deepEqual(calls[0].slice(0, 2), [shell, ['-c', 'cygpath -u "$1"', 'capture-path', nativePrefix]]);
  assert.deepEqual(result, { prefix: '/d/Capture builds/prefix', pkgConfigPath: '/d/Capture builds/prefix/lib/pkgconfig' });
  await assert.rejects(captureBuildPaths(nativePrefix, { platform: 'win32', shell, tools: { run: async () => ({ stdout: nativePrefix }) } }), /绝对 Unix 路径/);
});

test('macOS configure paths do not need a Windows conversion utility', async () => {
  assert.deepEqual(await captureBuildPaths('/tmp/capture/prefix', { platform: 'darwin', shell: '/bin/bash', tools: { run: () => assert.fail('unexpected shell call') } }), {
    prefix: '/tmp/capture/prefix', pkgConfigPath: '/tmp/capture/prefix/lib/pkgconfig',
  });
});

test('Windows missing or wrong-architecture compiler fails before building with actionable PATH guidance', async () => {
  const check = (status, stdout, arch = 'x64') => assertCaptureWindowsToolchain({ shell: 'msys-bash', arch, tools: { run: async () => ({ status, stdout, stderr: '' }) } });
  await assert.rejects(check(1, 'Missing make'), /仅设置 bash 路径不会配置编译器.*Missing make/);
  await assert.rejects(check(0, 'x86_64-linux-gnu'), /MSYS2 MinGW/);
  await assert.rejects(check(0, 'aarch64-w64-mingw32'), /MSYS2 MinGW x64/);
  await check(0, 'x86_64-w64-mingw32\n');
  await check(0, 'aarch64-w64-mingw32\n', 'arm64');
});

test('Windows linked thread runtime must match the source and license provenance', async () => {
  const expected = '13.0.0.r354.g40ab95d18-1';
  const check = (packageVersion) => assertCaptureWindowsToolchain({ shell: 'msys-bash', arch: 'x64', runtimePackageVersion: expected, tools: { run: async (_shell, args) => ({ status: 0, stderr: '', stdout: args[1].includes('gcc -dumpmachine') ? 'x86_64-w64-mingw32\n' : `mingw-w64-x86_64-winpthreads ${packageVersion}\n` }) } });
  assert.deepEqual(await check(expected), { toolchainPackage: 'mingw-w64-x86_64-winpthreads', toolchainPackageVersion: expected });
  await assert.rejects(check('14.0.0-1'), /Winpthreads 静态运行库必须匹配固定源码包/);
});

test('resource admission verifies recorded bytes, exact source archives, version and configuration', async (t) => {
  const f = fixture(t);
  const options = { platform: 'darwin', arch: 'arm64', tools: f.tools };
  assert.ok(await inspectCaptureResource(f.dir, options));
  fs.appendFileSync(path.join(f.resourceDir, 'ffmpeg'), 'tampered');
  assert.equal(await inspectCaptureResource(f.dir, options), null);
  f.record.sha256 = sha256(path.join(f.resourceDir, 'ffmpeg')); f.writeRecord();
  f.record.configuration = '--enable-gpl --enable-libx264'; f.writeRecord();
  assert.equal(await inspectCaptureResource(f.dir, options), null);
  f.record.configuration = '--disable-gpl --enable-nonfree'; f.writeRecord();
  assert.equal(await inspectCaptureResource(f.dir, options), null);
  f.record.configuration = '--disable-gpl --disable-nonfree'; f.writeRecord();
  fs.appendFileSync(path.join(f.dir, 'resources/capture/sources', f.lock.libvpx.archive), 'tampered');
  assert.equal(await inspectCaptureResource(f.dir, options), null);
});

test('missing or hashless capture resources cannot be admitted', async (t) => {
  const f = fixture(t);
  const options = { platform: 'darwin', arch: 'arm64', tools: f.tools };
  delete f.record.sha256; f.writeRecord();
  assert.equal(await inspectCaptureResource(f.dir, options), null);
  fs.rmSync(path.join(f.resourceDir, 'resource.json'));
  assert.equal(await inspectCaptureResource(f.dir, options), null);
  assert.equal(await inspectCaptureResource(f.dir, { platform: 'linux', arch: 'x64' }), null);
});

test('Windows reuse requires the actual linked runtime record and exact archive; macOS does not', async (t) => {
  const f = fixture(t, 'win32');
  const options = { platform: 'win32', arch: 'x64', tools: f.tools };
  assert.ok(await inspectCaptureResource(f.dir, options));
  const actual = structuredClone(f.record.sources.winpthreads);
  for (const field of ['version', 'toolchainPackageVersion', 'url', 'sha256', 'archive']) {
    f.record.sources.winpthreads = { ...actual, [field]: 'different' }; f.writeRecord();
    assert.equal(await inspectCaptureResource(f.dir, options), null, field);
  }
  delete f.record.sources.winpthreads; f.writeRecord();
  const before = fs.readFileSync(path.join(f.resourceDir, 'resource.json'), 'utf8');
  assert.equal(await inspectCaptureResource(f.dir, options), null);
  await assert.rejects(prepareCaptureResources(f.dir, { ...options, buildBinary: () => assert.fail('unknown existing resource must not be rewritten') }), /拒绝覆盖未知/);
  assert.equal(fs.readFileSync(path.join(f.resourceDir, 'resource.json'), 'utf8'), before);
  f.record.sources.winpthreads = actual; f.writeRecord();
  fs.appendFileSync(f.runtimeArchive, 'changed');
  assert.equal(await inspectCaptureResource(f.dir, options), null);
  fs.rmSync(f.runtimeArchive);
  assert.equal(await inspectCaptureResource(f.dir, options), null);
  const mac = fixture(t);
  assert.ok(await inspectCaptureResource(mac.dir, { platform: 'darwin', arch: 'arm64', tools: mac.tools }));
});

test('upgrading the Windows runtime manifest never relabels an older executable', async (t) => {
  const f = fixture(t, 'win32');
  const options = { platform: 'win32', arch: 'x64', tools: f.tools };
  const original = structuredClone(f.runtime);
  for (const field of ['version', 'toolchainPackageVersion', 'sourceUrl']) {
    Object.assign(f.runtime, original, { [field]: field === 'sourceUrl' ? 'https://example.test/new-source' : 'new-version' }); f.writeManifest();
    assert.equal(await inspectCaptureResource(f.dir, options), null, field);
  }
  Object.assign(f.runtime, original);
  fs.writeFileSync(f.runtimeArchive, 'new verified source archive');
  f.runtime.sourceSha256 = sha256(f.runtimeArchive); f.writeManifest();
  assert.equal(await inspectCaptureResource(f.dir, options), null);
});

test('Windows build results without observed runtime provenance are rejected before publishing', async (t) => {
  const f = fixture(t, 'win32');
  fs.rmSync(f.resourceDir, { recursive: true });
  await assert.rejects(prepareCaptureResources(f.dir, { platform: 'win32', arch: 'x64', tools: f.tools, buildBinary: async () => ({}) }), /缺少匹配的实际 Winpthreads 来源记录/);
  assert.equal(fs.existsSync(f.resourceDir), false);
});
