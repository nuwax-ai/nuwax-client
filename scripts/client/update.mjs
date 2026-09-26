import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as core from './core.mjs';
import { buildFrontend } from './frontend.mjs';

const names = ['nuwa-electron-shell', 'nuwax', 'nuwax-dist'];
const message = (text) => console.log(`[sub:update] ${text}`);
const warn = (text) => console.warn(`[sub:update] ${text}`);

async function attempt(tools, dir, args) {
  return tools.run('git', args, { cwd: dir, capture: true, allowFailure: true });
}

async function ancestor(tools, dir, from, to) {
  const result = await attempt(tools, dir, ['merge-base', '--is-ancestor', from, to]);
  if (result.status > 1) throw new Error(result.stderr || `无法比较 ${from} 与 ${to}`);
  return result.status === 0;
}

async function declared(tools, root) {
  const modules = {};
  for (const name of names) {
    const subpath = await tools.git(root, ['config', '-f', '.gitmodules', '--get', `submodule.${name}.path`]);
    const branch = await tools.git(root, ['config', '-f', '.gitmodules', '--get', `submodule.${name}.branch`]);
    if (subpath !== name || !branch || branch === '.') throw new Error(`请为 ${name} 声明固定 path 和 branch`);
    modules[name] = { name, dir: path.join(root, subpath), branch };
  }
  if (modules['nuwax-dist'].branch !== 'main') throw new Error('nuwax-dist 只能使用声明分支 main');
  return modules;
}

async function cleanSource(tools, dir, frontend = false) {
  const args = ['status', '--porcelain', '--untracked-files=all'];
  if (frontend) args.push('--', '.', ':(exclude)dist', ':(exclude)dist/**');
  if (await tools.git(dir, args)) throw new Error(`${path.basename(dir)} 有源码改动；请先提交或另建 worktree（--force 不覆盖源码）`);
}

async function managedOverlayChanges(tools, root, dir) {
  if (await tools.git(dir, ['diff', '--cached', '--name-only'])) throw new Error('壳子模块有暂存改动；请先保留改动，更新器不会清除暂存区');
  const changed = (await tools.git(dir, ['diff', '--name-only', '-z'])).split('\0').filter(Boolean);
  const untracked = (await tools.git(dir, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, '.overlay-sync.json'), 'utf8')); } catch { manifest = []; }
  if (!Array.isArray(manifest)) manifest = [];
  const owned = new Set(manifest);
  const result = [];
  for (const relative of new Set([...changed, ...untracked])) {
    const source = path.join(root, 'overlay', relative), destination = path.join(dir, relative);
    let generated = false;
    try {
      generated = owned.has(relative) && fs.lstatSync(source).isFile() && fs.lstatSync(destination).isFile() && fs.readFileSync(source).equals(fs.readFileSync(destination));
    } catch {}
    if (!generated) throw new Error(`壳子模块 ${relative} 有未托管改动；请先保留改动（仅能还原 manifest 中与当前 overlay 完全相同的同步产物）`);
    result.push({ relative, tracked: (await attempt(tools, dir, ['ls-files', '--error-unmatch', '--', relative])).status === 0 });
  }
  return result;
}

async function moveShell(tools, root, module, target, overlay) {
  if (overlay.length) {
    for (const entry of overlay) {
      if (entry.tracked) await tools.git(module.dir, ['restore', '--worktree', '--', entry.relative]);
      else fs.unlinkSync(path.join(module.dir, entry.relative));
    }
  }
  try { await tools.git(module.dir, ['checkout', '--detach', target]); }
  finally {
    // Restore only verified generated state; unknown developer edits were rejected above.
    if (overlay.length) await tools.run(process.execPath, [path.join(root, 'scripts/sync-overlay.js')], { cwd: root });
  }
}

async function cleanScratch(tools, dir) {
  if (await tools.git(dir, ['ls-files', '--', 'dist'])) {
    await tools.git(dir, ['restore', '--source=HEAD', '--staged', '--worktree', '--', 'dist']);
  }
  await tools.git(dir, ['clean', '-fdx', '--', 'dist']);
}

async function fetch(tools, dir) {
  await tools.git(dir, ['fetch', '--prune', '--tags', 'origin']);
}

async function completeHistory(tools, dir) {
  if (await tools.git(dir, ['rev-parse', '--is-shallow-repository']) !== 'true') return false;
  message(`${path.basename(dir)} 为浅克隆，补齐历史后核对可达性`);
  await tools.git(dir, ['fetch', '--unshallow', '--prune', '--tags', 'origin']);
  return true;
}

