import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import config from '../../client.config.mjs';
import * as core from './core.mjs';

const ignoredInputs = new Set(['node_modules', '.git', 'dist', 'release', '.cache', 'target']);
export const sourceNames = ['nuwax-file-server', 'claude-code-acp-ts'];

export function fileReady(file) {
  try { return fs.statSync(file).isFile() && fs.statSync(file).size > 0; } catch { return false; }
}

// Content, rather than mtime, determines whether an install or build is reusable.
export function inputDigest(entries, { excludeNames = [] } = {}) {
  const ignored = new Set([...ignoredInputs, ...excludeNames]);
  const hash = createHash('sha256');
  const visit = (file, label) => {
    hash.update(label);
    if (!fs.existsSync(file)) { hash.update('<missing>'); return; }
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) { hash.update(fs.readlinkSync(file)); return; }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) {
        if (!ignored.has(name) && !name.startsWith('.env')) visit(path.join(file, name), `${label}/${name}`);
      }
    } else hash.update(fs.readFileSync(file));
  };
  entries.forEach((file, i) => visit(file, String(i)));
  return hash.digest('hex');
}

export function commercialEnv(root, overrides = {}) {
  const p = core.paths(root);
  return {
    ...process.env,
    NUWAX_APP_IDENTIFIER: config.product.identifier,
    NUWAX_APP_DISPLAY_NAME: config.product.name,
    NUWAX_UPDATE_FEED_BASE: config.product.feedBase,
    NUWAX_DOWNLOAD_PAGE_URL: config.product.downloadUrl,
    NUWAX_PORT_OFFSET: String(config.product.portOffset),
    NUWAX_FRONTEND_DIST: p.dist,
    TARGET_ARCH: process.arch,
    ...overrides,
  };
}

function safeJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function packageReady(dir) {
  const pkg = safeJson(path.join(dir, 'package.json'));
  if (!pkg) return false;
  const entries = [pkg.main, ...Object.values(typeof pkg.bin === 'object' ? pkg.bin : pkg.bin ? { bin: pkg.bin } : {})].filter(Boolean);
  if (entries.length) return entries.every((entry) => fileReady(path.join(dir, entry)));
  try { return fs.readdirSync(path.join(dir, 'dist')).some((name) => /\.(?:c?js|mjs)$/.test(name)); } catch { return false; }
}

export function runtimeDependenciesReady(dir) {
  const pkg = safeJson(path.join(dir, 'package.json'));
  return Boolean(pkg && Object.keys(pkg.dependencies ?? {}).every((name) => fileReady(path.join(dir, 'node_modules', name, 'package.json'))));
}

