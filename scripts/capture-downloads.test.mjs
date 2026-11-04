import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { prepareCaptureDownloads } from './prepare-capture-downloads.mjs';

const bytes = Buffer.from('locked archive fixture');
const archive = 'ffmpeg-8.1.3.tar.xz';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-download-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'third-party'));
  fs.writeFileSync(path.join(root, 'third-party/capture-sources.json'), JSON.stringify({ ffmpeg: {
    archive, url: 'https://ffmpeg.org/releases/' + archive,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  } }));
  return { root, file: path.join(root, '.cache/client-toolchain/capture/downloads', archive) };
}
test('canonical network failure uses identical mirror bytes and cleans partial files', async t => {
  const f = fixture(t), urls = [];
  const options = { admitted: () => false, log: () => {}, fetcher: async url => {
    urls.push(url); if (urls.length === 1) throw new Error('connection reset');
    return new Response(bytes);
  } };
  assert.deepEqual(await prepareCaptureDownloads(f.root, options), { reused: false, mirror: true });
  assert.equal(urls[1], 'https://distfiles.macports.org/ffmpeg/' + archive);
  assert.deepEqual(fs.readFileSync(f.file), bytes);
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), [archive]);
  assert.deepEqual(await prepareCaptureDownloads(f.root, options), { reused: true });
  assert.equal(urls.length, 2, 'verified cache avoids further network access');
});
test('downloaded or cached bytes with a different hash fail closed', async t => {
  const f = fixture(t); let calls = 0;
  const options = { admitted: () => false, log: () => {}, fetcher: async () => { calls++; return new Response('tampered'); } };
  await assert.rejects(prepareCaptureDownloads(f.root, options), /SHA256/);
  assert.equal(calls, 1, 'integrity failures must not be hidden by retrying a mirror');
  assert.equal(fs.existsSync(f.file), false);
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), []);
  fs.writeFileSync(f.file, 'tampered cache');
  await assert.rejects(prepareCaptureDownloads(f.root, options), /SHA256/);
  assert.equal(calls, 1);
});
test('admitted compiler output needs no source download', async t => {
  const f = fixture(t);
  assert.deepEqual(await prepareCaptureDownloads(f.root, { admitted: () => true, fetcher: () => { throw new Error('unexpected network access'); } }), { reused: true });
});
