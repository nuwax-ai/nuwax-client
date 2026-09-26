import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import config from '../../client.config.mjs';
import { run, git, withLock } from './core.mjs';

const platforms = ['macos-arm64', 'macos-x64', 'windows-x64', 'linux-x64', 'linux-arm64'];
const shaPattern = /^[a-f0-9]{40}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function releaseIdentity(channel, version) {
  if (!['stable', 'beta'].includes(channel)) throw new Error('channel 须为 stable 或 beta');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '')) throw new Error('版本须显式指定为 x.y.z');
  return { channel, version, tag: `${channel === 'stable' ? 'electron' : 'prerelease'}-v${version}`,
    buildWorkflow: channel === 'stable' ? 'release-electron.yml' : 'release-electron-dev.yml',
    windows: channel === 'stable' ? `Nuwax.Setup.${version}.exe` : `Nuwax-Setup-${version}-unsigned.exe` };
}

function remoteTagSha(output, tag) {
  const lines = output.trim().split('\n').map((line) => line.split(/\s+/));
  return lines.find(([, ref]) => ref === `refs/tags/${tag}^{}`)?.[0]
    ?? lines.find(([, ref]) => ref === `refs/tags/${tag}`)?.[0] ?? null;
}

export function selectRun(runs, { tag, sha, event = 'push', title, branch, afterId = 0 }) {
  return runs.filter((entry) => entry.headSha === sha && entry.event === event &&
    entry.headBranch === (branch ?? tag) && (!title || entry.displayTitle === title) &&
    Number(entry.databaseId) > afterId).sort((a, b) => b.databaseId - a.databaseId)[0];
}

export function verifyManifests(manifests, assets, identity, source) {
  const names = new Map(assets.map((asset) => [asset.name, asset]));
  const required = {
    'macos-arm64': [`Nuwax-${identity.version}-arm64.dmg`, `Nuwax-${identity.version}-arm64-mac.zip`],
    'macos-x64': [`Nuwax-${identity.version}.dmg`, `Nuwax-${identity.version}-mac.zip`],
    'windows-x64': [`Nuwax-Setup-${identity.version}-unsigned.exe`],
    'linux-x64': [`Nuwax-${identity.version}.AppImage`],
    'linux-arm64': [`Nuwax-${identity.version}-arm64.AppImage`],
  };
  for (const key of platforms) {
    const value = manifests[key];
    if (value?.schemaVersion !== 1 || value.tag !== identity.tag || `${value.platform}-${value.arch}` !== key)
      throw new Error(`build-manifest-${key}.json 平台或 tag 不匹配`);
    for (const name of ['client', 'shell', 'frontend']) {
      if (!shaPattern.test(value.source?.[name] ?? '') || value.source[name] !== source[name])
        throw new Error(`build-manifest-${key}.json ${name} 来源与发布 pin 不匹配`);
    }
    if (!/^[a-f0-9]{7,40}$/.test(value.frontend?.stamp ?? '') || !source.frontend.startsWith(value.frontend.stamp) ||
        !hashPattern.test(value.frontend?.distSha256 ?? '')) throw new Error(`${key} 前端版本记录不匹配`);
    for (const filename of required[key]) {
      if (!hashPattern.test(value.artifacts?.[filename] ?? '')) throw new Error(`${key} 缺构建资产记录 ${filename}`);
    }
    for (const [filename, digest] of Object.entries(value.artifacts ?? {})) {
      if (/[\\/]/.test(filename) || path.basename(filename) !== filename || !hashPattern.test(digest)) throw new Error(`${key} 无效资产记录`);
      const asset = names.get(filename);
      if (!asset && identity.channel === 'stable' && key === 'windows-x64' && filename.endsWith('-unsigned.exe') && names.has(identity.windows)) continue;
      if (!asset) throw new Error(`Release 缺资产 ${filename}`);
      if (asset.digest && asset.digest !== `sha256:${digest}`) throw new Error(`${filename} 与 CI 构建 SHA256 不一致`);
    }
  }
  const signing = manifests['windows-x64'].windowsSigning;
  if (!Number.isSafeInteger(signing?.unsignedSize) || signing.unsignedSize <= 0 || !hashPattern.test(signing?.signingIdentitySha256 ?? ''))
    throw new Error('Windows 构建清单缺少签名来源记录');
}

