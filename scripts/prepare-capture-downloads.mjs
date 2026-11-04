import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as core from './client/core.mjs';
import { inspectCaptureResource } from './client/capture-resources.mjs';

class IntegrityError extends Error {}

/** Transport only: canonical bytes still pass the existing capture admission.
 * Keep this outside native recipes, so mirror availability cannot invalidate
 * already admitted compiler outputs. */
export async function prepareCaptureDownloads(root, {
  fetcher = fetch, admitted = () => inspectCaptureResource(root), log = console.log,
} = {}) {
  if (await admitted()) return { reused: true };
  const source = core.readJson(path.join(root, 'third-party/capture-sources.json')).ffmpeg;
  if (!source || !/^ffmpeg-[\d.]+\.tar\.xz$/.test(source.archive) ||
      !/^[a-f0-9]{64}$/.test(source.sha256) ||
      source.url !== 'https://ffmpeg.org/releases/' + source.archive) {
    throw new Error('[capture-download] Expected a locked canonical FFmpeg archive');
  }
  const file = path.join(core.paths(root).cache, 'capture/downloads', source.archive);
  if (fs.existsSync(file)) {
    if (core.fileHash(file) !== source.sha256) throw new IntegrityError('[capture-download] Cached archive failed SHA256 verification');
    return { reused: true };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const urls = [source.url, 'https://distfiles.macports.org/ffmpeg/' + source.archive];
  for (const [index, url] of urls.entries()) {
    const temporary = file + '.' + randomUUID() + '.part';
    try {
      const signal = AbortSignal.timeout(20000);
      const response = await fetcher(url, { signal, redirect: 'follow' });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error('Archive endpoint refused the request');
      }
      let bytes = 0;
      const bound = new Transform({ transform(chunk, _encoding, done) {
        bytes += chunk.length;
        done(bytes > 128 * 1024 * 1024 ? new Error('Archive exceeds download limit') : null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), bound, fs.createWriteStream(temporary, { flags: 'wx' }), { signal });
      if (core.fileHash(temporary) !== source.sha256) throw new IntegrityError('[capture-download] Download failed SHA256 verification');
      fs.renameSync(temporary, file);
      log('[capture-download] Admitted locked FFmpeg archive from ' + new URL(url).hostname);
      return { reused: false, mirror: index > 0 };
    } catch (error) {
      if (error instanceof IntegrityError) throw error;
      if (index === urls.length - 1) throw new Error('[capture-download] Canonical and mirror downloads failed');
      log('[capture-download] Canonical endpoint unavailable; trying verified-byte mirror');
    } finally { fs.rmSync(temporary, { force: true }); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await prepareCaptureDownloads(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
}
