import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseReleaseTag, compareReleaseVersions } from './release-version.mjs';

export const MAX_VALIDATION_STARTS = 4;
const workflowFile = 'package-validation.yml';
const root = fileURLToPath(new URL('..', import.meta.url));
const gitAt = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const restartFile = '.github/package-validation-restart.json';
const restartToolingPaths = new Set([restartFile, 'scripts/package-validation.mjs',
  'scripts/package-validation.test.mjs', 'docs/dsh-runtime-acceptance.md']);

function approvedRestart(cwd, identity) {
  if (!gitAt(cwd, 'ls-tree', '--name-only', identity.source.client, '--', restartFile)) return undefined;
  // Read the committed record, never a mutable workspace override. This records
  // explicit user approval; it does not infer approval from a failed build.
  const record = JSON.parse(gitAt(cwd, 'show', `${identity.source.client}:${restartFile}`));
  if (record.series !== identity.series) return undefined;
  if (record.schema !== 1 || record.additionalStarts !== 1 ||
      record.authority?.kind !== 'explicit-user-approval' || typeof record.authority.decision !== 'string' || !record.authority.decision.trim() ||
      !/^[a-f0-9]{40}$/.test(record.approvedSource ?? '') || record.baselineTag !== identity.baselineTag ||
      !Array.isArray(record.previousRuns) || !record.previousRuns.length ||
      record.previousRuns.some(run => !run || typeof run.id !== 'string' || !/^[1-9]\d*$/.test(run.id) || !Number.isSafeInteger(run.attempts) || run.attempts < 1) ||
      new Set(record.previousRuns.map(run => run.id)).size !== record.previousRuns.length ||
      record.previousRuns.reduce((total, run) => total + run.attempts, 0) !== MAX_VALIDATION_STARTS ||
      record.platform !== 'darwin' || record.arch !== 'arm64' || identity.matrix.length !== 1 ||
      identity.matrix[0].platform !== record.platform || identity.matrix[0].arch !== record.arch) {
    throw new Error('人工重启授权与本次版本、平台或历史不符，停止构建');
  }
  gitAt(cwd, 'merge-base', '--is-ancestor', record.approvedSource, identity.source.client);
  const changes = gitAt(cwd, 'diff', '--name-only', '--no-renames', record.approvedSource, identity.source.client).split('\n').filter(Boolean);
  if (changes.some(file => !restartToolingPaths.has(file))) throw new Error('应用源码超出人工批准的冻结提交，停止构建');
  return record;
}

