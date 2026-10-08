import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Keep these in sync with awscli's classic transfer configuration in the workflow.
export const S3_PART_SIZE = 8 * 1024 * 1024;
export const VERIFY_CONCURRENCY = 4;
const digest = () => createHash('sha256');
const hashPattern = /^[a-f0-9]{64}$/;

export async function mapLimit(items, limit, action) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('无效校验并发数');
  let index = 0, failure;
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(items.length, limit) }, async () => {
    while (!failure && index < items.length) {
      const current = index++;
      try { results[current] = await action(items[current], current); }
      catch (error) { failure ??= error; }
    }
  }));
  // Drain all started reads before rejecting; callers must not publish on partial success.
  if (failure) throw failure;
  return results;
}

export async function fileChecksums(file) {
  const { size } = await stat(file);
  if (Math.ceil(size / S3_PART_SIZE) > 10000) throw new Error('资产超过固定 S3 分片上限');
  const whole = digest(), composite = digest();
  let part = digest(), partBytes = 0, count = 0, bytes = 0;
  for await (const chunk of createReadStream(file)) {
    whole.update(chunk); bytes += chunk.length;
    for (let offset = 0; offset < chunk.length;) {
      const end = Math.min(chunk.length, offset + S3_PART_SIZE - partBytes);
      part.update(chunk.subarray(offset, end)); partBytes += end - offset; offset = end;
      if (partBytes === S3_PART_SIZE) {
        composite.update(part.digest()); count++; part = digest(); partBytes = 0;
      }
    }
  }
  if (bytes !== size) throw new Error(`计算校验值期间文件大小变化: ${file}`);
  if (partBytes) { composite.update(part.digest()); count++; }
  const sha256 = whole.digest('hex');
  return { sha256, size, checksumType: size >= S3_PART_SIZE ? 'COMPOSITE' : 'FULL_OBJECT',
    checksumSHA256: size >= S3_PART_SIZE ? `${composite.digest('base64')}-${count}` : Buffer.from(sha256, 'hex').toString('base64') };
}

function validName(name) {
  if (!name || /[\\/]/.test(name) || path.basename(name) !== name || name === '.' || name === '..')
    throw new Error(`无效资产路径: ${name}`);
}

export async function recordChecksums(directory) {
  const file = path.join(directory, 'release-provenance.json');
  const provenance = JSON.parse(await readFile(file, 'utf8'));
  const records = {};
  for (const name of await readdir(directory)) {
    validName(name);
    // The provenance cannot contain its own digest; it is small and always read back.
    if (name === 'release-provenance.json') continue;
    const record = await fileChecksums(path.join(directory, name));
    if (!name.startsWith('build-manifest-') && record.sha256 !== provenance.assets?.[name])
      throw new Error(`本地资产与来源清单 SHA256 不一致: ${name}`);
    records[name] = record;
  }
  provenance.s3Checksums = records;
  await writeFile(file, `${JSON.stringify(provenance, null, 2)}\n`);
}