function remoteScript(state, settings) {
  const { tag, sha, version, source } = state;
  const work = `${settings.windowsClientDir.replace(/\/$/, '')}/../.nuwax-release-${tag}-${sha.slice(0, 12)}`;
  // All paths and values are shell quoted; no caller-supplied text is interpolated as code.
  return `set -euo pipefail
export PATH=${quote(settings.signGhPath)}:"$PATH"
repo=${quote(settings.windowsClientDir)}
work=${quote(work)}
git -C "$repo" fetch origin ${quote(`refs/tags/${tag}`)}
test "$(git -C "$repo" rev-parse 'FETCH_HEAD^{commit}')" = ${quote(sha)}
if [ -d "$work" ]; then
  test "$(git -C "$work" rev-parse HEAD)" = ${quote(sha)}
  test -z "$(git -C "$work" status --porcelain --untracked-files=no --ignore-submodules=dirty)"
else
  git -C "$repo" worktree add --detach "$work" ${quote(sha)}
fi
cd "$work"
git submodule update --init nuwa-electron-shell
test "$(git -C nuwa-electron-shell rev-parse HEAD)" = ${quote(source.shell)}
node scripts/sync-overlay.js
cd nuwa-electron-shell/crates/agent-electron-client
SIGN_RELEASE_REPO=${quote(settings.repo)} SIGN_WORK_DIR=${quote(`/c/tmp/nuwax-sign/${tag}-${sha.slice(0, 12)}`)} SIGN_WIN_ARTIFACT_PREFIX=Nuwax SIGN_SKIP_BLOCKMAP=true npm run sign:win -- ${quote(version)}
`;
}

async function hashResponse(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  const hash = createHash('sha256');
  for await (const chunk of response.body) hash.update(chunk);
  return hash.digest('hex');
}

function defaultAdapters(root, settings) {
  const execute = (command, args, options = {}) => run(command, args, { cwd: root, ...options });
  const gh = async (args) => JSON.parse((await execute('gh', args, { capture: true })).stdout || 'null');
  async function downloaded(asset, identity, action) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-release-'));
    try {
      await execute('gh', ['release', 'download', identity.tag, '--repo', settings.repo, '--pattern', asset.name, '--dir', directory]);
      return await action(path.join(directory, asset.name));
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
  return {
    git: (args, directory = root, options = {}) => git(directory, args, options),
    exec: execute, gh, sleep, log: console.log,
    fetchBytes: async (url) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
      return Buffer.from(await response.arrayBuffer());
    },
    hashUrl: hashResponse,
    assetJson: (asset, identity) => downloaded(asset, identity, (file) => JSON.parse(fs.readFileSync(file, 'utf8'))),
    assetHash: (asset, identity) => asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : downloaded(asset, identity, async (file) => {
      const hash = createHash('sha256');
      for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
      return hash.digest('hex');
    }),
  };
}

