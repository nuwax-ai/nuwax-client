import fs from 'node:fs';
import path from 'node:path';
import config from '../../client.config.mjs';
import * as core from './core.mjs';

// Windows 构建垫片：前端 upgrade/sync micro-apps 的两处 Windows 兼容缺陷（CI win 连挂实测）——
// ① tar -xf 绝对路径：Git Bash GNU tar 把 `D:\...` 盘符冒号解析为远程主机（Cannot connect to D:），
//    补丁=--force-local 前置+正斜杠（mac bsdtar 不认 --force-local 故保留原分支）；
// ② spawn('corepack', shell:false)：win 上 corepack 只有 .cmd shim，CreateProcess 直呼 ENOENT，
//    补丁=win 走 cmd.exe /c corepack。
// 仅 win32 在 build 前给前端工作树打运行时补丁；前端仓根治后删除本函数即可。
const TAR_CALL = "execute('tar', ['-xf', archive, '-C', working]";
const TAR_PATCHED = "execute('tar', process.platform === 'win32' ? ['--force-local', '-xf', String(archive).replaceAll('\\\\', '/'), '-C', String(working).replaceAll('\\\\', '/')] : ['-xf', archive, '-C', working]";
const CP_CALL = "execute('corepack', [packages.packageManager, ...args], options)";
const CP_PATCHED = "execute(process.platform === 'win32' ? 'cmd.exe' : 'corepack', process.platform === 'win32' ? ['/c', 'corepack', packages.packageManager, ...args] : [packages.packageManager, ...args], options)";
function patchFile(frontend, file, pairs) {
  const target = path.join(frontend, file);
  let source = fs.readFileSync(target, 'utf8');
  for (const [call, patched] of pairs) {
    if (source.includes(patched)) continue;
    if (!source.includes(call)) throw new Error(`win 垫片定位失败：${file} 的 ${call.slice(0, 40)}…（前端仓源码已变？请同步垫片）`);
    source = source.replace(call, patched);
  }
  fs.writeFileSync(target, source);
  console.log('[frontend] win 垫片已打：' + file);
}
export function patchWindowsTar(frontend) {
  if (process.platform !== 'win32') return;
  patchFile(frontend, 'scripts/upgrade-micro-apps.mjs', [[TAR_CALL, TAR_PATCHED]]);
  patchFile(frontend, 'scripts/sync-micro-apps.mjs', [[TAR_CALL, TAR_PATCHED], [CP_CALL, CP_PATCHED]]);
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

/** Consume the exact frontend artifact gitlink for release builds. */
export async function usePinnedFrontendDist(root, options = {}) {
  const tools = { ...core, ...options.tools };
  const { frontend, dist } = tools.paths(root);
  const indexReady = (directory) => {
    const file = path.join(directory, 'index.html');
    return fs.existsSync(file) && fs.statSync(file).isFile() && fs.statSync(file).size > 0;
  };
  const sourceSha = await tools.git(root, ['rev-parse', 'HEAD:nuwax']);
  const distSha = await tools.git(root, ['rev-parse', 'HEAD:nuwax-dist']);
  if (!/^[0-9a-f]{40}$/.test(sourceSha) || !/^[0-9a-f]{40}$/.test(distSha))
    throw new Error('release frontend gitlinks are invalid');
  if (!fs.existsSync(path.join(dist, '.git')) || await tools.git(dist, ['rev-parse', 'HEAD']) !== distSha)
    throw new Error('nuwax-dist checkout does not match the release gitlink');
  if (await tools.git(dist, ['status', '--porcelain', '--untracked-files=all']))
    throw new Error('nuwax-dist has local changes');
  let stamp;
  try { stamp = tools.readJson(path.join(dist, 'version.json')).gitHash; } catch {}
  if (typeof stamp !== 'string' || !/^[0-9a-f]{7,40}$/.test(stamp) || !sourceSha.startsWith(stamp))
    throw new Error(`nuwax-dist stamp ${stamp ?? '(missing)'} differs from source gitlink ${sourceSha}`);
  if (!indexReady(dist))
    throw new Error('nuwax-dist index.html is missing or empty');
  const target = path.join(frontend, 'dist');
  if (fs.existsSync(target)) throw new Error('nuwax/dist already exists; refusing to overwrite source build output');
  fs.mkdirSync(target, { recursive: true });
  try {
    for (const name of fs.readdirSync(dist)) {
      if (name === '.git' || name === 'README.md') continue;
      fs.cpSync(path.join(dist, name), path.join(target, name), { recursive: true, verbatimSymlinks: true });
    }
    if (!indexReady(target))
      throw new Error('copied frontend index.html is missing or empty');
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
  console.log(`[frontend] pinned dist ready: ${distSha} from ${sourceSha}`);
  return { sourceSha, distSha, stamp, distDir: target };
}