export async function hashResponse(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  const hash = digest();
  for await (const chunk of response.body) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyS3Asset(url, expected, { fetchImpl = fetch, hashUrl = hashResponse, log = console.log } = {}) {
  const start = Date.now(), name = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
  const { sha256, size, checksum } = expected;
  if (!hashPattern.test(sha256)) throw new Error(`缺少有效 SHA256: ${name}`);
  let mode = '完整读回 SHA256';
  if (checksum) {
    if (checksum.sha256 !== sha256 || checksum.size !== size || !Number.isSafeInteger(size) || size < 0 ||
        !['FULL_OBJECT', 'COMPOSITE'].includes(checksum.checksumType) ||
        !/^[A-Za-z0-9+/]{43}=(?:-[1-9]\d*)?$/.test(checksum.checksumSHA256 ?? '') ||
        (checksum.checksumType === 'COMPOSITE') !== /-\d+$/.test(checksum.checksumSHA256))
      throw new Error(`S3 校验记录与资产不一致: ${name}`);
    const head = await fetchImpl(url, { method: 'HEAD', headers: { 'x-amz-checksum-mode': 'ENABLED' }, signal: AbortSignal.timeout(60000) });
    // Older compatible stores may reject checksum-mode; they still need a full SHA256 read.
    if (!head.ok && ![400, 405, 501].includes(head.status)) throw new Error(`S3 HEAD HTTP ${head.status}: ${name}`);
    if (head.ok) {
      const length = head.headers.get('content-length');
      if (length !== null && Number(length) !== size) throw new Error(`S3 资产大小不一致: ${name}`);
      const actual = head.headers.get('x-amz-checksum-sha256');
      if (actual) {
        const type = head.headers.get('x-amz-checksum-type') ?? (/-\d+$/.test(actual) ? 'COMPOSITE' : 'FULL_OBJECT');
        // A copy may convert multipart to full-object SHA256 without changing the bytes.
        const wanted = type === 'FULL_OBJECT' ? Buffer.from(sha256, 'hex').toString('base64') : checksum.checksumSHA256;
        if (!['COMPOSITE', 'FULL_OBJECT'].includes(type) || actual !== wanted)
          throw new Error(`S3 资产 SHA256 不一致: ${name}`);
        if (length !== null) mode = `服务端 SHA256 ${type}`;
      }
    }
  }
  log(`[S3 verify] ${name}: ${mode}`);
  if (mode === '完整读回 SHA256' && await hashUrl(url) !== sha256) throw new Error(`S3 资产 SHA256 不一致: ${name}`);
  log(`[S3 verified] ${name}: ${mode}, ${((Date.now() - start) / 1000).toFixed(1)}s`);
  return mode;
}

async function awsReadHash(url, prefix) {
  const name = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
  const child = spawn('aws', ['s3', 'cp', `s3://${process.env.S3_BUCKET}/${prefix}/${name}`, '-',
    '--endpoint-url', process.env.S3_ENDPOINT, '--no-sign-request', '--quiet'], { stdio: ['ignore', 'pipe', 'pipe'] });
  // Observe close before consuming stdout, including a late nonzero exit after valid bytes.
  const done = new Promise((resolve) => { child.on('error', (error) => resolve({ error })); child.on('close', (code) => resolve({ code })); });
  let errorOutput = '';
  child.stderr.on('data', (chunk) => { errorOutput = (errorOutput + chunk).slice(-4000); });
  const hash = digest();
  try { for await (const chunk of child.stdout) hash.update(chunk); }
  catch (error) { child.kill(); await done.catch(() => {}); throw error; }
  const result = await done;
  if (result.code !== 0) throw new Error(`S3 读取失败: ${name}; ${result.error?.message ?? errorOutput.trim()}`);
  return hash.digest('hex');
}

export async function verifyDirectory(directory) {
  const provenance = JSON.parse(await readFile(path.join(directory, 'release-provenance.json'), 'utf8'));
  const prefix = `${process.env.RELEASE_ROOT}/${process.env.RELEASE_CHANNEL === 'beta' ? 'beta-build/' : ''}${process.env.RELEASE_TAG}`;
  const base = `${process.env.S3_CDN_BASE}/${prefix}`;
  const entries = await readdir(directory);
  await mapLimit(entries, VERIFY_CONCURRENCY, async (name) => {
    validName(name);
    const { size } = await stat(path.join(directory, name));
    const special = name.startsWith('build-manifest-') || name === 'release-provenance.json';
    const sha256 = special ? (await fileChecksums(path.join(directory, name))).sha256 : provenance.assets?.[name];
    await verifyS3Asset(`${base}/${encodeURIComponent(name)}`, { sha256, size, checksum: provenance.s3Checksums?.[name] },
      { hashUrl: (url) => awsReadHash(url, prefix) });
  });
  console.log('==> S3 versioned assets verified');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, directory] = process.argv.slice(2);
  if (!directory || !['record', 'verify'].includes(command)) throw new Error('用法: release-storage-integrity.mjs <record|verify> <assets-dir>');
  await (command === 'record' ? recordChecksums(directory) : verifyDirectory(directory));
}