async function preflight(root, identity, options, tools, settings) {
  const findings = [];
  try { await tools.exec('gh', ['auth', 'status'], { capture: true }); }
  catch { findings.push('需要安装 gh 并完成 gh auth login'); }
  const sha = await tools.git(['rev-parse', 'HEAD']);
  const branch = await tools.git(['branch', '--show-current']);
  if (!branch) findings.push('须在远端可达的发布分支运行，不支持 detached HEAD');
  const notes = typeof options.notes === 'string' ? options.notes : `release-notes/${identity.tag}.md`;
  if (path.isAbsolute(notes) || notes.split(/[\\/]/).includes('..')) throw new Error('notes 须为仓库内相对路径');
  const status = await tools.git(['status', '--porcelain', '--untracked-files=no', '--ignore-submodules=dirty', '--', '.', ...(options.notes === true ? [`:(exclude)${notes}`] : [])]);
  if (status) findings.push(`外层存在未提交的受跟踪改动：${status}`);
  let noteCommitted = false;
  try { noteCommitted = Boolean((await tools.git(['show', `HEAD:${notes}`])).trim()); } catch { /* missing note */ }
  if (!noteCommitted && options.notes !== true) findings.push(`缺少已提交的说明 ${notes}`);
  if (options.notes === true && (!fs.existsSync(path.join(root, notes)) || !fs.readFileSync(path.join(root, notes), 'utf8').trim()))
    findings.push(`说明文件不存在或为空：${notes}`);
  if (branch) {
    const remote = (await tools.git(['ls-remote', 'origin', `refs/heads/${branch}`])).split(/\s/)[0];
    if (remote !== sha) findings.push(`远端分支 ${branch} 与当前 HEAD 不同；先推送发布提交`);
  }
  const source = { client: sha };
  for (const [name, folder] of [['shell', 'nuwa-electron-shell'], ['frontend', 'nuwax'], ['dist', 'nuwax-dist']]) {
    let pin;
    try { pin = await tools.git(['rev-parse', `HEAD:${folder}`]); } catch { if (name === 'dist') continue; throw new Error(`缺少 ${folder} gitlink`); }
    if (!shaPattern.test(pin)) { findings.push(`${folder} 不是有效 gitlink`); continue; }
    source[name] = pin;
    const url = await tools.git(['config', '-f', '.gitmodules', '--get', `submodule.${folder}.url`]);
    const declared = await tools.git(['config', '-f', '.gitmodules', '--get', `submodule.${folder}.branch`]);
    const refs = await tools.git(['ls-remote', '--heads', '--tags', url]);
    if (!refs.split('\n').some((line) => line.startsWith(`${pin}\t`))) {
      const repo = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/.exec(url)?.[1];
      if (!repo || !declared) findings.push(`${folder} pin 远端可达性无法确认`);
      else {
        try {
          const compare = await tools.gh(['api', `repos/${repo}/compare/${pin}...${encodeURIComponent(declared)}`]);
          if (!['ahead', 'identical'].includes(compare.status)) findings.push(`${folder} pin 不在远端 ${declared} 历史中`);
        } catch { findings.push(`${folder} pin 远端无法获取`); }
      }
    }
    const directory = path.join(root, folder);
    if (fs.existsSync(path.join(directory, '.git'))) {
      if (await tools.git(['rev-parse', 'HEAD'], directory) !== pin) findings.push(`${folder} 当前 HEAD 与发布 pin 不同`);
      const dirty = await tools.git(['diff', 'HEAD', '--name-only'], directory);
      for (const file of dirty.split('\n').filter(Boolean)) {
        const overlay = path.join(root, 'overlay', file), target = path.join(directory, file);
        const managed = name === 'shell' && file !== 'README.md' && fs.existsSync(overlay) && fs.existsSync(target) &&
          fs.readFileSync(overlay).equals(fs.readFileSync(target));
        if (!managed) findings.push(`${folder} 受跟踪文件未提交：${file}`);
      }
    }
  }
  const remote = await tools.git(['ls-remote', 'origin', `refs/tags/${identity.tag}`, `refs/tags/${identity.tag}^{}`]);
  const tagSha = remoteTagSha(remote, identity.tag);
  if (tagSha && tagSha !== sha) findings.push(`远端 ${identity.tag} 已指向另一提交 ${tagSha}，禁止改 tag；请使用新版本`);
  return { ...identity, sha, branch, source, notes, findings, tagSha, settings };
}

