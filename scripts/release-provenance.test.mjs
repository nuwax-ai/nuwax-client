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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'release-provenance-'));
  const scripts = join(root, 'scripts');
  const assets = join(root, 'assets');
  mkdirSync(scripts);
  mkdirSync(assets);
  copyFileSync(original, join(scripts, 'release-provenance.mjs'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  git('update-index', '--add', '--cacheinfo', `160000,${frontend},nuwax`);
  git('update-index', '--add', '--cacheinfo', `160000,${shell},nuwa-electron-shell`);
  git('commit', '-qm', 'fixture');
  const client = git('rev-parse', 'HEAD');
  const signedDigest = createHash('sha256').update('signed fixture').digest('hex');
  const names = {
    'macos-arm64': ['Nuwax-1.0.32-arm64.dmg', 'Nuwax-1.0.32-arm64-mac.zip'],
    'macos-x64': ['Nuwax-1.0.32.dmg', 'Nuwax-1.0.32-mac.zip'],
    'windows-x64': ['Nuwax-Setup-1.0.32-unsigned.exe'],
    'linux-x64': ['Nuwax-1.0.32.AppImage'],
    'linux-arm64': ['Nuwax-1.0.32-arm64.AppImage'],
  };
  for (const key of keys) {
    const [platform, arch] = key.split('-');
    writeFileSync(join(assets, `build-manifest-${key}.json`), JSON.stringify({
      schemaVersion: 1,
      tag: 'prerelease-v1.0.32',
      source: { client, shell, frontend },
      frontend: { stamp: frontend.slice(0, 9), distSha256: 'c'.repeat(64) },
      platform,
      arch,
      artifacts: Object.fromEntries(names[key].map((name) => [name, signedDigest])),
    }));
  }
  for (const name of [...Object.values(names).flat().filter((name) => !name.endsWith('-unsigned.exe')),
    'Nuwax.Setup.1.0.32.exe']) {
    writeFileSync(join(assets, name), 'signed fixture');
  }
  return { root, assets, run: () => spawnSync(process.execPath,
    [join(scripts, 'release-provenance.mjs'), 'verify', 'prerelease-v1.0.32', assets],
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

test('rejects a missing macOS update zip even when its DMG is present', () => {
  const f = fixture();
  try {
    rmSync(join(f.assets, 'Nuwax-1.0.32-arm64-mac.zip'));
    assert.notEqual(f.run().status, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
