import fs from 'node:fs';
import path from 'node:path';
import config from '../../client.config.mjs';
import * as core from './core.mjs';

// Windows 构建垫片：前端 upgrade/sync micro-apps 以绝对路径调 `tar -xf`，Git Bash 的 GNU tar
// 会把 `D:\...` 盘符冒号解析为远程主机（tar: Cannot connect to D:，CI win 五连挂实测）。
// 仅 win32 在 build 前给前端工作树打运行时补丁（--force-local + 正斜杠）；mac bsdtar 不认
// --force-local 故保留原分支。前端仓根治后删除本函数即可。
const TAR_CALL = "execute('tar', ['-xf', archive, '-C', working]";
const TAR_PATCHED = "execute('tar', process.platform === 'win32' ? ['-xf', '--force-local', String(archive).replaceAll('\\\\', '/'), '-C', String(working).replaceAll('\\\\', '/')] : ['-xf', archive, '-C', working]";
export function patchWindowsTar(frontend) {
  if (process.platform !== 'win32') return;
  for (const file of ['scripts/upgrade-micro-apps.mjs', 'scripts/sync-micro-apps.mjs']) {
    const target = path.join(frontend, file);
    let source = fs.readFileSync(target, 'utf8');
    if (source.includes(TAR_PATCHED)) continue;
    if (!source.includes(TAR_CALL)) throw new Error(`win tar 垫片定位失败：${file}（前端仓源码已变？请同步垫片）`);
    fs.writeFileSync(target, source.replace(TAR_CALL, TAR_PATCHED));
    console.log('[frontend] win tar 垫片已打：' + file);
  }
}

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
  patchWindowsTar(frontend);
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
