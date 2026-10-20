#!/usr/bin/env node
/**
 * 准备 nuwax-file-server 源码并复制到 resources/
 *
 * 策略：
 *   1. 在自有缓存中解析 origin/<branch>，开发者 sources/ 不参与更新
 *   2. 源码补丁只应用到一次性构建副本，缓存命中包含补丁 SHA-256
 *   3. 用远程 commit hash 做缓存：与 resources/.commit-hash 一致且产物齐全则跳过
 *   4. commit 变更时必须重新 install + build，再完整复制到 resources/
 *
 * 产物：
 *   resources/nuwax-file-server/
 *     ├── dist/
 *     ├── node_modules/
 *     ├── package.json
 *     └── .commit-hash   # 远程 commit，供下次缓存比对
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { getProjectRoot } = require('../utils/project-paths');
const productRoot = path.resolve(__dirname, '../../../../..');
const sourcePatches = require(path.join(productRoot, 'scripts/source-patches.cjs'));

const projectRoot = getProjectRoot();
const electronClientRoot = projectRoot;

// 从 package.json 读取源码地址
const pkgJson = JSON.parse(
  fs.readFileSync(path.join(electronClientRoot, 'package.json'), 'utf8'),
);
const { url: GIT_REPO, branch: GIT_BRANCH } =
  pkgJson.bundledSources['nuwax-file-server'];

const SOURCE_DIR = path.join(electronClientRoot, '.cache', 'bundled-sources', 'nuwax-file-server');
let buildSourceDir = SOURCE_DIR;
const sourcePatch = sourcePatches.fileServerPatch(productRoot, GIT_REPO);
const destDir = path.join(electronClientRoot, 'resources', 'nuwax-file-server');
const patchMarker = path.join(destDir, '.source-patch-sha256');
/** resources 侧缓存的远程 commit 文件 */
const DEST_COMMIT_HASH_PATH = path.join(destDir, '.commit-hash');

/**
 * 执行命令并原样打印到控制台。
 * @param {string} cmd shell 命令
 * @param {import('child_process').ExecSyncOptions} [opts]
 */
function exec(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', ...opts });
}

/**
 * 跨平台递归复制（替代 cp -R：Windows 无 cp 命令）。
 */
function copyDir(src, dest, filter) {
  fs.cpSync(src, dest, { recursive: true, ...(filter ? { filter } : {}) });
}

/**
 * node_modules 复制过滤器：跳过 .bin 目录。npm install 生成的 .bin 全是
 * 绝对路径符号链接（指向 sources/ 构建机本地路径），随包进入 electron-builder
 * 产物会让 mac codesign --deep 报 invalid symlink（v1.0.0/v1.0.2 发布阻塞根因）；
 * 这些 CLI shim 运行时无消费者，直接不复制。
 */
const nodeModulesCopyFilter = (src) =>
  !/(?:^|[\\/])node_modules[\\/]\.bin(?:[\\/]|$)/.test(src);

/**
 * 在指定仓库执行 git 命令，返回 stdout（trim 后）。
 * @param {string} repoDir
 * @param {string} args git 子命令参数（不含 git 前缀）
 * @returns {string}
 */
function git(repoDir, args) {
  return execSync(`git ${args}`, {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
  }).trim();
}

/**
 * 读取文本文件并去掉空白；不存在则返回 null。
 * @param {string} filePath
 * @returns {string|null}
 */
function readTrimmedFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8').trim() || null;
}

/**
 * 判断 resources 产物是否齐全（可被 Electron 直接启动）。
 * @returns {boolean}
 */
function hasDestBuild() {
  return (
    fs.existsSync(path.join(destDir, 'dist')) &&
    fs.existsSync(path.join(destDir, 'node_modules')) &&
    fs.existsSync(path.join(destDir, 'package.json'))
  );
}

/**
 * 确保 SOURCE_DIR 是可 fetch 的 git 仓库；缺失则 clone。
 */
function ensureSourceRepo() {
  if (fs.existsSync(path.join(SOURCE_DIR, '.git'))) {
    if (git(SOURCE_DIR, 'remote get-url origin') !== GIT_REPO) throw new Error('Unowned bundled source cache');
    if (git(SOURCE_DIR, 'status --porcelain --untracked-files=no')) throw new Error('Bundled source cache has local changes');
    return;
  }

  console.log('[prepare-nuwax-file-server] 克隆源码...');
  fs.mkdirSync(path.dirname(SOURCE_DIR), { recursive: true });
  if (fs.existsSync(SOURCE_DIR)) {
    // 半成品目录（无 .git）会挡住 clone
    throw new Error('Unowned directory in bundled source cache');
  }
  exec(`git clone --branch ${GIT_BRANCH} ${GIT_REPO} "${SOURCE_DIR}"`);
}

/**
 * fetch 远程并返回 origin/<branch> 的 commit hash（以远程为准）。
 * @returns {string}
 */
function fetchRemoteCommitHash() {
  console.log(`[prepare-nuwax-file-server] 拉取远程 ${GIT_BRANCH}...`);
  git(SOURCE_DIR, `fetch origin ${GIT_BRANCH}`);
  return git(SOURCE_DIR, `rev-parse origin/${GIT_BRANCH}`);
}