export function resourceSpecs(client, platform = process.platform, arch = process.arch) {
  const r = path.join(client, 'resources');
  const exe = platform === 'win32' ? '.exe' : '';
  const key = `${platform}-${arch}`;
  const specs = [
    ['uv', [path.join(r, 'uv/bin', `uv${exe}`)]],
    ['node', [path.join(r, 'node', key, 'bin', `node${exe}`)]],
    ['ripgrep', [path.join(r, 'ripgrep/bin', `rg${exe}`)]],
    ['lanproxy', [path.join(r, 'lanproxy/bin', `nuwax-lanproxy${exe}`)]],
    ['ttyd', [path.join(r, 'ttyd/bin', `ttyd${exe}`)], true],
    ['mcp-proxy', [path.join(r, 'mcp-proxy-ts/dist/index.js'), path.join(r, 'mcp-proxy-ts/dist/lib.bundle.mjs')]],
    ['sandboxed-mcp', ['sandboxed-bash-mcp', 'sandboxed-fs-mcp'].map((name) => path.join(r, name, 'dist', `${name}.bundle.mjs`))],
    ['nuwaxcode', [path.join(r, 'nuwaxcode', platform === 'win32' ? `windows-${arch}` : key, 'bin', `nuwaxcode${exe}`)]],
    ['codex-acp-ts', [path.join(r, 'nuwax-codex-acp-ts/dist/index.js')]],
    ['gui-server', [path.join(r, 'agent-gui-server/dist/index.js'), path.join(r, 'agent-gui-server/dist/lib.bundle.cjs')]],
  ].map(([name, files, optional = false]) => ({ name, script: `prepare:${name}`, files, optional }));
  if (platform === 'win32') {
    specs.splice(1, 0, { name: 'git', script: 'prepare:git', files: [path.join(r, 'git/cmd/git.exe'), path.join(r, 'git/bin/bash.exe')] });
    specs.push(
      { name: 'sandbox-helper-win', script: 'prepare:sandbox-helper-win', files: [path.join(r, 'sandbox-helper/nuwax-sandbox-helper.exe')] },
      { name: 'windows-mcp', script: 'prepare:windows-mcp', files: [path.join(r, 'windows-mcp/manifest.json')], check: () => {
        const manifest = safeJson(path.join(r, 'windows-mcp/manifest.json'));
        return manifest?.files?.length > 0 && manifest.files.every((name) => fileReady(path.join(r, 'windows-mcp/wheels', name)));
      } },
    );
  }
  // The base runtime is optional on Unix, but its manifest must be materialized for packaging.
  specs.push({ name: 'sandbox-runtime', script: 'prepare:sandbox-runtime', files: [path.join(r, 'sandbox-runtime/resolved-manifest.json')], check: () => {
    const manifest = safeJson(path.join(r, 'sandbox-runtime/resolved-manifest.json'));
    return Boolean(manifest && (manifest.skipped || fileReady(manifest.target)));
  } });
  return specs;
}

export function electronBinary(client, platform = process.platform) {
  const dir = path.join(client, 'node_modules/electron');
  try { return path.join(dir, 'dist', fs.readFileSync(path.join(dir, 'path.txt'), 'utf8').trim()); } catch {
    return path.join(dir, 'dist', platform === 'win32' ? 'electron.exe' : platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');
  }
}

async function ensureSubmodules(root, options, tools) {
  const declared = await tools.git(root, ['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$']);
  const names = declared.split('\n').map((line) => line.trim().split(/\s+/).slice(1).join(' ')).filter(Boolean);
  const missing = names.filter((name) => !fs.existsSync(path.join(root, name, '.git')));
  if (missing.length) {
    console.log(`[prepare] 初始化缺失子模块: ${missing.join(', ')}`);
    if (!options.dryRun) await tools.run('git', ['submodule', 'update', '--init', '--depth', '1', '--', ...missing], { cwd: root });
  }
}

export async function validatePinnedFrontend(root, tools = core) {
  const p = tools.paths(root);
  const tree = await tools.git(root, ['ls-tree', 'HEAD', '--', 'nuwax', 'nuwax-dist']);
  const links = Object.fromEntries(tree.split('\n').filter(Boolean).map((line) => {
    const [metadata, name] = line.split('\t');
    const [mode, , sha] = metadata.split(' ');
    if (mode !== '160000') throw new Error(`[prepare] ${name} 必须是 submodule gitlink`);
    return [name, sha];
  }));
  if (!links.nuwax || !links['nuwax-dist']) throw new Error('[prepare] 缺少 nuwax / nuwax-dist 双 pin，先运行 sub:update');
  const stamp = safeJson(path.join(p.dist, 'version.json'))?.gitHash;
  if (!fileReady(path.join(p.dist, 'index.html')) || typeof stamp !== 'string' || stamp.length < 7 || !links.nuwax.startsWith(stamp)) {
    throw new Error(`[prepare] nuwax-dist 产物戳 ${stamp ?? '(缺失)'} 与源码 pin ${links.nuwax.slice(0, 9)} 不匹配，运行 npm run sub:update`);
  }
  const distHead = await tools.git(p.dist, ['rev-parse', 'HEAD']);
  if (await tools.git(p.frontend, ['rev-parse', 'HEAD']) !== links.nuwax) throw new Error('[prepare] nuwax HEAD 已偏离源码 pin；更新双 pin 或使用 --frontend source');
  if (distHead !== links['nuwax-dist'] || await tools.git(p.dist, ['status', '--porcelain'])) {
    throw new Error('[prepare] nuwax-dist 工作树未对齐已提交的产物 pin；先保留本地改动并完成双 pin 提交');
  }
  return { sourceSha: links.nuwax, distSha: distHead, stamp, distDir: p.dist };
}

function sanitizeLinks(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) sanitizeLinks(file);
    else if (entry.isSymbolicLink() && (path.isAbsolute(fs.readlinkSync(file)) || !fs.existsSync(file))) fs.unlinkSync(file);
  }
}