export function validationIdentity(cwd, env = process.env) {
  const series = env.VALIDATION_SERIES ?? '';
  if (!/^[a-z][a-z0-9-]{2,62}$/.test(series)) throw new Error('validation_series 须为固定问题标识，如 pr-66；不能用换系列绕过停止条件');
  if (!/^refs\/heads\/(codex|validation)\/.+/.test(env.GITHUB_REF ?? '')) throw new Error('验证仅允许 codex/ 或 validation/ 分支，不能运行在正式发布分支或 tag');
  // A branch launch reads the frozen request, so an existing lower-version
  // baseline can exercise an upgrade without inventing a new release version.
  const request = env.GITHUB_EVENT_NAME === 'push'
    ? JSON.parse(fs.readFileSync(path.join(cwd, '.github/package-validation-request.json'), 'utf8')) : null;
  if (request && request.series !== series) throw new Error('显式验证请求与启动身份不符，停止构建');
  const target = parseReleaseTag(request ? request.baselineTag : env.VALIDATION_BASELINE_TAG);
  const sha = gitAt(cwd, 'rev-parse', 'HEAD');
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') || sha !== env.GITHUB_SHA) throw new Error('验证源码不是冻结的 workflow SHA');
  if (!/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? '')) throw new Error('缺少有效 run id / attempt');
  const platforms = { both: [{ runner: 'macos-latest', platform: 'darwin', arch: 'arm64' }, { runner: 'windows-latest', platform: 'win32', arch: 'x64' }],
    'mac-arm64': [{ runner: 'macos-latest', platform: 'darwin', arch: 'arm64' }],
    'mac-x64': [{ runner: 'macos-26-intel', platform: 'darwin', arch: 'x64' }],
    'windows-x64': [{ runner: 'windows-latest', platform: 'win32', arch: 'x64' }],
    'linux-x64': [{ runner: 'ubuntu-24.04', platform: 'linux', arch: 'x64' }],
    'linux-arm64': [{ runner: 'ubuntu-24.04-arm', platform: 'linux', arch: 'arm64' }] };
  platforms.all = ['mac-arm64', 'mac-x64', 'windows-x64', 'linux-x64', 'linux-arm64'].flatMap(name => platforms[name]);
  const selectedPlatforms = platforms[request ? request.platforms : env.VALIDATION_PLATFORMS];
  if (!selectedPlatforms) throw new Error('未知验证平台');
  const matrix = selectedPlatforms.map(item => ({ ...item, baselineTag: target.tag }));
  gitAt(cwd, 'rev-parse', '--verify', `refs/tags/${target.tag}^{commit}`);
  const upgradeFrom = request ? request.upgradeFromTag : env.VALIDATION_UPGRADE_FROM_TAG;
  if (upgradeFrom) {
    const previous = parseReleaseTag(upgradeFrom);
    if (!matrix.some(item => item.platform === 'darwin') || previous.channel !== target.channel ||
        compareReleaseVersions(previous.version, target.version) >= 0) throw new Error('Mac 升级基线须为同通道已存在的较低版本');
    gitAt(cwd, 'rev-parse', '--verify', `refs/tags/${previous.tag}^{commit}`);
    matrix.push({ ...selectedPlatforms.find(item => item.platform === 'darwin'), baselineTag: previous.tag });
  }
  const baseline = parseReleaseTag(env.VALIDATION_PACKAGE_BASELINE_TAG || target.tag);
  if (!matrix.some(item => item.baselineTag === baseline.tag)) throw new Error('构建版本不在冻结验证矩阵中');
  const baselineSha = gitAt(cwd, 'rev-parse', '--verify', `refs/tags/${baseline.tag}^{commit}`);
  const identity = { kind: 'package-validation', series, baselineTag: baseline.tag, baselineSha,
    packageVersion: baseline.version, nativeVersion: baseline.baseVersion, channel: baseline.channel,
    source: { client: sha, shell: gitAt(cwd, 'rev-parse', 'HEAD:nuwa-electron-shell'), frontend: gitAt(cwd, 'rev-parse', 'HEAD:nuwax'),
      frontendDist: gitAt(cwd, 'rev-parse', 'HEAD:nuwax-dist') },
    runId: env.GITHUB_RUN_ID, runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    buildId: `${sha.slice(0, 12)}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`, matrix };
  const restart = approvedRestart(cwd, identity);
  return restart ? { ...identity, restart } : identity;
}

export function assertValidationBudget(runs, identity) {
  if (!Array.isArray(runs)) throw new Error('无法确认验证历史，停止构建');
  const own = runs.filter(run => run.display_title === `Package validation / ${identity.series}`);
  const current = own.find(run => String(run.id) === identity.runId);
  if (!current || current.run_attempt !== identity.runAttempt) throw new Error('无法确认本次尝试记录，停止构建');
  let starts = 0;
  for (const run of own) {
    if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) throw new Error('尝试记录不完整，停止构建');
    starts += run.run_attempt;
  }
  // Count every start, including reruns, cancellation and a changed source SHA.
  // A successful run completes the validation; it is not a reason to reset here.
  if (identity.restart) {
    const previous = new Map(identity.restart.previousRuns.map(run => [run.id, run.attempts]));
    const resumed = own.filter(run => !previous.has(String(run.id)));
    if (previous.has(identity.runId) || previous.size !== own.length - resumed.length ||
        own.some(run => previous.has(String(run.id)) && previous.get(String(run.id)) !== run.run_attempt) ||
        resumed.length !== 1 || String(resumed[0].id) !== identity.runId || resumed[0].run_attempt !== 1 ||
        starts !== MAX_VALIDATION_STARTS + 1) {
      throw new Error('人工重启仅授权一次新启动，历史变更、额外启动或 rerun 已达到停止条件');
    }
  } else if (starts > MAX_VALIDATION_STARTS) throw new Error(`同一问题最多 ${MAX_VALIDATION_STARTS} 次验证启动，已达到停止条件；不得自动换系列继续`);
  return starts;
}