async function lookupRun(tools, settings, workflow, criteria, options) {
  for (let attempt = 0; attempt < (options.lookupAttempts ?? 30); attempt++) {
    const runs = await tools.gh(['run', 'list', '--repo', settings.repo, '--workflow', workflow, '--limit', '100',
      '--json', 'databaseId,headBranch,headSha,event,status,conclusion,displayTitle']);
    const match = selectRun(runs, criteria);
    if (match) return match;
    if (attempt + 1 < (options.lookupAttempts ?? 30)) await tools.sleep(options.lookupInterval ?? 5000);
  }
  throw new Error(`未找到 ${criteria.tag} 同 tag/SHA/event 的 workflow run：${workflow}；重跑可续接`);
}

async function waitRun(tools, settings, entry, options) {
  for (let attempt = 0; attempt < (options.pollAttempts ?? 360); attempt++) {
    const current = entry.status === 'completed' ? entry : await tools.gh(['run', 'view', String(entry.databaseId), '--repo', settings.repo, '--json', 'status,conclusion,jobs']);
    if (current.status === 'completed') return current;
    if (attempt % 2 === 0) tools.log(`[release] run ${entry.databaseId}: ${current.status}`);
    await tools.sleep(options.pollInterval ?? 30000);
  }
  throw new Error(`workflow ${entry.databaseId} 等待超时；重跑可继续跟踪`);
}

function requireSuccess(runResult, id) {
  if (runResult.status !== 'completed' || runResult.conclusion !== 'success') throw new Error(`workflow ${id} 未成功：${runResult.conclusion ?? runResult.status}；排障后重跑`);
}

async function releaseView(tools, settings, identity) {
  const value = await tools.gh(['api', `repos/${settings.repo}/releases/tags/${identity.tag}`]);
  if (value.tag_name !== identity.tag || Boolean(value.prerelease) !== (identity.channel === 'beta')) throw new Error('Release tag/通道状态不匹配');
  return value;
}

async function manifestsFromRelease(tools, identity, view, source) {
  const manifests = {};
  for (const key of platforms) {
    const filename = `build-manifest-${key}.json`;
    const asset = view.assets.find((entry) => entry.name === filename);
    if (!asset) throw new Error(`Release 缺资产 ${filename}`);
    manifests[key] = await tools.assetJson(asset, identity);
  }
  verifyManifests(manifests, view.assets, identity, source);
  return manifests;
}

async function pointers(tools, settings, identity) {
  const folder = identity.channel === 'stable' ? 'latest' : 'beta';
  const [s3, oss] = await Promise.all([settings.s3Base, settings.ossBase].map((base) => tools.fetchBytes(`${base}/${folder}/latest.json`)));
  if (!Buffer.from(s3).equals(Buffer.from(oss))) throw new Error('S3/OSS 通道指针字节不一致');
  const value = JSON.parse(Buffer.from(s3).toString());
  if (value.version !== identity.version) throw new Error(`通道指针版本 ${value.version}，期望 ${identity.version}`);
  return { value, bytes: Buffer.from(s3) };
}