function overlayFiles(root) {
  const directory = path.join(root, 'overlay');
  const files = [];
  const walk = (dir, prefix = '') => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!prefix && entry.name === 'README.md') continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
      else files.push(relative);
    }
  };
  walk(directory);
  return files;
}

async function syncOverlay(p, tools, state) {
  const files = overlayFiles(p.root);
  const previous = safeJson(path.join(p.root, '.overlay-sync.json')) ?? [];
  for (const relative of new Set([...files, ...previous])) {
    const destination = path.join(p.base, relative);
    if (!fs.existsSync(destination)) continue;
    const source = path.join(p.root, 'overlay', relative);
    const digest = inputDigest([destination]);
    if (fs.existsSync(source) && digest === inputDigest([source])) continue;
    if (state.overlay?.[relative] === digest) continue;
    if (await tools.git(p.base, ['status', '--porcelain', '--untracked-files=all', '--', relative])) {
      throw new Error(`[prepare] overlay 同步将覆盖基座本地改动 ${relative}；请先保留改动`);
    }
  }
  await tools.run(process.execPath, [path.join(p.root, 'scripts/sync-overlay.js')], { cwd: p.root });
  state.overlay = Object.fromEntries(files.map((relative) => [relative, inputDigest([path.join(p.base, relative)])]));
}