async function remoteReachable(tools, dir, sha, historyChecked = false) {
  // Fetch first: stale tracking refs are not evidence that CI can retrieve a pin.
  await fetch(tools, dir);
  const branches = (await tools.git(dir, ['for-each-ref', '--format=%(objectname)', 'refs/remotes/origin'])).split('\n').filter(Boolean);
  for (const tip of branches) if (await ancestor(tools, dir, sha, tip)) return true;
  const tags = await tools.git(dir, ['ls-remote', '--tags', 'origin']);
  for (const line of tags.split('\n')) {
    const tip = line.split(/\s+/)[0];
    if (!/^[0-9a-f]{40,64}$/.test(tip)) continue;
    const local = await attempt(tools, dir, ['rev-parse', '--verify', `${tip}^{commit}`]);
    if (local.status === 0 && await ancestor(tools, dir, sha, local.stdout.trim())) return true;
  }
  if (!historyChecked && await completeHistory(tools, dir)) return remoteReachable(tools, dir, sha, true);
  return false;
}

async function resolveTarget(tools, module, explicit) {
  const { dir, branch, name } = module;
  await fetch(tools, dir);
  const head = await tools.git(dir, ['rev-parse', 'HEAD']);
  const branchRef = `refs/remotes/origin/${branch}`;
  if ((await attempt(tools, dir, ['rev-parse', '--verify', `${branchRef}^{commit}`])).status !== 0) {
    await tools.git(dir, ['fetch', 'origin', `+refs/heads/${branch}:${branchRef}`]);
  }
  let remote = await tools.git(dir, ['rev-parse', `${branchRef}^{commit}`]);
  if (!explicit) {
    if (await ancestor(tools, dir, head, remote)) return remote;
    if (await ancestor(tools, dir, remote, head)) {
      warn(`${name} 存在本地待推提交；CI 暂时无法获取该 pin`);
      return head;
    }
    if (await completeHistory(tools, dir)) {
      remote = await tools.git(dir, ['rev-parse', `${branchRef}^{commit}`]);
      if (await ancestor(tools, dir, head, remote)) return remote;
      if (await ancestor(tools, dir, remote, head)) {
        warn(`${name} 存在本地待推提交；CI 暂时无法获取该 pin`);
        return head;
      }
    }
    throw new Error(`${name} HEAD 与 origin/${branch} 分叉；请手动处理，更新器不会 reset 源码`);
  }
  if (explicit.startsWith('-') || /[\x00-\x20]/.test(explicit)) throw new Error(`无效引用: ${explicit}`);
  let target;
  for (const ref of [`refs/remotes/origin/${explicit}`, `refs/tags/${explicit}`, explicit]) {
    const result = await attempt(tools, dir, ['rev-parse', '--verify', `${ref}^{commit}`]);
    if (result.status === 0) { target = result.stdout.trim(); break; }
  }
  if (!target) {
    const remoteBranch = await tools.git(dir, ['ls-remote', '--heads', 'origin', `refs/heads/${explicit}`]);
    if (remoteBranch) {
      await tools.git(dir, ['fetch', 'origin', `+refs/heads/${explicit}:refs/remotes/origin/${explicit}`]);
      target = await tools.git(dir, ['rev-parse', `refs/remotes/origin/${explicit}^{commit}`]);
    } else if (/^[0-9a-f]{40,64}$/i.test(explicit)) {
      const retrieved = await attempt(tools, dir, ['fetch', 'origin', explicit]);
      if (retrieved.status === 0) target = await tools.git(dir, ['rev-parse', `${explicit}^{commit}`]);
    } else if (/^[0-9a-f]{7,39}$/i.test(explicit) && await completeHistory(tools, dir)) {
      const abbreviated = await attempt(tools, dir, ['rev-parse', '--verify', `${explicit}^{commit}`]);
      if (abbreviated.status === 0) target = abbreviated.stdout.trim();
    }
  }
  if (!target) throw new Error(`${name} 找不到远端分支/tag/hash ${explicit}`);
  if (!await remoteReachable(tools, dir, target)) throw new Error(`${name} 的 ${explicit} 尚不可从 origin 获取；先推送源码`);
  return target;
}

