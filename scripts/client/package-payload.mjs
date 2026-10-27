import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from './core.mjs';
import { packagedResources } from '../prepare-release-updater.mjs';

const toolNames = ['node', 'git', 'uv', 'ripgrep'];
const toolRoot = /(?:^|\/)resources\/(?:node|git|uv|ripgrep)$/;
const explicitCache = /(?:^|\/)resources\/(?:node|git|uv|ripgrep)\/\.cache(?:\/|$)/;
const cacheFilter = '!.cache{,/**/*}';
const projectCacheFilters = toolNames.map(name => `!resources/${name}/.cache{,/**/*}`);
const normalized = value => String(value ?? '').replaceAll('\\', '/').replace(/\/+$/, '');
const array = value => value == null ? [] : Array.isArray(value) ? value : [value];

function resourceMappings(entries) {
  if (entries == null) return entries;
  const items = array(entries);
  const result = items.map(entry => {
    if (!entry || typeof entry !== 'object') return entry;
    const source = normalized(entry.from);
    // An explicit file source bypasses builder's glob filter. Reject it instead
    // of silently publishing a download archive through a second mapping.
    if (explicitCache.test(source)) throw new Error('[package-payload] Explicit build cache resource is not publishable');
    const exclusions = toolRoot.test(source) ? [cacheFilter]
      : !source || source === '.' ? projectCacheFilters : [];
    if (!exclusions.length) return entry;
    const filters = array(entry.filter);
    if (filters.some(value => typeof value !== 'string')) throw new Error('[package-payload] Expected string resource filters');
    return { ...entry, filter: [...new Set([...filters, ...exclusions])] };
  });
  // String patterns share a project-root matcher. Do not create a new matcher
  // for object-only configurations: ignore-only patterns imply "copy all".
  if (items.some(entry => typeof entry === 'string')) {
    for (const filter of projectCacheFilters) if (!result.includes(filter)) result.push(filter);
  }
  return result;
}

/** Only tool download caches are excluded. Runtime archives and nested indexes stay intact. */
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
  return { resources, checkedCacheRoots: cacheRoots.length };
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
      console.log('[package-payload] Tool download caches excluded from published resources');
    } else {
      const result = verifyPackagePayload(options['--verify-output'], { platform: options['--platform'], arch: options['--arch'] });
      console.log(`[package-payload] No build caches in unpacked resources (${result.checkedCacheRoots} roots checked)`);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
