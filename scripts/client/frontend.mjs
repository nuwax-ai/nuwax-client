import fs from 'node:fs';
import path from 'node:path';
import config from '../../client.config.mjs';
import * as core from './core.mjs';

export async function cleanFrontendDist(root, options = {}) {
  const tools = { ...core, ...options.tools };
  const { frontend } = tools.paths(root);
  if (await tools.git(frontend, ['ls-files', 'dist'])) await tools.git(frontend, ['restore', '--worktree', '--', 'dist']);
  await tools.git(frontend, ['clean', '-fdx', '--', 'dist']);
}

/** Build current source. Only update/release callers enforce a committed source SHA. */
export async function buildFrontend(root, options = {}) {
  const tools = { ...core, ...options.tools };
  const { frontend, cache } = tools.paths(root);
  if (!fs.existsSync(path.join(frontend, '.git'))) {
    if (options.dryRun) return { planned: true, distDir: path.join(frontend, 'dist') };
    await tools.git(root, ['submodule', 'update', '--init', '--depth', '1', '--', 'nuwax']);
  }
  const sourceSha = await tools.git(frontend, ['rev-parse', 'HEAD']);
  const expected = options.expectedSha ? await tools.git(frontend, ['rev-parse', options.expectedSha + '^{commit}']) : sourceSha;
  if (sourceSha !== expected) throw new Error('nuwax HEAD does not match expected SHA: ' + expected);
  const stamp = await tools.git(frontend, ['rev-parse', '--short', 'HEAD']);
  const sourceStatus = await tools.git(frontend, ['status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude)dist', ':(exclude)dist/**']);
  const dirty = Boolean(sourceStatus);
  if (dirty && options.allowDirty === false) throw new Error('nuwax has source edits; commit them before publishing dist');
  const distDir = path.join(frontend, 'dist');
  if (options.dryRun) {
    console.log('[frontend] plan: frozen install → build:prod → verify index/version at ' + distDir);
    return { sourceSha, stamp, distDir, dirty, planned: true };
  }
  const generated = path.join(frontend, 'src', 'constants', 'version.ts');
  const original = fs.existsSync(generated) ? fs.readFileSync(generated) : null;
  const key = tools.fingerprint([tools.fileHash(path.join(frontend, 'package.json')), tools.fileHash(path.join(frontend, 'pnpm-lock.yaml')),
    process.platform, process.arch, process.version]);
  const marker = path.join(cache, 'frontend-install.json');
  try {
    let previous = {};
    try { previous = tools.readJson(marker); } catch { /* missing/corrupt cache is rebuilt */ }
    if (previous.key !== key || !fs.existsSync(path.join(frontend, 'node_modules', '.modules.yaml'))) {
      await tools.pnpmRun(frontend, ['install', '--frozen-lockfile']);
      await tools.atomicJson(marker, { key });
    } else console.log('[frontend] dependencies cached');
    await tools.pnpmRun(frontend, ['build:prod'], { env: {
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? config.frontend.buildNodeOptions,
    } });
    if (!fs.existsSync(path.join(distDir, 'index.html')) || !fs.statSync(path.join(distDir, 'index.html')).isFile() || !fs.statSync(path.join(distDir, 'index.html')).size)
      throw new Error('frontend build did not produce index.html');
    const actual = tools.readJson(path.join(distDir, 'version.json')).gitHash;
    if (actual !== stamp) throw new Error('frontend stamp ' + actual + ' differs from source ' + stamp);
    console.log('[frontend] ready: ' + distDir + ' @ ' + sourceSha + (dirty ? ' (local source edits)' : ''));
    return { sourceSha, stamp, distDir, dirty };
  } finally {
    if (options.restoreGenerated !== false) {
      if (original) fs.writeFileSync(generated, original);
      else fs.rmSync(generated, { force: true });
    }
    if (options.cleanDist) await cleanFrontendDist(root, { tools });
  }
}

export async function preparePinnedFrontend(root, options = {}) {
  const tools = { ...core, ...options.tools };
  const expectedSha = options.expectedSha || process.env.NUWAX_DIST_EXPECTED_SHA || await tools.git(root, ['rev-parse', 'HEAD:nuwax']);
  if (process.env.SKIP_NUWAX_BUILD === '1') {
    const { frontend } = tools.paths(root);
    const expected = await tools.git(frontend, ['rev-parse', expectedSha + '^{commit}']);
    if (await tools.git(frontend, ['rev-parse', 'HEAD']) !== expected) throw new Error('nuwax differs from source gitlink');
    console.log('[frontend] source verified; SKIP_NUWAX_BUILD=1');
    return;
  }
  return buildFrontend(root, { ...options, expectedSha, allowDirty: false, tools });
}
