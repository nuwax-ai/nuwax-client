import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pointer-cli-'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  const mock = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2), root = process.env.MOCK_ROOT;
if (tool === 'gh') { fs.appendFileSync(path.join(root, 'trace'), 'publish\\n'); process.exit(0); }
const mirror = tool === 'aws' ? 's3' : 'oss';
const offset = mirror === 's3' ? 2 : 2;
const source = args[offset], target = args[offset + 1];
const location = (value) => path.join(root, mirror + '-' + /\\/(latest|beta)\\/latest.json$/.exec(value)[1]);
const action = mirror === 's3' ? args[1] : args[0];
if (action === 'rm') { fs.rmSync(location(source), { force: true }); process.exit(0); }
const read = /^(s3|oss):/.test(source);
const object = location(read ? source : target);
if (read && !fs.existsSync(object)) { console.error('404 NoSuchKey'); process.exit(1); }
fs.copyFileSync(read ? object : source, read ? target : object);
if (!read) {
  fs.appendFileSync(path.join(root, 'trace'), path.basename(object) + '\\n');
  if (process.env.MOCK_FAIL === path.basename(object) && !fs.existsSync(path.join(root, 'failed'))) {
    fs.writeFileSync(path.join(root, 'failed'), '1'); process.exit(1);
  }
}
`;
  for (const command of ['aws', 'ossutil', 'gh']) writeFileSync(join(bin, command), mock, { mode: 0o755 });
  const old = Buffer.from('{"version":"3.0.9"}');
  for (const mirror of ['s3', 'oss']) for (const folder of ['latest', 'beta']) writeFileSync(join(root, `${mirror}-${folder}`), old);
  const metadata = join(root, 'candidate.json'); writeFileSync(metadata, '{"version":"3.0.10"}');
  const run = (extra = {}, channel = 'stable') => spawnSync(process.execPath,
    [new URL('./publish-release-pointers.mjs', import.meta.url).pathname, 'v3.0.10', metadata, channel], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_ROOT: root,
        S3_ENDPOINT: 'https://s3.invalid', S3_BUCKET: 'bucket', OSS_BUCKET: 'oss://bucket', OSS_ENDPOINT: 'https://oss.invalid',
        OSS_REGION: 'region', OSS_ACCESS_KEY_ID: 'fixture-key', OSS_ACCESS_KEY_SECRET: 'fixture-secret',
        GITHUB_REPOSITORY: 'example/client', RELEASE_ROOT: 'nuwax-electron', ...extra },
    });
  return { root, run, old };
}

test('production CLI writes both mirror subscriptions then publishes, and rejects conflicts before commands', () => {
  const f = fixture();
  try {
    const conflict = f.run({}, 'beta');
    assert.notEqual(conflict.status, 0);
    assert.equal(existsSync(join(f.root, 'trace')), false);
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(join(f.root, 'trace'), 'utf8').trim().split('\n'), ['s3-latest', 'oss-latest', 's3-beta', 'oss-beta', 'publish']);
    for (const name of ['s3-latest', 'oss-latest', 's3-beta', 'oss-beta']) assert.equal(JSON.parse(readFileSync(join(f.root, name))).version, '3.0.10');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('a real child-command failure restores every modified mirror and never publishes', () => {
  const f = fixture();
  try {
    const result = f.run({ MOCK_FAIL: 'oss-beta' });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /fixture-secret/);
    assert.doesNotMatch(readFileSync(join(f.root, 'trace'), 'utf8'), /publish/);
    for (const name of ['s3-latest', 'oss-latest', 's3-beta', 'oss-beta']) assert.deepEqual(readFileSync(join(f.root, name)), f.old);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