export async function verifyMirrors(tools, settings, identity, view, source) {
  if (view.draft) throw new Error('Release 尚未公开');
  const { value, bytes } = await pointers(tools, settings, identity);
  const prefix = identity.channel === 'beta' ? `beta-build/${identity.tag}` : identity.tag;
  const base = `${settings.s3Base}/${prefix}`;
  const provenanceAsset = view.assets.find((asset) => asset.name === 'release-provenance.json');
  if (!provenanceAsset) throw new Error('Release 缺少最终 release-provenance.json');
  const provenance = await tools.assetJson(provenanceAsset, identity);
  if (provenance.tag !== identity.tag || ['client', 'shell', 'frontend'].some((key) => provenance.source?.[key] !== source[key]))
    throw new Error('最终来源清单与发布 pin 不一致');
  for (const key of ['darwin-aarch64', 'darwin-aarch64-zip', 'darwin-x86_64', 'darwin-x86_64-zip', 'windows-x86_64', 'linux-x86_64', 'linux-aarch64']) {
    const platform = value.platforms?.[key];
    if (!platform || !platform.url.startsWith(`${base}/`) || !Number.isSafeInteger(platform.size) || platform.size <= 0 ||
        !/^[A-Za-z0-9+/]{86}==$/.test(platform.signature ?? '')) throw new Error(`更新指针 ${key} 缺失或格式错误`);
    const filename = decodeURIComponent(new URL(platform.url).pathname.split('/').at(-1));
    const asset = view.assets.find((entry) => entry.name === filename);
    if (!asset || asset.size !== platform.size || !provenance.assets?.[filename]) throw new Error(`${key} 更新指针资产或大小不匹配`);
  }
  if (value.platforms['windows-x86_64'].url !== `${base}/${identity.windows}`) throw new Error('Windows 更新指针未指向渠道对应安装包');
  for (const [platform, filename] of [['darwin', 'latest-mac.yml'], ['linux', 'latest-linux.yml'], ['win', 'latest.yml']]) {
    if (value.yml?.[platform] !== `${base}/${filename}`) throw new Error(`${platform} 更新元数据 URL 不匹配`);
  }
  for (const filename of ['latest.json', 'latest.yml', 'latest-mac.yml', 'latest-linux.yml', 'latest-linux-arm64.yml', 'latest-linux-x64.yml']) {
    if (!view.assets.some((asset) => asset.name === filename) || !hashPattern.test(provenance.assets?.[filename] ?? ''))
      throw new Error(`缺少最终更新元数据 ${filename}`);
  }
  if (sha256(bytes) !== provenance.assets?.['latest.json']) throw new Error('通道指针与最终元数据 SHA256 不一致');
  const checked = new Set();
  for (const asset of view.assets) {
    if (/[\\/]/.test(asset.name) || path.basename(asset.name) !== asset.name) throw new Error('无效 Release 资产路径');
    const expected = await tools.assetHash(asset, identity);
    if (!hashPattern.test(expected)) throw new Error(`${asset.name} 缺少有效 GitHub SHA256`);
    if (!asset.name.startsWith('build-manifest-') && asset.name !== 'release-provenance.json' && expected !== provenance.assets?.[asset.name])
      throw new Error(`${asset.name} GitHub 资产与来源清单 SHA256 不一致`);
    if (await tools.hashUrl(`${base}/${asset.name}`) !== expected) throw new Error(`S3 资产 SHA256 不一致：${asset.name}`);
    if (asset.name.endsWith('.yml') || asset.name === 'latest.json') {
      if (await tools.hashUrl(`${settings.ossBase}/${prefix}/${asset.name}`) !== expected) throw new Error(`OSS 元数据 SHA256 不一致：${asset.name}`);
    }
    checked.add(asset.name);
  }
  for (const filename of Object.keys(provenance.assets ?? {})) if (!checked.has(filename)) throw new Error(`最终来源清单资产缺失：${filename}`);
  return { version: value.version, assetsVerified: checked.size, windows: value.platforms['windows-x86_64'].url };
}