export function validateDist(dir, expectedSha, expectedStamp) {
  let stamp;
  try { stamp = JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8')).gitHash; } catch {}
  if (typeof stamp !== 'string' || stamp.length < 7 || !expectedSha.startsWith(stamp) || expectedStamp && stamp !== expectedStamp) {
    throw new Error(`产物戳 ${stamp ?? '(缺失)'} 与 nuwax ${expectedSha.slice(0, 9)} 不匹配`);
  }
  if (!fs.existsSync(path.join(dir, 'index.html')) || !fs.statSync(path.join(dir, 'index.html')).isFile()) throw new Error(`产物缺少 index.html: ${dir}`);
  return stamp;
}

function copyAssets(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const name of fs.readdirSync(destination)) {
    if (name !== '.git' && name !== 'README.md') fs.rmSync(path.join(destination, name), { recursive: true, force: true });
  }
  for (const name of fs.readdirSync(source)) {
    if (name !== '.git' && name !== 'README.md') fs.cpSync(path.join(source, name), path.join(destination, name), { recursive: true, verbatimSymlinks: true });
  }
}

async function commitAssets(tools, dir, stamp) {
  if (!await tools.git(dir, ['status', '--porcelain'])) return null;
  await tools.git(dir, ['add', '-A']);
  await tools.git(dir, ['commit', '-m', `build(dist): refresh client assets at ${stamp}`]);
  return tools.git(dir, ['rev-parse', 'HEAD']);
}

async function pushAssets(tools, module, snapshot, stamp, generated, unpublishedAtStart, baseline) {
  const first = await attempt(tools, module.dir, ['push', 'origin', 'HEAD:refs/heads/main']);
  if (first.status === 0) return;
  await fetch(tools, module.dir);
  const head = await tools.git(module.dir, ['rev-parse', 'HEAD']);
  const remote = await tools.git(module.dir, ['rev-parse', 'origin/main']);
  if (await ancestor(tools, module.dir, remote, head)) throw new Error(`产物推送失败，请修复认证或网络后重试：${first.stderr}`);
  if (!generated || unpublishedAtStart || head !== generated || !snapshot || !await ancestor(tools, module.dir, baseline, remote)) {
    throw new Error('产物远端被更新；保留本地提交，请先手动整合 origin/main 后重试（不会强推）');
  }
  // Only this invocation's disposable artifact commit may be replaced.
  warn('产物远端被更新，基于最新 origin/main 重做本轮产物提交一次');
  await tools.git(module.dir, ['reset', '--hard', 'origin/main']);
  copyAssets(snapshot, module.dir);
  validateDist(module.dir, await tools.git(path.join(path.dirname(module.dir), 'nuwax'), ['rev-parse', 'HEAD']), stamp);
  await commitAssets(tools, module.dir, stamp);
  const retry = await attempt(tools, module.dir, ['push', 'origin', 'HEAD:refs/heads/main']);
  if (retry.status !== 0) throw new Error(`产物再次推送失败；保留本地提交，请手动整合后重试（不会强推）：${retry.stderr}`);
}

async function pushRoot(tools, root, modules) {
  for (const module of Object.values(modules)) {
    const sha = await tools.git(root, ['rev-parse', `HEAD:${module.name}`]);
    if (!await remoteReachable(tools, module.dir, sha)) throw new Error(`${module.name} pin ${sha.slice(0, 9)} 尚不可从 origin 获取，拒绝推送外层`);
  }
  const branch = await tools.git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!branch) throw new Error('外层为 detached HEAD，不能 --push；先创建分支');
  const advertised = await tools.git(root, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
  const remoteSha = advertised.split(/\s+/)[0];
  if (remoteSha) {
    await tools.git(root, ['fetch', 'origin', `refs/heads/${branch}`]);
    const fetched = await tools.git(root, ['rev-parse', 'FETCH_HEAD']);
    if (fetched !== remoteSha) throw new Error(`外层 origin/${branch} 正在变化；请 fetch 后重新运行 --push`);
    if (!await ancestor(tools, root, remoteSha, 'HEAD')) throw new Error(`外层 origin/${branch} 被更新；请整合远端再推送，不会强推`);
  }
  const result = await attempt(tools, root, ['push', '--set-upstream', 'origin', `HEAD:refs/heads/${branch}`]);
  if (result.status !== 0) throw new Error(`外层推送失败；请检查认证/网络并整合远端后重试，不会强推：${result.stderr}`);
}