export async function checkValidationBudget(identity, env = process.env, fetcher = fetch) {
  const repository = env.GITHUB_REPOSITORY ?? '';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !env.GH_TOKEN) throw new Error('缺少只读 Actions 历史访问上下文');
  const api = env.GITHUB_API_URL || 'https://api.github.com';
  if (new URL(api).protocol !== 'https:') throw new Error('Actions API 必须使用 HTTPS');
  const runs = [];
  for (let page = 1; page <= 20; page++) {
    const response = await fetcher(`${api}/repos/${repository}/actions/workflows/${workflowFile}/runs?per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('无法读取验证历史，停止构建');
    const data = await response.json();
    if (!Array.isArray(data.workflow_runs)) throw new Error('验证历史格式错误，停止构建');
    runs.push(...data.workflow_runs);
    if (data.workflow_runs.length < 100) return assertValidationBudget(runs, identity);
  }
  throw new Error('验证历史超过读取上限，停止构建');
}

export async function stageValidation(cwd, output, stage, identity, platform, signing = null) {
  if (!['darwin', 'win32', 'linux'].includes(platform)) throw new Error('未知验证平台');
  const entries = fs.readdirSync(output, { withFileTypes: true });
  if (platform === 'win32' && entries.some(entry => entry.isFile() && /\.msi$/i.test(entry.name))) throw new Error('Windows 验证不应生成 MSI');
  const packages = entries.filter(entry => entry.isFile() && (platform === 'win32' ? /\.exe$/i : platform === 'linux' ? /\.AppImage$/i : /\.(zip|dmg)$/i).test(entry.name));
  if (!packages.length) throw new Error('没有完整验证安装包');
  if (gitAt(cwd, 'rev-parse', 'HEAD') !== identity.source.client) throw new Error('打包期间源码身份发生变化');
  if (fs.existsSync(stage)) throw new Error('验证产物目录必须是本次新建目录');
  fs.mkdirSync(stage, { recursive: true });
  const artifacts = {};
  for (const entry of packages) {
    const file = `validation-${identity.buildId}-${entry.name}`;
    const target = path.join(stage, file);
    fs.copyFileSync(path.join(output, entry.name), target, fs.constants.COPYFILE_EXCL);
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
    artifacts[file] = hash.digest('hex');
  }
  if (platform === 'darwin' && (!signing?.signed || !signing?.notarized || !signing?.team)) throw new Error('Mac acceptance requires verified Developer ID and notarization');
  const receipt = { ...identity, platform, distribution: 'actions-artifacts-only', signed: Boolean(signing?.signed), signing,
    acceptance: platform === 'darwin' ? 'Private signed and notarized validation artifact; not an official release' : platform === 'linux' ? 'Unsigned Linux AppImage validation; not an official release' : 'Unsigned Windows EXE validation; Beta Windows packages are also unsigned',
    published: false, tagCreated: false, versionSequenceAdvanced: false, updatePointersChanged: false, artifacts };
  fs.writeFileSync(path.join(stage, 'validation-context.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

export async function buildValidation(cwd, identity, { platform = process.platform, arch = process.arch, prepareFn, packFn, temp = process.env.RUNNER_TEMP } = {}) {
  if (!temp || !path.isAbsolute(temp)) throw new Error('验证输出须在独立 runner 临时目录');
  if (!identity.matrix.some(item => item.platform === platform && item.arch === arch && item.baselineTag === identity.baselineTag)) throw new Error('当前平台/架构未被本次验证选择');
  if (!prepareFn && platform === 'win32') {
    const { configureWindowsCaptureToolchain } = await import('./prepare-release-capture.mjs');
    await configureWindowsCaptureToolchain(cwd, { location: process.env.MSYS2_LOCATION, arch });
  }
  prepareFn ??= (await import('./client/prepare.mjs')).prepare;
  packFn ??= platform === 'darwin' ? (await import('./package-validation-mac.mjs')).packSignedValidationMac : (await import('./client/pack.mjs')).pack;
  // Private joint acceptance must exercise the paired artifact bytes; rebuilding
  // per platform would no longer validate the committed dist pin.
  const prepared = await prepareFn(cwd, { frontend: 'dist' });
  const frontend = prepared?.frontend;
  if (frontend?.sourceSha !== identity.source.frontend || frontend?.distSha !== identity.source.frontendDist ||
      !/^[a-f0-9]{7,40}$/.test(frontend?.stamp ?? '') || !identity.source.frontend.startsWith(frontend.stamp)) {
    throw new Error('准备结果不匹配冻结的前端双 pin，停止构建');
  }
  const receiptIdentity = { ...identity, frontend: { mode: 'dist', sourceSha: frontend.sourceSha, distSha: frontend.distSha, stamp: frontend.stamp } };
  const packageFile = path.join(cwd, 'nuwa-electron-shell/crates/agent-electron-client/package.json');
  const original = fs.readFileSync(packageFile);
  const pkg = JSON.parse(original);
  pkg.build ??= {}; pkg.build.mac ??= {};
  pkg.build.buildVersion = identity.nativeVersion;
  pkg.build.mac.bundleShortVersion = identity.nativeVersion;
  if (platform === 'win32') { pkg.build.win ??= {}; pkg.build.win.target = ['nsis']; }
  if (platform === 'linux') { pkg.build.linux ??= {}; pkg.build.linux.target = ['AppImage']; }
  const output = platform === 'win32' ? path.join(temp, 'pv', `${identity.runId}-${identity.runAttempt}`) : path.join(temp, `package-validation-output-${identity.buildId}-${platform}`);
  const stage = path.join(temp, `package-validation-artifacts-${identity.buildId}-${platform}`);
  try {
    // Only the disposable base checkout changes. Application version is the
    // selected existing release baseline; the run identity never becomes SemVer.
    fs.writeFileSync(packageFile, `${JSON.stringify(pkg, null, 2)}\n`);
    const packed = await packFn(cwd, { frontend: 'dist', platform, arch, version: identity.packageVersion, output, prepare: async () => prepared });
    await stageValidation(cwd, output, stage, receiptIdentity, platform, packed?.validationSigning);
    return stage;
  } finally { fs.writeFileSync(packageFile, original); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const identity = validationIdentity(root);
    const starts = await checkValidationBudget(identity);
    if (process.argv[2] === 'prepare') {
      const values = { source_sha: identity.source.client, baseline_tag: identity.baselineTag,
        version: identity.packageVersion, build_id: identity.buildId, matrix: JSON.stringify({ include: identity.matrix }) };
      fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
      const budget = identity.restart ? `explicit user restart 1/1; ${MAX_VALIDATION_STARTS} prior starts preserved; total ${starts}` : `start ${starts}/${MAX_VALIDATION_STARTS}`;
      console.log(`Package validation ${identity.buildId}; existing baseline ${identity.baselineTag}; ${budget}`);
    } else if (process.argv[2] === 'build') {
      const stage = await buildValidation(root, identity);
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `artifact_path=${stage}\n`);
    } else throw new Error('仅支持 prepare / build；此工具不发布安装包');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