/**
 * 将本地工作树硬对齐到 origin/<branch>，并清理未跟踪文件。
 * 避免 git pull 被 untracked 文件 abort（此前 prepare 失败根因）。
 * @param {string} remoteHash 仅用于日志展示
 */
function hardResetToRemote(remoteHash) {
  console.log(
    `[prepare-nuwax-file-server] 对齐远程 origin/${GIT_BRANCH} (${remoteHash.slice(0, 8)})...`,
  );
  git(SOURCE_DIR, `checkout -B ${GIT_BRANCH} origin/${GIT_BRANCH}`);
  git(SOURCE_DIR, `reset --hard origin/${GIT_BRANCH}`);
  // -fd：删除未跟踪文件/目录，防止与远程新增同名路径冲突
  git(SOURCE_DIR, 'clean -fd');
}

/**
 * 清理 node_modules 后重新 install + build。
 * commit 变更时必须重建，禁止复用旧 dist。
 */
function installAndBuild() {
  const nm = path.join(buildSourceDir, 'node_modules');
  if (fs.existsSync(nm)) {
    console.log('[prepare-nuwax-file-server] 清理旧的 node_modules...');
    fs.rmSync(nm, { recursive: true, force: true });
  }

  console.log('[prepare-nuwax-file-server] 安装依赖...');
  exec(`cd "${buildSourceDir}" && npm install --ignore-scripts`);

  console.log('[prepare-nuwax-file-server] 构建项目...');
  exec(`cd "${buildSourceDir}" && npm run build`);
}

/**
 * 将 sources 构建产物完整复制到 resources，并写入远程 commit 缓存。
 * @param {string} remoteHash
 */
function copyToResources(remoteHash) {
  const srcPkg = JSON.parse(
    fs.readFileSync(path.join(buildSourceDir, 'package.json'), 'utf8'),
  );
  console.log(
    `[prepare-nuwax-file-server] 源码版本: ${srcPkg.name}@${srcPkg.version}`,
  );

  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
  fs.mkdirSync(destDir, { recursive: true });

  console.log('[prepare-nuwax-file-server] 复制 dist/...');
  copyDir(path.join(buildSourceDir, 'dist'), path.join(destDir, 'dist'));

  fs.copyFileSync(
    path.join(buildSourceDir, 'package.json'),
    path.join(destDir, 'package.json'),
  );

  console.log('[prepare-nuwax-file-server] 复制 node_modules/（跳过 .bin 符号链接）...');
  copyDir(
    path.join(buildSourceDir, 'node_modules'),
    path.join(destDir, 'node_modules'),
    nodeModulesCopyFilter,
  );

  const licenseSrc = path.join(buildSourceDir, 'LICENSE');
  if (fs.existsSync(licenseSrc)) {
    fs.copyFileSync(licenseSrc, path.join(destDir, 'LICENSE'));
  }

  fs.writeFileSync(DEST_COMMIT_HASH_PATH, `${remoteHash}\n`, 'utf8');
  console.log(
    `[prepare-nuwax-file-server] 保存 commit hash: ${remoteHash.slice(0, 8)}`,
  );
  console.log(
    `[prepare-nuwax-file-server] ✓ resources/nuwax-file-server/ (${srcPkg.version})`,
  );
}

function main() {
  ensureSourceRepo();

  const remoteHash = fetchRemoteCommitHash();
  const cachedHash = readTrimmedFile(DEST_COMMIT_HASH_PATH);
  const destReady = hasDestBuild();

  // 缓存命中：远程未变 + resources 产物齐全 → 整段跳过
  if (cachedHash && cachedHash === remoteHash && destReady && (!sourcePatch || readTrimmedFile(patchMarker) === sourcePatch.hash)) {
    let version = 'unknown';
    try {
      version = JSON.parse(
        fs.readFileSync(path.join(destDir, 'package.json'), 'utf8'),
      ).version;
    } catch {
      /* ignore */
    }
    console.log(
      `[prepare-nuwax-file-server] ${version} (${remoteHash.slice(0, 8)}) 已是最新，跳过`,
    );
    return;
  }

  if (cachedHash && cachedHash !== remoteHash) {
    console.log(
      `[prepare-nuwax-file-server] 远程更新: ${cachedHash.slice(0, 8)} -> ${remoteHash.slice(0, 8)}，需要重新构建`,
    );
  } else if (!destReady) {
    console.log(
      '[prepare-nuwax-file-server] 构建产物缺失，需要重新构建',
    );
  } else {
    console.log(
      '[prepare-nuwax-file-server] 无有效缓存，需要重新构建',
    );
  }

  hardResetToRemote(remoteHash);
  const patched = sourcePatch ? sourcePatches.createPatchedSource(SOURCE_DIR, sourcePatch.file) : undefined;
  buildSourceDir = patched?.directory ?? SOURCE_DIR;
  try {
    installAndBuild();
    copyToResources(remoteHash);
    if (sourcePatch) fs.writeFileSync(patchMarker, `${sourcePatch.hash}\n`);
  } finally { patched?.dispose(); }
}

main();