async function prepareSource(p, name, source, options, tools, state, save) {
  const cacheDir = path.join(p.cache, 'sources', `${name}-${tools.fingerprint([source.url, source.branch]).slice(0, 12)}`);
  const marker = path.join(cacheDir, '.toolchain-source.json');
  const destination = path.join(p.client, 'resources', name);
  const ownershipFile = path.join(destination, '.toolchain-resource.json');
  const artifact = () => inputDigest([path.join(destination, 'package.json'), path.join(destination, 'dist')]);
  let legacyPayload = false;
  // Legacy scripts sometimes cloned developer checkouts into resources. Only
  // outputs previously produced by this tool may be replaced automatically.
  if (fs.existsSync(destination) && fs.readdirSync(destination).length > 0) {
    if (fs.existsSync(path.join(destination, '.git'))) throw new Error(`[prepare] 拒绝覆盖资源中的源码检出 ${destination}；请先保留并移走该目录`);
    const ownership = safeJson(ownershipFile);
    const recorded = state.sources?.[name];
    const recordedOwner = recorded?.url === source.url && recorded?.branch === source.branch;
    legacyPayload = !recordedOwner || Boolean(ownership && (ownership.url !== source.url || ownership.branch !== source.branch));
    if (recorded && recorded.artifact !== artifact()) throw new Error(`[prepare] 资源目录含本地改动 ${destination}；请先保留并移走该目录`);
    if (!legacyPayload && !ownership) tools.atomicJson(ownershipFile, { url: source.url, branch: source.branch, sha: recorded.sha });
  }
  if (!fs.existsSync(path.join(cacheDir, '.git'))) {
    if (fs.existsSync(cacheDir)) throw new Error(`[prepare] 非工具链源码缓存占用了 ${cacheDir}，请先移走`);
    fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
    await tools.run('git', ['clone', '--branch', source.branch, '--', source.url, cacheDir], { cwd: p.root });
    tools.atomicJson(marker, { url: source.url, branch: source.branch });
  }
  const owner = safeJson(marker);
  if (owner?.url !== source.url || owner?.branch !== source.branch) throw new Error(`[prepare] 拒绝修改来源不明的缓存 ${cacheDir}`);
  if (await tools.git(cacheDir, ['status', '--porcelain', '--untracked-files=no'])) throw new Error(`[prepare] 工具链缓存存在源码改动: ${cacheDir}；请先保留改动`);
  if (options.refreshResources) {
    await tools.git(cacheDir, ['fetch', 'origin', source.branch]);
    await tools.git(cacheDir, ['checkout', '--detach', `origin/${source.branch}`]);
  }
  const sha = await tools.git(cacheDir, ['rev-parse', 'HEAD']);
  const key = tools.fingerprint([sha, options.platform, options.arch, process.versions.node, inputDigest([path.join(cacheDir, 'package.json'), path.join(cacheDir, 'package-lock.json')])]);
  if (!legacyPayload && state.sources?.[name]?.key === key && state.sources?.[name]?.artifact === artifact() && packageReady(destination) && runtimeDependenciesReady(destination) && fs.existsSync(path.join(destination, 'node_modules'))) {
    console.log(`[prepare] 复用 ${name} @ ${sha.slice(0, 9)}`);
    return;
  }
  const install = fileReady(path.join(cacheDir, 'package-lock.json')) ? ['ci', '--ignore-scripts', '--include=dev'] : ['install', '--ignore-scripts', '--no-package-lock', '--include=dev'];
  await tools.run('npm', install, { cwd: cacheDir, env: { ...process.env, CI: 'true' } });
  const sourcePackage = tools.readJson(path.join(cacheDir, 'package.json'));
  if (sourcePackage.scripts?.build) await tools.npmRun(cacheDir, 'build');
  else await tools.run('npm', ['exec', '--no', '--', 'tsc'], { cwd: cacheDir });
  if (!packageReady(cacheDir)) throw new Error(`[prepare] ${name} 构建没有生成 package.json 声明的入口`);
  if (legacyPayload) {
    const backup = path.join(p.cache, 'legacy-resources', `${name}-${randomUUID()}`);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    try { fs.renameSync(destination, backup); } catch (error) {
      if (error.code !== 'EXDEV') throw error;
      fs.cpSync(destination, backup, { recursive: true });
      fs.rmSync(destination, { recursive: true });
    }
    console.warn(`[prepare] 已保留旧资源目录: ${backup}`);
  }
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of ['dist', 'node_modules', 'package.json', 'LICENSE', 'LICENSE.md']) {
    const from = path.join(cacheDir, entry);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(destination, entry), { recursive: true, filter: (file) => !/(?:^|[\\/])node_modules[\\/]\.bin(?:[\\/]|$)/.test(file) });
  }
  fs.writeFileSync(path.join(destination, '.commit-hash'), `${sha}\n`);
  tools.atomicJson(ownershipFile, { url: source.url, branch: source.branch, sha });
  state.sources ??= {};
  state.sources[name] = { key, sha, artifact: artifact(), url: source.url, branch: source.branch };
  save();
}

