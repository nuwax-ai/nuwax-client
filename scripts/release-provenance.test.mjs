import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const original = new URL('./release-provenance.mjs', import.meta.url);
const keys = ['macos-arm64', 'macos-x64', 'windows-x64', 'linux-x64', 'linux-arm64'];
const frontend = 'a'.repeat(40);
const shell = 'b'.repeat(40);

function unsignedPe() {
  const file = Buffer.alloc(513);
  file.write('MZ');
  file.writeUInt32LE(0x80, 0x3c);
  file.write('PE\0\0', 0x80);
  file.writeUInt16LE(0x8664, 0x84);
  file.writeUInt16LE(0xf0, 0x94);
  file.writeUInt16LE(0x20b, 0x98);
  file.writeUInt32LE(16, 0x98 + 108);
  file[512] = 0x41;
  return file;
}

function signedPe(unsigned) {
  const certificateOffset = Math.ceil(unsigned.length / 8) * 8;
  const file = Buffer.concat([unsigned, Buffer.alloc(certificateOffset - unsigned.length), Buffer.alloc(32)]);
  file.writeUInt32LE(0x12345678, 0x98 + 64);
  file.writeUInt32LE(certificateOffset, 0x98 + 112 + 32);
  file.writeUInt32LE(32, 0x98 + 112 + 36);
  file.writeUInt32LE(32, certificateOffset);
  file.writeUInt16LE(0x200, certificateOffset + 4);
  file.writeUInt16LE(2, certificateOffset + 6);
  return file;
}

