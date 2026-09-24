import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/sync-electron-to-oss.yml', import.meta.url), 'utf8');

function runBlock(name) {
  const lines = workflow.split('\n');
  const step = lines.findIndex((line) => line === `      - name: ${name}`);
  assert.notEqual(step, -1, `workflow step ${name} exists`);
  const run = lines.findIndex((line, index) => index > step && line === '        run: |');
  assert.notEqual(run, -1);
  const block = [];
  for (let index = run + 1; index < lines.length; index++) {
    if (lines[index].startsWith('      - name: ')) break;
    assert.ok(lines[index] === '' || lines[index].startsWith('          '));
    block.push(lines[index].slice(10));
  }
  return block.join('\n');
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'release-mirrors-'));
  const assets = join(root, 'assets');
  const s3 = join(root, 's3');
  const oss = join(root, 'oss');
  const bin = join(root, 'bin');
  for (const dir of [assets, s3, oss, bin]) mkdirSync(dir);
  const contents = {
    'Nuwax.Setup.1.0.32.exe': 'signed installer fixture',
    'Nuwax-1.0.32.AppImage': 'linux installer fixture',
    'latest.json': '{"version":"1.0.32"}\n',
    'latest.yml': 'version: 1.0.32\n',
    'latest-mac.yml': 'version: 1.0.32\n',
    'latest-linux.yml': 'version: 1.0.32\n',
    'latest-linux-arm64.yml': 'version: 1.0.32\n',
    'latest-linux-x64.yml': 'version: 1.0.32\n',
  };
  const hashes = Object.fromEntries(Object.entries(contents).map(([name, content]) =>
    [name, createHash('sha256').update(content).digest('hex')]));
  for (const [name, content] of Object.entries(contents)) writeFileSync(join(assets, name), content);
  writeFileSync(join(assets, 'build-manifest-windows-x64.json'), '{}\n');
  writeFileSync(join(assets, 'release-provenance.json'), JSON.stringify({ assets: hashes }));
  for (const name of readdirSync(assets)) copyFileSync(join(assets, name), join(s3, name));
  for (const name of Object.keys(contents).filter((name) => name.endsWith('.yml') || name === 'latest.json')) {
    copyFileSync(join(assets, name), join(oss, name));
  }
  writeFileSync(join(bin, 'aws'), `#!/bin/sh
case " $* " in *" --no-sign-request "*) ;; *) echo 'signed S3 read forbidden' >&2; exit 23 ;; esac
if [ "$1" = s3api ] && [ "$2" = head-object ]; then
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --key ]; then name=$(basename "$2"); break; fi
    shift
  done
  [ -f "$MOCK_S3_DIR/$name" ] || exit 44
  exit 0
fi
[ "$1" = s3 ] && [ "$2" = cp ] && [ "$4" = - ] || exit 2
name=$(basename "$3")
cat "$MOCK_S3_DIR/$name" || exit
[ "$MOCK_S3_FAIL_NAME" != "$name" ] || exit 23
`, { mode: 0o755 });
  writeFileSync(join(bin, 'curl'), `#!/bin/sh
for arg in "$@"; do [ "$arg" != -o ] || exit 0; last="$arg"; done
name=$(basename "$last")
cat "$MOCK_OSS_DIR/$name" || exit
[ "$MOCK_OSS_FAIL_NAME" != "$name" ] || exit 23
`, { mode: 0o755 });
  const run = (step, extra = {}) => spawnSync('bash', ['-c', runBlock(step).replaceAll('/tmp/release-assets', assets)], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      MOCK_S3_DIR: s3, MOCK_OSS_DIR: oss,
      MOCK_S3_FAIL_NAME: '', MOCK_OSS_FAIL_NAME: '',
      RELEASE_TAG: 'electron-v1.0.32', RELEASE_CHANNEL: 'stable', RELEASE_ROOT: 'nuwax-electron',
      S3_CDN_BASE: 'https://s3.example.invalid', S3_BUCKET: 'test', S3_ENDPOINT: 'https://s3.example.invalid',
      OSS_CDN_BASE: 'https://oss.example.invalid',
      ...extra,
    },
  });
  return { root, assets, s3, oss, run };
}

test('S3 readback checks SHA256 of every uploaded file', () => {
  const f = fixture();
  try {
    const result = f.run('Verify S3 upload');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /S3 versioned assets verified/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('S3 rejects an installer changed without changing ContentLength', () => {
  const f = fixture();
  try {
    const path = join(f.s3, 'Nuwax.Setup.1.0.32.exe');
    const changed = readFileSync(path);
    changed[0] ^= 1;
    writeFileSync(path, changed);
    const result = f.run('Verify S3 upload');
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /S3 资产 SHA256 不一致/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('S3 readback fails if the stream command fails after emitting valid bytes', () => {
  const f = fixture();
  try {
    const result = f.run('Verify S3 upload', { MOCK_S3_FAIL_NAME: 'Nuwax.Setup.1.0.32.exe' });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /S3 versioned assets verified/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('OSS readback checks every yml and latest.json', () => {
  const f = fixture();
  try {
    const result = f.run('Verify versioned OSS metadata');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /OSS versioned metadata verified/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('OSS rejects a same-size change to a non-mac update yml', () => {
  const f = fixture();
  try {
    const path = join(f.oss, 'latest-linux-arm64.yml');
    const changed = readFileSync(path);
    changed[0] ^= 1;
    writeFileSync(path, changed);
    const result = f.run('Verify versioned OSS metadata');
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /OSS 元数据 SHA256 不一致/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('OSS readback fails if curl fails after emitting valid bytes', () => {
  const f = fixture();
  try {
    const result = f.run('Verify versioned OSS metadata', { MOCK_OSS_FAIL_NAME: 'latest-linux-arm64.yml' });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /OSS versioned metadata verified/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