export async function release(root, options = {}, injected = {}) {
  const identity = releaseIdentity(options.channel ?? 'stable', options.version);
  const settings = { ...config.release, ...(options.settings ?? {}),
    signHost: process.env.RELEASE_SIGN_HOST ?? options.settings?.signHost ?? config.release.signHost,
    windowsClientDir: process.env.WIN_CLIENT_DIR ?? options.settings?.windowsClientDir ?? config.release.windowsClientDir,
    signGhPath: process.env.SIGN_GH_PATH ?? options.settings?.signGhPath ?? config.release.signGhPath };
  const tools = { ...defaultAdapters(root, settings), ...injected, ...(options.adapters ?? {}) };
  const state = await preflight(root, identity, options, tools, settings);
  const steps = ['校验已提交发布说明、远端 HEAD 与子模块 pin', `确保不可变 tag ${identity.tag} 指向 ${state.sha}`,
    `跟踪 ${identity.buildWorkflow} 同 tag/SHA 的 push run`, '校验五平台来源及安装资产',
    ...(identity.channel === 'stable' ? [`在 ${settings.signHost} 使用 tagged 签名脚本；SimplySign 手机认证须人工完成`, 'dispatch 同步 workflow，固定当前分支 ref'] : ['跟踪自动 beta 同步；同步失败可重跑续接']),
    '验证公开 Release、GitHub/S3/OSS SHA256 与通道指针'];
  if (options.dryRun) {
    const result = { dryRun: true, ok: state.findings.length === 0, tag: identity.tag, source: state.source, branch: state.branch, notes: state.notes,
      findings: state.findings, steps, signHost: settings.signHost, ...(options.notes === true ? { notesCommitPlanned: true } : {}) };
    tools.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (state.findings.length) throw new Error(state.findings.join('\n'));
  if (options.notes === true) {
    const dirtyNotes = await tools.git(['status', '--porcelain', '--untracked-files=all', '--', state.notes]);
    if (dirtyNotes) {
      if (state.tagSha) throw new Error('tag 已存在，不能在续跑时修改该版本说明；请创建新版本');
      await tools.git(['add', '--', state.notes]);
      await tools.git(['commit', '--only', '-m', `docs(release-notes): ${identity.tag}`, '--', state.notes]);
      await tools.git(['push', 'origin', `HEAD:refs/heads/${state.branch}`]);
      state.sha = await tools.git(['rev-parse', 'HEAD']);
      state.source.client = state.sha;
    }
  }
  if (!state.tagSha) {
    let localTag;
    try { localTag = await tools.git(['rev-parse', `refs/tags/${identity.tag}^{commit}`]); } catch { /* no local tag */ }
    if (localTag && localTag !== state.sha) throw new Error(`本地 ${identity.tag} 指向另一提交；禁止自动改 tag`);
    if (!localTag) await tools.git(['tag', identity.tag, state.sha]);
    await tools.git(['push', 'origin', `refs/tags/${identity.tag}:refs/tags/${identity.tag}`]);
    const pushed = remoteTagSha(await tools.git(['ls-remote', 'origin', `refs/tags/${identity.tag}`, `refs/tags/${identity.tag}^{}`]), identity.tag);
    if (pushed !== state.sha) throw new Error('tag 推送后远端 SHA 不匹配');
  }
  const build = await lookupRun(tools, settings, identity.buildWorkflow, { tag: identity.tag, sha: state.sha }, options);
  const buildResult = await waitRun(tools, settings, build, options);
  if (identity.channel === 'stable') requireSuccess(buildResult, build.databaseId);
  else if (buildResult.conclusion !== 'success') {
    const result = buildResult.jobs ? buildResult : await tools.gh(['run', 'view', String(build.databaseId), '--repo', settings.repo, '--json', 'jobs']);
    const expectedJobs = ['macos-latest arm64', 'macos-latest x64', 'windows-latest x64', 'ubuntu-24.04 x64', 'ubuntu-24.04-arm arm64'];
    if (!expectedJobs.every((suffix) => result.jobs?.some((job) => job.name === `Build Electron (${suffix})` && job.status === 'completed' && job.conclusion === 'success')))
      throw new Error(`beta 五平台构建未全部成功：run ${build.databaseId}`);
    tools.log('[release] beta 构建完成，自动同步失败；继续同步重试');
  }
  let view = await releaseView(tools, settings, identity);
  await manifestsFromRelease(tools, identity, view, state.source);
  if (identity.channel === 'stable' && !view.assets.some((asset) => asset.name === identity.windows)) {
    tools.log(`[release] Windows 签名阶段：请确认 ${settings.signHost} SimplySign Desktop 已完成手机认证`);
    const script = remoteScript(state, settings);
    try { await tools.exec('ssh', [settings.signHost, `bash -lc ${quote(script)}`]); }
    catch (error) { throw new Error(`Windows 签名未完成。请在 ${settings.signHost} 完成 SimplySign 手机认证并检查证书/工具；重跑同版本可续接。${error.message}`); }
    view = await releaseView(tools, settings, identity);
    if (!view.assets.some((asset) => asset.name === identity.windows)) throw new Error(`签名后仍缺少 ${identity.windows}`);
  }
  // Successful sync performs osslsigncode + PE provenance checks. Public assets alone never bypass it.
  const title = `Sync ${identity.channel} ${identity.tag}`;
  const syncRuns = await tools.gh(['run', 'list', '--repo', settings.repo, '--workflow', 'sync-electron-to-oss.yml', '--limit', '100', '--json', 'databaseId,headBranch,headSha,event,status,conclusion,displayTitle']);
  const criteria = { tag: identity.tag, sha: state.sha, event: 'workflow_dispatch', title, branch: state.branch };
  const successfulSync = selectRun(syncRuns.filter((entry) => entry.status === 'completed' && entry.conclusion === 'success'), criteria);
  let verified;
  if (!view.draft && (successfulSync || (identity.channel === 'beta' && buildResult.conclusion === 'success'))) {
    try { verified = await verifyMirrors(tools, settings, identity, view, state.source); }
    catch (error) { tools.log(`[release] 发布验证未就绪：${error.message}`); }
  }
  if (!verified) {
    let sync = selectRun(syncRuns, criteria);
    if (!sync || sync.status === 'completed') {
      // dispatch resolves a branch ref: compare it again immediately before the mutation.
      const remote = (await tools.git(['ls-remote', 'origin', `refs/heads/${state.branch}`])).split(/\s/)[0];
      if (remote !== state.sha) throw new Error(`发布分支 ${state.branch} 已被推进；请在 tag 对应分支提交续跑，禁止 dispatch 错误 SHA`);
      const previousId = sync?.databaseId ?? 0;
      await tools.exec('gh', ['workflow', 'run', 'sync-electron-to-oss.yml', '--repo', settings.repo, '--ref', state.branch, '-f', `tag=${identity.tag}`, '-f', `channel=${identity.channel}`]);
      sync = await lookupRun(tools, settings, 'sync-electron-to-oss.yml', { ...criteria, afterId: previousId }, options);
    }
    const result = await waitRun(tools, settings, sync, options);
    requireSuccess(result, sync.databaseId);
    view = await releaseView(tools, settings, identity);
    verified = await verifyMirrors(tools, settings, identity, view, state.source);
  }
  const result = { tag: identity.tag, source: state.source, ...verified, releaseUrl: `https://github.com/${settings.repo}/releases/tag/${identity.tag}` };
  tools.log(`[release] 完成：${identity.tag} ${identity.channel} 全链发布就绪；${verified.assetsVerified} 个资产 SHA256 已校验`);
  return result;
}

// Legacy shell wrapper uses this CLI; root client dispatcher imports release().
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const options = { channel: 'stable' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--channel') options.channel = argv[++i];
    else if (argv[i] === '--version') options.version = argv[++i];
    else if (argv[i] === '--dry-run') options.dryRun = true;
    else if (argv[i] === '--notes') options.notes = true;
    else if (!argv[i].startsWith('-') && !options.version) options.version = argv[i];
    else throw new Error(`未知参数 ${argv[i]}`);
  }
  const action = () => release(process.cwd(), options);
  (options.dryRun ? action() : withLock(process.cwd(), 'operation', action))
    .catch((error) => { console.error(`[release] ${error.message}`); process.exitCode = 1; });
}