function fixture({ tag = 'electron-v1.0.32', channel = 'stable' } = {}) {
  const version = tag.replace(/^(electron|prerelease)-v|^v/, '');
  const root = mkdtempSync(join(tmpdir(), 'release-provenance-'));
  const scripts = join(root, 'scripts');
  const assets = join(root, 'assets');
  mkdirSync(scripts);
  mkdirSync(assets);
  copyFileSync(original, join(scripts, 'release-provenance.mjs'));
  copyFileSync(new URL('./release-version.mjs', import.meta.url), join(scripts, 'release-version.mjs'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  git('update-index', '--add', '--cacheinfo', `160000,${frontend},nuwax`);
  git('update-index', '--add', '--cacheinfo', `160000,${shell},nuwa-electron-shell`);
  git('commit', '-qm', 'fixture');
  const client = git('rev-parse', 'HEAD');
  mkdirSync(join(root, 'nuwax', 'dist'), { recursive: true });
  writeFileSync(join(root, 'nuwax', 'dist', 'version.json'), JSON.stringify({ gitHash: frontend.slice(0, 9) }));
  const windowsOutput = join(root, 'windows-output');
  mkdirSync(windowsOutput);
  const unsigned = unsignedPe();
  writeFileSync(join(windowsOutput, `Nuwax-Setup-${version}-unsigned.exe`), unsigned);
  const record = spawnSync(process.execPath,
    [join(scripts, 'release-provenance.mjs'), 'record', tag, 'windows', 'x64', windowsOutput],
    { cwd: root, encoding: 'utf8' });
  assert.equal(record.status, 0, record.stderr);
  copyFileSync(join(windowsOutput, 'build-manifest-windows-x64.json'),
    join(assets, 'build-manifest-windows-x64.json'));
  const distSha256 = JSON.parse(readFileSync(join(assets, 'build-manifest-windows-x64.json'), 'utf8')).frontend.distSha256;
  const signedDigest = createHash('sha256').update('signed fixture').digest('hex');
  const names = {
    'macos-arm64': ['Nuwax-1.0.32-arm64.dmg', 'Nuwax-1.0.32-arm64-mac.zip'],
    'macos-x64': ['Nuwax-1.0.32.dmg', 'Nuwax-1.0.32-mac.zip'],
    'windows-x64': ['Nuwax-Setup-1.0.32-unsigned.exe'],
    'linux-x64': ['Nuwax-1.0.32.AppImage'],
    'linux-arm64': ['Nuwax-1.0.32-arm64.AppImage'],
  };
  for (const key of keys) {
    names[key] = names[key].map(name => name.replaceAll('1.0.32', version));
    if (key === 'windows-x64') continue;
    const [platform, arch] = key.split('-');
    writeFileSync(join(assets, `build-manifest-${key}.json`), JSON.stringify({
      schemaVersion: 1,
      tag,
      source: { client, shell, frontend },
      frontend: { stamp: frontend.slice(0, 9), distSha256 },
      platform,
      arch,
      artifacts: Object.fromEntries(names[key].map((name) => [name, signedDigest])),
    }));
  }
  for (const name of Object.values(names).flat().filter((name) => !name.endsWith('-unsigned.exe'))) {
    writeFileSync(join(assets, name), 'signed fixture');
  }
  if (channel === 'beta') writeFileSync(join(assets, `Nuwax-Setup-${version}-unsigned.exe`), unsigned);
  else writeFileSync(join(assets, `Nuwax.Setup.${version}.exe`), signedPe(unsigned));
  for (const name of ['latest.yml', 'latest-mac.yml', 'latest-linux.yml',
    'latest-linux-arm64.yml', 'latest-linux-x64.yml']) {
    writeFileSync(join(assets, name), `version: ${version}\n`);
  }
  writeFileSync(join(assets, 'latest.json'), JSON.stringify({version}) + '\n');
  return { root, assets, unsigned, run: (extra = []) => spawnSync(process.execPath,
    [join(scripts, 'release-provenance.mjs'), 'verify', tag, assets, channel, ...extra],
    { cwd: root, encoding: 'utf8' }) };
}

test('verifies five platform source records and writes asset hashes', () => {
  const f = fixture();
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(readFileSync(join(f.assets, 'release-provenance.json'), 'utf8'));
    assert.equal(value.builds.length, 5);
    assert.match(value.assets['Nuwax.Setup.1.0.32.exe'], /^[0-9a-f]{64}$/);
    assert.equal(value.assets['latest-mac.yml'], createHash('sha256').update('version: 1.0.32\n').digest('hex'));
    assert.equal(value.assets['latest.json'], createHash('sha256').update('{"version":"1.0.32"}\n').digest('hex'));
    assert.equal(value.builds[2].windowsSigning.unsignedSize, f.unsigned.length);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('rejects a platform built from a different frontend commit', () => {
  const f = fixture();
  try {
    const path = join(f.assets, 'build-manifest-windows-x64.json');
    const value = JSON.parse(readFileSync(path, 'utf8'));
    value.source.frontend = 'd'.repeat(40);
    value.frontend.stamp = 'd'.repeat(9);
    writeFileSync(path, JSON.stringify(value));
    assert.notEqual(f.run().status, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('rejects a release without the signed Windows installer', () => {
  const f = fixture();
  try {
    rmSync(join(f.assets, 'Nuwax.Setup.1.0.32.exe'));
    assert.notEqual(f.run().status, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('rejects a signed EXE whose unsigned payload differs from the CI build', () => {
  const f = fixture();
  try {
    const path = join(f.assets, 'Nuwax.Setup.1.0.32.exe');
    const signed = readFileSync(path);
    signed[512] ^= 1;
    writeFileSync(path, signed);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /原始 PE 字节/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('rejects a forged certificate location rather than ignoring arbitrary bytes', () => {
  const f = fixture();
  try {
    const path = join(f.assets, 'Nuwax.Setup.1.0.32.exe');
    const signed = readFileSync(path);
    signed.writeUInt32LE(f.unsigned.length - 1, 0x98 + 112 + 32);
    writeFileSync(path, signed);
    assert.notEqual(f.run().status, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('rejects a Windows manifest without its CI unsigned signing identity', () => {
  const f = fixture();
  try {
    const path = join(f.assets, 'build-manifest-windows-x64.json');
    const value = JSON.parse(readFileSync(path, 'utf8'));
    delete value.windowsSigning;
    writeFileSync(path, JSON.stringify(value));
    assert.notEqual(f.run().status, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('rejects a changed unsigned EXE when the signer left it on the Release', () => {
  const f = fixture();
  try {
    const changed = Buffer.from(f.unsigned);
    changed[512] ^= 1;
    writeFileSync(join(f.assets, 'Nuwax-Setup-1.0.32-unsigned.exe'), changed);
    assert.notEqual(f.run().status, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('records the generated metadata bytes, not the original downloaded yml', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.assets, 'latest-mac.yml'), 'version: 1.0.32\nfiles:\n  - url: final.zip\n');
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(readFileSync(join(f.assets, 'release-provenance.json'), 'utf8'));
    assert.equal(value.assets['latest-mac.yml'],
      createHash('sha256').update('version: 1.0.32\nfiles:\n  - url: final.zip\n').digest('hex'));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('requires all final update metadata before writing provenance', () => {
  const f = fixture();
  try {
    rmSync(join(f.assets, 'latest-linux-arm64.yml'));
    assert.notEqual(f.run().status, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('rejects a missing macOS update zip even when its DMG is present', () => {
  const f = fixture();
  try {
    rmSync(join(f.assets, 'Nuwax-1.0.32-arm64-mac.zip'));
    assert.notEqual(f.run().status, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test('canonical beta provenance keeps the full version and unsigned installer identity', () => {
  const f = fixture({ tag: 'v1.0.32-beta.10', channel: 'beta' });
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(readFileSync(join(f.assets, 'release-provenance.json'), 'utf8'));
    assert.equal(value.tag, 'v1.0.32-beta.10');
    assert.ok(value.assets['Nuwax-Setup-1.0.32-beta.10-unsigned.exe']);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('current automation verifies a target source tree without tools in that tag', () => {
  const f = fixture({ tag: 'v1.0.32' });
  const automation = mkdtempSync(join(tmpdir(), 'release-automation-'));
  try {
    copyFileSync(original, join(automation, 'release-provenance.mjs'));
    copyFileSync(new URL('./release-version.mjs', import.meta.url), join(automation, 'release-version.mjs'));
    rmSync(join(f.root, 'scripts'), { recursive: true });
    const result = spawnSync(process.execPath, [join(automation, 'release-provenance.mjs'), 'verify', 'v1.0.32', f.assets, 'stable', '--source-root', f.root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(automation, { recursive: true, force: true });
  }
});