/** Shared preparation for dev and pack. Existing developer sources are never updated. */
export async function prepare(root, options = {}) {
  const tools = options.tools ?? core;
  const p = tools.paths(root);
  const opt = { frontend: 'dist', platform: process.platform, arch: process.arch, ...options };
  if (!['dist', 'source'].includes(opt.frontend)) throw new Error('[prepare] frontend 必须是 dist 或 source');
  await ensureSubmodules(root, opt, tools);
  const plan = ['overlay', 'agent-kit', 'workspace', 'native', 'resources'];
  if (opt.dryRun) {
    console.log(`[prepare] dry-run: ${plan.join(' → ')} (${opt.platform}-${opt.arch}, frontend=${opt.frontend})`);
    return { ...p, dryRun: true, steps: plan };
  }
  const frontend = opt.frontend === 'dist' ? await validatePinnedFrontend(root, tools) : null;
  fs.mkdirSync(p.cache, { recursive: true });
  return tools.withLock(root, 'prepare', async () => {
  const stateFile = path.join(p.cache, 'prepare.json');
  const state = safeJson(stateFile) ?? {};
  const save = () => tools.atomicJson(stateFile, state);
  const env = commercialEnv(root, { TARGET_ARCH: opt.arch });
    await syncOverlay(p, tools, state);
    save();
    const kit = path.join(p.base, 'crates/agent-kit');
    // The inherited workspace postinstall can generate an ignored standalone
    // lock. It is build output, rather than an authoritative dependency input.
    const kitLockTracked = Boolean(await tools.git(p.base, ['ls-files', '--error-unmatch', '--', 'crates/agent-kit/pnpm-lock.yaml'], { allowFailure: true }));
    const kitKey = tools.fingerprint([opt.platform, opt.arch, process.versions.node, inputDigest([kit], { excludeNames: kitLockTracked ? [] : ['pnpm-lock.yaml'] })]);
    if (state.kit !== kitKey || !['index.js', 'index.cjs', 'index.d.ts'].every((name) => fileReady(path.join(kit, 'dist', name)))) {
      await tools.pnpmRun(kit, ['install', '--ignore-workspace', kitLockTracked && fileReady(path.join(kit, 'pnpm-lock.yaml')) ? '--frozen-lockfile' : '--lockfile=false', '--prod=false'], { env: { ...env, CI: 'true' } });
      await tools.pnpmRun(kit, ['run', 'build'], { env });
      if (!['index.js', 'index.cjs', 'index.d.ts'].every((name) => fileReady(path.join(kit, 'dist', name)))) throw new Error('[prepare] agent-kit 构建入口缺失');
      state.kit = kitKey;
      save();
    } else console.log('[prepare] 复用 agent-kit');
    const workspaceKey = tools.fingerprint([kitKey, opt.platform, opt.arch, process.versions.node, inputDigest([path.join(p.base, 'package.json'), path.join(p.base, 'pnpm-lock.yaml'), path.join(p.base, 'pnpm-workspace.yaml'), path.join(p.client, 'package.json'), path.join(p.base, 'crates/agent-gui-server/package.json')])]);
    const dependenciesReady = ['electron', 'vite', 'better-sqlite3', '@nuwax-ai/agent-kit', 'agent-gui-server'].every((name) => fileReady(path.join(p.client, 'node_modules', name, 'package.json')));
    if (state.workspace !== workspaceKey || !dependenciesReady) {
      await tools.pnpmRun(p.base, ['install', '--frozen-lockfile', '--prod=false', '--filter', '@nuwax-ai/nuwaclaw...', ...(state.workspace ? ['--force'] : [])], { env: { ...env, CI: 'true' } });
      if (!['electron', 'vite', 'better-sqlite3', '@nuwax-ai/agent-kit', 'agent-gui-server'].every((name) => fileReady(path.join(p.client, 'node_modules', name, 'package.json')))) throw new Error('[prepare] 工作区依赖入口缺失');
      state.workspace = workspaceKey;
      save();
    } else console.log('[prepare] 复用工作区依赖');
    const electron = electronBinary(p.client, opt.platform);
    if (!fileReady(electron)) await tools.pnpmRun(p.client, ['rebuild', 'electron'], { env });
    if (!fileReady(electron)) throw new Error('[prepare] Electron 可执行文件缺失，检查 pnpm electron 安装脚本及下载网络');
    const abiResult = await tools.run(electron, ['-p', 'process.versions.modules'], { cwd: p.client, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, capture: true });
    const abi = abiResult.stdout.trim();
    if (!/^\d+$/.test(abi)) throw new Error('[prepare] 无法获取 Electron 原生模块 ABI');
    const native = path.join(p.client, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node');
    const nativeKey = tools.fingerprint([workspaceKey, abi, opt.platform, opt.arch]);
    if (state.native?.key !== nativeKey || state.native?.artifact !== inputDigest([native]) || !fileReady(native)) {
      await tools.npmRun(p.client, 'electron-rebuild', [], { env });
      if (!fileReady(native)) throw new Error('[prepare] better_sqlite3.node 未生成；检查 Python 和系统 C/C++ 构建工具');
    }
    await tools.run(electron, ['-e', "const db = new (require('better-sqlite3'))(':memory:'); db.prepare('select 1').get(); db.close()"], { cwd: p.client, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, capture: true });
    state.native = { key: nativeKey, abi, artifact: inputDigest([native]) };
    save();
    const scriptsKey = inputDigest([path.join(p.client, 'scripts/prepare'), path.join(p.client, 'scripts/utils'), path.join(p.client, 'resources/sandboxed-bash-mcp'), path.join(p.client, 'resources/sandboxed-fs-mcp'), path.join(p.base, 'crates/windows-sandbox-helper'), path.join(p.base, 'crates/agent-gui-server'), ...(process.env.NUWAXCODE_DIST_DIR ? [process.env.NUWAXCODE_DIST_DIR] : [])]);
    const resourceKey = tools.fingerprint([workspaceKey, scriptsKey, opt.platform, opt.arch]);
    state.resources ??= {};
    for (const spec of resourceSpecs(p.client, opt.platform, opt.arch)) {
      const ready = () => spec.files.every(fileReady) && (!spec.check || spec.check());
      if (state.resources[spec.name]?.key === resourceKey && state.resources[spec.name]?.artifact === inputDigest(spec.files) && (ready() || state.resources[spec.name]?.skipped && spec.optional)) {
        console.log(`[prepare] 复用 ${spec.name}`);
        continue;
      }
      if (spec.name === 'sandbox-helper-win') await tools.run('cargo', ['--version'], { cwd: p.base, capture: true });
      if (spec.name === 'node' && !ready()) fs.rmSync(path.join(p.client, 'resources/node', `${opt.platform}-${opt.arch}`), { recursive: true, force: true });
      if (spec.name === 'gui-server') {
        await tools.npmRun(path.join(p.base, 'crates/agent-gui-server'), 'build', [], { env });
        // Its inherited prepare script compares package versions only. A source
        // edit can change the bundle without changing that version.
        fs.rmSync(path.join(p.client, 'resources/agent-gui-server'), { recursive: true, force: true });
      }
      if (spec.name === 'sandboxed-mcp') for (const file of spec.files) fs.rmSync(file, { force: true });
      await tools.npmRun(p.client, spec.script, [], { env });
      if (!ready() && !spec.optional) throw new Error(`[prepare] ${spec.script} 返回成功但产物缺失: ${spec.files.join(', ')}`);
      const skipped = !ready();
      if (skipped) console.warn(`[prepare] ${spec.name} 当前平台未提供资源，相关功能不可用`);
      state.resources[spec.name] = { key: resourceKey, skipped, artifact: inputDigest(spec.files) };
      save();
    }
    const pkg = tools.readJson(path.join(p.client, 'package.json'));
    for (const name of sourceNames) {
      if (!pkg.bundledSources?.[name]) throw new Error(`[prepare] 缺少 bundledSources.${name}`);
      await prepareSource(p, name, pkg.bundledSources[name], opt, tools, state, save);
    }
    if (opt.frontend === 'source') {
      const frontendKey = tools.fingerprint([opt.platform, opt.arch, process.versions.node, inputDigest([path.join(p.frontend, 'package.json'), path.join(p.frontend, 'pnpm-lock.yaml')])]);
      if (state.frontend !== frontendKey || !fileReady(path.join(p.frontend, 'node_modules/@umijs/max/package.json'))) {
        await tools.pnpmRun(p.frontend, ['install', '--frozen-lockfile', '--prod=false'], { env: { ...process.env, CI: 'true' } });
        state.frontend = frontendKey;
        tools.atomicJson(path.join(p.cache, 'frontend-install.json'), { key: tools.fingerprint([tools.fileHash(path.join(p.frontend, 'package.json')), tools.fileHash(path.join(p.frontend, 'pnpm-lock.yaml')), opt.platform, opt.arch, process.version]) });
        save();
      } else console.log('[prepare] 复用前端依赖');
    }
    sanitizeLinks(path.join(p.client, 'resources'));
    console.log(`[prepare] 就绪 (${opt.platform}-${opt.arch}, Electron ABI ${abi})`);
    return { ...p, frontend, abi, env };
  });
}