async function isolatedTests(root, modules, tools) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-update-tests-'));
  const checkout = path.join(temp, 'client');
  try {
    await tools.run('git', ['clone', '--no-hardlinks', '--', root, checkout], { cwd: temp });
    for (const entry of fs.readdirSync(root)) {
      if (['.git', '.cache', 'node_modules', ...names].includes(entry) || entry.startsWith('.env')) continue;
      fs.cpSync(path.join(root, entry), path.join(checkout, entry), { recursive: true, verbatimSymlinks: true });
    }
    for (const module of Object.values(modules)) {
      const destination = path.join(checkout, module.name);
      await tools.run('git', ['clone', '--no-hardlinks', '--', module.dir, destination], { cwd: checkout });
      const sha = await tools.git(module.dir, ['rev-parse', 'HEAD']);
      await tools.git(destination, ['checkout', '--detach', sha]);
      if (module.name === 'nuwax-dist') copyAssets(module.dir, destination);
      if (module.name === 'nuwa-electron-shell') {
        for (const relative of ['node_modules', 'crates/agent-electron-client/node_modules', 'crates/agent-kit/node_modules', 'crates/agent-kit/dist', 'crates/agent-gui-server/node_modules']) {
          const dependencies = path.join(module.dir, relative);
          if (fs.existsSync(dependencies)) fs.cpSync(dependencies, path.join(destination, relative), { recursive: true, verbatimSymlinks: true });
        }
      }
    }
    await tools.npmRun(checkout, 'test:scripts');
    const base = path.join(checkout, 'nuwa-electron-shell');
    if (!fs.existsSync(path.join(base, 'crates/agent-electron-client/node_modules/.bin', process.platform === 'win32' ? 'vitest.cmd' : 'vitest'))) {
      await tools.run(process.execPath, [path.join(checkout, 'scripts/sync-overlay.js')], { cwd: checkout });
      const kit = path.join(base, 'crates/agent-kit');
      await tools.pnpmRun(kit, ['install', '--ignore-workspace', fs.existsSync(path.join(kit, 'pnpm-lock.yaml')) ? '--frozen-lockfile' : '--lockfile=false'], { env: { ...process.env, CI: 'true' } });
      await tools.pnpmRun(kit, ['run', 'build']);
      await tools.pnpmRun(base, ['install', '--frozen-lockfile', '--filter', '@nuwax-ai/nuwaclaw...'], { env: { ...process.env, CI: 'true' } });
    }
    const client = path.join(base, 'crates/agent-electron-client');
    if (!fs.existsSync(path.join(client, 'resources/mcp-proxy-ts/dist/host/rewrite.js'))) await tools.npmRun(client, 'prepare:mcp-proxy');
    await tools.npmRun(checkout, 'test:commercial');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

/** Update source + generated assets, then commit only the outer gitlinks. */
export async function update(root, options = {}, dependencies = {}) {
  const tools = { ...core, ...dependencies };
  const build = dependencies.buildFrontend ?? buildFrontend;
  const modules = await declared(tools, root);
  if (options.noCommit && options.push) throw new Error('--no-commit 不能与 --push 一起使用');
  if (options.noBuild && options.forceBuild) throw new Error('--no-build 不能与 --force-build 一起使用');
  if (options.dryRun) {
    message(`dry-run: 更新 ${options.nuwax ?? modules.nuwax.branch} → 构建 → nuwax-dist/main → 双 pin${options.push ? ' → 推送外层' : ''}`);
    return { dryRun: true, modules: names, noCommit: Boolean(options.noCommit) };
  }
  const outerDirty = await tools.git(root, ['status', '--porcelain', '--ignore-submodules=all']);
  if (outerDirty && !options.force) throw new Error('外层有未提交改动；先保留改动，或 --force 允许无关 WIP（仍只提交 gitlink）');
  if (await tools.git(root, ['status', '--porcelain', '--', '.gitmodules'])) throw new Error('.gitmodules 有未提交改动；先提交子模块声明，避免生成无法检出的 pin');
  for (const module of Object.values(modules)) {
    if (!fs.existsSync(path.join(module.dir, '.git'))) await tools.git(root, ['submodule', 'update', '--init', '--', module.name]);
    if (module.name !== 'nuwa-electron-shell') await cleanSource(tools, module.dir, module.name === 'nuwax');
  }
  return tools.withLock(root, 'update', async () => {
  let temporary;
  try {
    const targets = {};
    for (const name of ['nuwa-electron-shell', 'nuwax']) targets[name] = await resolveTarget(tools, modules[name], options[name === 'nuwax' ? 'nuwax' : 'shell']);
    const shellHead = await tools.git(modules['nuwa-electron-shell'].dir, ['rev-parse', 'HEAD']);
    const shellOverlay = targets['nuwa-electron-shell'] !== shellHead ? await managedOverlayChanges(tools, root, modules['nuwa-electron-shell'].dir) : [];
    // Resolve all source refs before changing either source checkout.
    for (const name of ['nuwa-electron-shell', 'nuwax']) {
      if (name === 'nuwax') await cleanScratch(tools, modules[name].dir);
      if (await tools.git(modules[name].dir, ['rev-parse', 'HEAD']) !== targets[name]) {
        if (name === 'nuwa-electron-shell') await moveShell(tools, root, modules[name], targets[name], shellOverlay);
        else await tools.git(modules[name].dir, ['checkout', '--detach', targets[name]]);
      }
    }
    const sourceSha = targets.nuwax;
    const stamp = await tools.git(modules.nuwax.dir, ['rev-parse', '--short', 'HEAD']);
    const distModule = modules['nuwax-dist'];
    await fetch(tools, distModule.dir);
    const baseline = await tools.git(distModule.dir, ['rev-parse', 'HEAD']);
    let remote = await tools.git(distModule.dir, ['rev-parse', 'origin/main']);
    if (!await ancestor(tools, distModule.dir, baseline, remote) && !await ancestor(tools, distModule.dir, remote, baseline) && await completeHistory(tools, distModule.dir)) {
      remote = await tools.git(distModule.dir, ['rev-parse', 'origin/main']);
    }
    const unpublished = !await ancestor(tools, distModule.dir, baseline, remote);
    if (unpublished && !await ancestor(tools, distModule.dir, remote, baseline)) throw new Error('nuwax-dist HEAD 与 origin/main 分叉；请手动整合后重试');
    await tools.git(distModule.dir, ['checkout', '-B', 'main', unpublished ? baseline : remote]);
    let matches = false;
    try { validateDist(distModule.dir, sourceSha, stamp); matches = true; } catch {}
    if (options.noBuild && !matches) throw new Error('--no-build 要求 nuwax-dist 已有与目标源码一致的完整产物');
    let generated = null;
    let snapshot;
    if (!options.noBuild && (options.forceBuild || !matches)) {
      temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-update-dist-'));
      snapshot = path.join(temporary, 'dist');
      try {
        const result = await build(root, { expectedSha: sourceSha, allowDirty: false, restoreGenerated: true, cleanDist: false });
        if (result.sourceSha !== sourceSha) throw new Error('构建期间 nuwax HEAD 发生变化；拒绝发布产物');
        validateDist(result.distDir, sourceSha, stamp);
        fs.cpSync(result.distDir, snapshot, { recursive: true, verbatimSymlinks: true });
      } finally { await cleanScratch(tools, modules.nuwax.dir); }
      copyAssets(snapshot, distModule.dir);
      validateDist(distModule.dir, sourceSha, stamp);
      if (!options.noCommit) generated = await commitAssets(tools, distModule.dir, stamp);
    }
    if (await tools.git(modules.nuwax.dir, ['rev-parse', 'HEAD']) !== sourceSha) throw new Error('nuwax HEAD 在更新期间发生变化，拒绝发布双 pin');
    if (options.withTest) await (dependencies.isolatedTests ?? isolatedTests)(root, modules, tools);
    if (!options.noCommit && !options.noPushDist) await pushAssets(tools, distModule, snapshot, stamp, generated, unpublished, baseline);
    if (!options.noCommit && options.noPushDist) warn('已跳过产物推送；外层本地 pin 在产物推送前不能用于 CI');
    for (const name of ['nuwa-electron-shell', 'nuwax']) {
      if (await tools.git(modules[name].dir, ['rev-parse', 'HEAD']) !== targets[name]) throw new Error(`${name} HEAD 在更新期间发生变化，拒绝提交双 pin`);
    }
    if (!options.noCommit) await cleanSource(tools, distModule.dir);
    const changed = [];
    for (const name of names) {
      const old = await tools.git(root, ['rev-parse', `HEAD:${name}`]);
      const current = await tools.git(modules[name].dir, ['rev-parse', 'HEAD']);
      if (old !== current) changed.push(name);
    }
    if (changed.length && !options.noCommit) {
      await tools.git(root, ['commit', '--only', '-m', `chore(submodules): update client pins at ${stamp}`, '--', ...changed]);
    }
    if (options.push) await pushRoot(tools, root, modules);
    const result = { sourceSha, stamp, distSha: await tools.git(distModule.dir, ['rev-parse', 'HEAD']), changed, committed: !options.noCommit, pushedDist: !options.noCommit && !options.noPushDist };
    message(`完成 nuwax=${sourceSha.slice(0, 9)} nuwax-dist=${result.distSha.slice(0, 9)}${options.noCommit ? '（未提交/推送）' : ''}`);
    return result;
  } finally {
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  }
  });
}
