/** Independent identities for fixed dependencies. The existing transport still
 * verifies the producer job, immutable tag, ancestry and every installed byte. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import sourceCache from './prepared-source-cache.cjs';

const client = 'nuwa-electron-shell/crates/agent-electron-client';
const digest = value => createHash('sha256').update(value).digest('hex');
const recipe = (root, files) => files.map(file => [file, digest(fs.readFileSync(path.join(root, file)))]);
export function dependencyKey(kind, inputs, { platform = process.platform, arch = process.env.TARGET_ARCH || process.arch } = {}) {
  return kind + '-v1-' + platform + '-' + arch + '-' + digest(JSON.stringify(inputs));
}
export function sourceBuildKey(root, kind, resolve = (url, ref) => execFileSync('git',
  ['ls-remote', '--exit-code', url, ref], { encoding: 'utf8', timeout: 60_000 }), runtime = {
    node: process.version, abi: process.versions.modules,
    npm: execSync('npm --version', { encoding: 'utf8', timeout: 30_000 }).trim(),
    pnpm: execSync('pnpm --version', { encoding: 'utf8', timeout: 30_000, env: { ...process.env, COREPACK_ENABLE_PROJECT_SPEC: '0', COREPACK_ENABLE_AUTO_PIN: '0' } }).trim(),
  }) {
  const spec = sourceCache.sources[kind];
  if (!spec) throw new Error('Unknown prepared source');
  const config = JSON.parse(fs.readFileSync(path.join(root, client, 'package.json'))).bundledSources[spec.name];
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(config.url) || !/^[\w./-]+$/.test(config.branch)) throw new Error('Invalid bundled source ref');
  const ref = 'refs/heads/' + config.branch;
  const matches = resolve(config.url, ref).trim().split(/\r?\n/).map(line => line.split(/\s+/));
  if (matches.length !== 1 || !/^[a-f0-9]{40}$/.test(matches[0][0]) || matches[0][1] !== ref) throw new Error('Cannot freeze bundled source branch');
  const revision = matches[0][0];
  const files = [client + '/scripts/prepare/prepare-' + spec.name + '.js',
    client + '/scripts/utils/project-paths.js', 'scripts/client/prepared-source-cache.cjs'];
  if (kind === 'file-server') files.push('scripts/source-patches.cjs', 'resources/source-patches/nuwax-file-server-http-listener.patch');
  return { revision, key: dependencyKey(kind, { config, revision, runtime, recipe: recipe(root, files) }) };
}
export function desktopBuildKey(root, env = process.env, platform = process.platform, arch = process.env.TARGET_ARCH || process.arch) {
  const files = ['scripts/client/agent-desktop-resources.mjs'];
  let tools;
  if (platform === 'win32' && fs.existsSync(path.join(root, 'scripts/client/agent-desktop-windows.mjs'))) {
    files.push('scripts/client/agent-desktop-windows.mjs', 'third-party/patches/agent-desktop-windows-no-focus.patch');
    if (!env.ImageOS || !env.ImageVersion) throw new Error('Native Windows cache needs the hosted compiler image identity');
    const names = Object.keys(env).filter(name => /^(RUST|CARGO|CC$|CXX$|AR$|CFLAGS$|CXXFLAGS$|LDFLAGS$|INCLUDE$|LIB$|VCTools|WindowsSDK|WindowsSdk)/.test(name)).sort();
    tools = { image: [env.ImageOS, env.ImageVersion], environment: digest(JSON.stringify(names.map(name => [name, env[name]]))) };
  }
  return dependencyKey('agent-desktop', { recipe: recipe(root, files), tools }, { platform, arch });
}
export function officeDownloadKey(root) {
  return dependencyKey('dsh-download', { recipe: recipe(root, [
    'nuwa-electron-shell/crates/dsh-runtime/vendor/primary-runtime.lock.json',
    'nuwa-electron-shell/crates/dsh-runtime/vendor/prepare-office.mjs',
  ]) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const emit = (name, value) => {
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, name + '=' + value + '\n');
    else console.log(name + '=' + value);
  };
  for (const kind of ['file-server', 'claude-acp', 'agent-desktop', 'dsh-download']) {
    try {
      if (Object.hasOwn(sourceCache.sources, kind)) {
        const { key, revision } = sourceBuildKey(root, kind);
        const prefix = sourceCache.sources[kind].env;
        // Preparation consumes this exact commit even if the branch advances
        // after lookup. No cache key may describe a different built revision.
        if (!process.env.GITHUB_ENV) throw new Error('CI source freezing requires GITHUB_ENV');
        fs.appendFileSync(process.env.GITHUB_ENV, prefix + '_SOURCE_SHA=' + revision + '\n' + prefix + '_CACHE_KEY=' + key + '\n');
        emit(kind, key);
      } else if (kind === 'agent-desktop') {
        const key = desktopBuildKey(root);
        if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, 'NUWAX_AGENT_DESKTOP_CACHE_KEY=' + key + '\n');
        emit(kind, key);
      } else if (fs.existsSync(path.join(root, 'nuwa-electron-shell/crates/dsh-runtime/vendor/primary-runtime.lock.json'))) {
        const key = officeDownloadKey(root);
        if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, 'NUWAX_DSH_DOWNLOAD_CACHE_KEY=' + key + '\n');
        emit(kind, key);
      }
    } catch (error) {
      console.warn('[fixed-dependency-cache] ' + kind + ': unavailable; original preparation remains enabled: ' + error.message);
    }
  }
}
