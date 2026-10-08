import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileChecksums, mapLimit, recordChecksums, S3_PART_SIZE, verifyS3Asset } from './release-storage-integrity.mjs';

const sha = (value) => createHash('sha256').update(value).digest();
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));

test('SHA256 upload records match single-part and multipart boundary contracts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 's3-checksum-'));
  try {
    for (const size of [0, S3_PART_SIZE - 1, S3_PART_SIZE, S3_PART_SIZE + 1, S3_PART_SIZE * 2]) {
      const bytes = Buffer.alloc(size, 97), file = path.join(root, 'asset');
      await writeFile(file, bytes);
      const record = await fileChecksums(file);
      assert.equal(record.sha256, sha(bytes).toString('hex'));
      assert.equal(record.size, size);
      if (size < S3_PART_SIZE) {
        assert.equal(record.checksumType, 'FULL_OBJECT');
        assert.equal(record.checksumSHA256, sha(bytes).toString('base64'));
      } else {
        const parts = [];
        for (let offset = 0; offset < size; offset += S3_PART_SIZE) parts.push(sha(bytes.subarray(offset, offset + S3_PART_SIZE)));
        assert.equal(record.checksumType, 'COMPOSITE');
        assert.equal(record.checksumSHA256, `${sha(Buffer.concat(parts)).toString('base64')}-${parts.length}`);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('recording binds storage checksums to verified provenance and never self-hashes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 's3-provenance-'));
  const bytes = Buffer.from('installer');
  try {
    await writeFile(path.join(root, 'installer.exe'), bytes);
    const file = path.join(root, 'release-provenance.json');
    await writeFile(file, JSON.stringify({ assets: { 'installer.exe': sha(bytes).toString('hex') } }));
    await recordChecksums(root);
    const value = JSON.parse(await readFile(file));
    assert.equal(value.s3Checksums['installer.exe'].checksumSHA256, sha(bytes).toString('base64'));
    assert.equal(value.s3Checksums['release-provenance.json'], undefined);
    await writeFile(path.join(root, 'installer.exe'), 'Installer');
    await assert.rejects(recordChecksums(root), /本地资产与来源清单 SHA256 不一致/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function serverFixture(action) {
  const bytes = Buffer.from('fixture content');
  const checksum = { sha256: sha(bytes).toString('hex'), size: bytes.length, checksumType: 'FULL_OBJECT', checksumSHA256: sha(bytes).toString('base64') };
  const state = { checksum: checksum.checksumSHA256, size: bytes.length, status: 200, gets: 0, heads: 0, corrupt: false, truncated: false, type: 'FULL_OBJECT' };
  const server = createServer((req, res) => {
    if (req.method === 'HEAD') {
      state.heads++; assert.equal(req.headers['x-amz-checksum-mode'], 'ENABLED');
      res.statusCode = state.status; res.setHeader('content-length', state.size);
      if (state.checksum) res.setHeader('x-amz-checksum-sha256', state.checksum);
      res.setHeader('x-amz-checksum-type', state.type); res.end();
    } else {
      state.gets++; res.setHeader('content-length', bytes.length + (state.truncated ? 100 : 0));
      if (state.truncated) { res.write(bytes); setTimeout(() => res.destroy(), 5); }
      else res.end(state.corrupt ? Buffer.from('Fixture content') : bytes);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/installer.exe`;
  try { await action({ state, url, expected: { sha256: checksum.sha256, size: checksum.size, checksum }, verify: (expected) => verifyS3Asset(url, expected, { log: () => {} }) }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('matching server SHA256 needs HEAD only', async () => serverFixture(async ({ state, expected, verify }) => {
  assert.match(await verify(expected), /服务端 SHA256/);
  assert.equal(state.heads, 1); assert.equal(state.gets, 0);
}));

test('checksum, size and descriptor mismatches fail without fallback downloads', async () => serverFixture(async ({ state, expected, verify }) => {
  state.checksum = sha('same-size corruption').toString('base64');
  await assert.rejects(verify(expected), /S3 资产 SHA256 不一致/);
  state.size++;
  await assert.rejects(verify(expected), /S3 资产大小不一致/);
  await assert.rejects(verify({ ...expected, checksum: { ...expected.checksum, sha256: '0'.repeat(64) } }), /校验记录与资产不一致/);
  assert.equal(state.gets, 0);
}));

test('multipart composite SHA256 uses its recorded checksum and part count', async () => serverFixture(async ({ state, expected, verify }) => {
  const value = `${sha(sha('fixture content')).toString('base64')}-1`;
  state.type = 'COMPOSITE'; state.checksum = value;
  const multi = { ...expected, checksum: { ...expected.checksum, checksumType: 'COMPOSITE', checksumSHA256: value } };
  assert.match(await verify(multi), /COMPOSITE/);
  state.checksum = value.replace('-1', '-2');
  await assert.rejects(verify(multi), /SHA256 不一致/);
  assert.equal(state.gets, 0);
}));

test('missing checksum or unsupported checksum-mode falls back to a full SHA256 read', async () => serverFixture(async ({ state, expected, verify }) => {
  state.checksum = null;
  assert.equal(await verify(expected), '完整读回 SHA256');
  state.status = 501;
  assert.equal(await verify(expected), '完整读回 SHA256');
  state.status = 403;
  await assert.rejects(verify(expected), /HEAD HTTP 403/);
  assert.equal(state.gets, 2);
}));

test('legacy readback rejects same-size corruption and interrupted streams', async () => serverFixture(async ({ state, expected, verify }) => {
  const legacy = { ...expected, checksum: undefined };
  state.corrupt = true;
  await assert.rejects(verify(legacy), /SHA256 不一致/);
  state.corrupt = false; state.truncated = true;
  await assert.rejects(verify(legacy));
  assert.equal(state.heads, 0);
}));

test('bounded reads preserve order and drain started work before rejecting', async () => {
  let active = 0, maximum = 0, completed = 0;
  assert.deepEqual(await mapLimit([1, 2, 3, 4, 5, 6], 4, async value => {
    maximum = Math.max(maximum, ++active); await pause(5); active--; return value;
  }), [1, 2, 3, 4, 5, 6]);
  assert.equal(maximum, 4);
  await assert.rejects(mapLimit([0, 1, 2, 3, 4, 5], 4, async value => {
    active++; await pause(value === 0 ? 1 : 15); active--; completed++;
    if (value === 0) throw new Error('read failed');
  }), /read failed/);
  assert.equal(active, 0); assert.equal(completed, 4);
});
