import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureBuildArguments, captureResourceDir, inspectCaptureResource, readCaptureSourceLock, sha256 } from './client/capture-resources.mjs';

const root = path.resolve(import.meta.dirname, '..');
const locked = readCaptureSourceLock(root);
function fixture(t) {
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
  const resourceDir = captureResourceDir(dir, 'darwin', 'arm64');
  fs.mkdirSync(resourceDir, { recursive: true });
  fs.writeFileSync(path.join(resourceDir, 'ffmpeg'), 'fixture binary');
  const record = { schema: 1, platform: 'darwin', arch: 'arm64', version: lock.ffmpeg.version, sha256: sha256(path.join(resourceDir, 'ffmpeg')), configuration: '--disable-gpl --disable-nonfree --enable-videotoolbox', sources: lock };
  const writeRecord = () => fs.writeFileSync(path.join(resourceDir, 'resource.json'), JSON.stringify(record));
  writeRecord();
  const tools = { readJson: (file) => JSON.parse(fs.readFileSync(file, 'utf8')), run: async () => ({ status: 0, stdout: `ffmpeg version ${lock.ffmpeg.version} fixture\nconfiguration: ${record.configuration}\n` }) };
  return { dir, resourceDir, record, writeRecord, tools, lock };
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
    assert.ok(args.ffmpeg.some((arg) => arg.includes('libvpx_vp9,gif')));
    assert.ok(args.ffmpeg.some((arg) => arg.includes('palettegen,paletteuse')));
    assert.doesNotMatch(args.ffmpeg.join(' '), /x264|enable-gpl|enable-nonfree/);
  }
  assert.throws(() => captureBuildArguments(locked, { platform: 'linux', arch: 'x64', prefix: '/prefix' }), /不支持/);
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
