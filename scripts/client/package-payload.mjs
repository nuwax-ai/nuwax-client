import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from './core.mjs';
import { packagedResources } from '../prepare-release-updater.mjs';
import { verifyLinuxPackageDependencies, verifyLinuxPackageLinks } from '../../nuwa-electron-shell/crates/agent-electron-client/scripts/build/linux-package-policy.cjs';

const toolNames = ['node', 'git', 'uv', 'ripgrep'];
const toolRoot = /(?:^|\/)resources\/(?:node|git|uv|ripgrep)$/;
const explicitCache = /(?:^|\/)resources\/(?:node|git|uv|ripgrep)\/\.cache(?:\/|$)/;
const cacheFilter = '!.cache{,/**/*}';
const projectCacheFilters = toolNames.map(name => `!resources/${name}/.cache{,/**/*}`);
const noticeRoot = /^(?:resources\/)?third-party(?:\/|$)/;
const projectNoticeFilters = ['!third-party{,/**/*}', '!resources/third-party{,/**/*}'];
const normalized = value => String(value ?? '').replaceAll('\\', '/').replace(/\/+$/, '');
const array = value => value == null ? [] : Array.isArray(value) ? value : [value];

function resourceMappings(entries) {
  if (entries == null) return entries;
  const items = array(entries).filter(entry => !noticeRoot.test(normalized(typeof entry === 'string' ? entry : entry?.to ?? entry?.from)));
  const result = items.map(entry => {
    if (!entry || typeof entry !== 'object') return entry;
    const source = normalized(entry.from);
    // An explicit file source bypasses builder's glob filter. Reject it instead
    // of silently publishing a download archive through a second mapping.
    if (explicitCache.test(source)) throw new Error('[package-payload] Explicit build cache resource is not publishable');
    const exclusions = toolRoot.test(source) ? [cacheFilter]
      : !source || source === '.' ? [...projectCacheFilters, ...projectNoticeFilters] : [];
    if (!exclusions.length) return entry;
    const filters = array(entry.filter);
    if (filters.some(value => typeof value !== 'string')) throw new Error('[package-payload] Expected string resource filters');
    return { ...entry, filter: [...new Set([...filters, ...exclusions])] };
  });
  // String patterns share a project-root matcher. Do not create a new matcher
  // for object-only configurations: ignore-only patterns imply "copy all".
  if (items.some(entry => typeof entry === 'string')) {
    for (const filter of [...projectCacheFilters, ...projectNoticeFilters]) if (!result.includes(filter)) result.push(filter);
  }
  return result;
}

/** Exclude download caches and standalone notices; preserve runtime files. */
export function configurePackagePayload(build) {
  const result = { ...build };
  if (build.extraResources != null) result.extraResources = resourceMappings(build.extraResources);
  for (const platform of ['mac', 'win', 'linux']) {
    if (build[platform]?.extraResources != null) {
      result[platform] = { ...build[platform], extraResources: resourceMappings(build[platform].extraResources) };
    }
  }
  return result;
}

/** CI package preparation; source cache directories are never touched. */
export function preparePackagePayload(packageFile) {
  const pkg = core.readJson(packageFile);
  if (!pkg.build || typeof pkg.build !== 'object' || Array.isArray(pkg.build)) throw new Error('[package-payload] Missing build configuration');
  pkg.build = configurePackagePayload(pkg.build);
  core.atomicJson(packageFile, pkg);
}

/** Verify the unpacked payload before publication; never repair a signed app. */
export function verifyPackagePayload(output, { platform = process.platform, arch = process.arch } = {}) {
  const resources = packagedResources(output, platform, arch);
  let stat;
  try { stat = fs.lstatSync(resources); } catch { /* Report missing and unreadable resources alike. */ }
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error('[package-payload] Missing or invalid packaged resource directory');
  const cacheRoots = toolNames.flatMap(name => [`${name}/.cache`, `resources/${name}/.cache`]);
  for (const relative of cacheRoots) {
    try { fs.lstatSync(path.join(resources, relative)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error(`[package-payload] Published build cache found: ${relative}`);
  }
  for (const relative of ['third-party', 'resources/third-party']) {
    try { fs.lstatSync(path.join(resources, relative)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error(`[package-payload] Standalone notices found: ${relative}`);
  }
  // better-sqlite3 ships from a local source build; its bundled prebuilt binaries and
  // build by-products are excluded by the client build config and must stay out of the app.
  const nativeModule = path.join(resources, 'app.asar.unpacked/node_modules/better-sqlite3');
  for (const relative of ['prebuilds', 'build/Release/obj', 'build/Release/test_extension.node']) {
    try { fs.lstatSync(path.join(nativeModule, relative)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error(`[package-payload] better-sqlite3 build by-product found: ${relative}`);
  }
  // Linux 安装包内不得有硬链接：dpkg 安装时要在目标位置重建链接，跨文件系统必然失败。
  const packages = verifyLinuxPackageLinks(output);
  // deb 必须带上客户端内升级要用的 zenity 等依赖，否则装到目标系统后只能手动升级。
  verifyLinuxPackageDependencies(output);
  return { resources, checkedCacheRoots: cacheRoots.length, checkedPackages: packages.checked };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    const names = new Set(['--package', '--verify-output', '--platform', '--arch']);
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i += 2) {
      if (!names.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || options[args[i]]) throw new Error('[package-payload] Invalid command arguments');
      options[args[i]] = args[i + 1];
    }
    if (Boolean(options['--package']) === Boolean(options['--verify-output'])) throw new Error('[package-payload] Use --package PACKAGE_JSON or --verify-output DIRECTORY [--platform PLATFORM] [--arch ARCH]');
    if (options['--package']) {
      if (options['--platform'] || options['--arch']) throw new Error('[package-payload] Package preparation applies to every platform');
      preparePackagePayload(options['--package']);
      console.log('[package-payload] Tool download caches and standalone notices excluded from published resources');
    } else {
      const result = verifyPackagePayload(options['--verify-output'], { platform: options['--platform'], arch: options['--arch'] });
      console.log(`[package-payload] No build caches or standalone notices in unpacked resources (${result.checkedCacheRoots} cache roots checked)`);
      if (result.checkedPackages) console.log(`[package-payload] No hard links in ${result.checkedPackages} Linux package(s)`);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
