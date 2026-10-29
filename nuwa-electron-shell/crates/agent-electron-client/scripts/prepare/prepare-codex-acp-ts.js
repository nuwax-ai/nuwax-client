#!/usr/bin/env node
/**
 * 从 node_modules 复制 @nuwax-ai/nuwax-harness-acp-ts（TS adapter）到 resources/。
 *
 * adapter `dist/index.js` 是 esbuild 自包含 bundle（@agentclientprotocol/sdk /
 * diff / open / vscode-jsonrpc / zod 全部内联，引擎版本号也已内联），外部依赖仅
 * node 内置。引擎二进制由依赖包 `@nuwax-ai/nuwax-harness` 的 postinstall 下载到
 * `~/.nuwax-harness-cache/<引擎版本>/<平台三元组>/`（一组文件：主二进制 +
 * codex-code-mode-host，linux 另有 codex-resources/bwrap，win 另有两个沙箱辅助 exe）。
 *
 * 产物（resources/nuwax-harness-acp-ts/）：
 *   ├── dist/index.js                          adapter bundle（自包含）
 *   ├── package.json                           精简（name/version/bin/main）
 *   └── vendor/nuwax-harness/<ver>/            引擎文件集（按 requiredBundleFiles 选择性复制）
 *
 * 运行时 adapter 不再按包相对路径找引擎：只认 NUWAX_PATH/CODEX_PATH env，兜底
 * homedir()/.nuwax-harness-cache（ACP 子进程 HOME 被隔离，兜底必然落空）。
 * 因此 acpClient 在 codex 分支注入 NUWAX_PATH 指向 vendor 内主二进制
 * （见 binaryLocator.resolveBundledHarnessEnginePath）。
 *
 * 前提：pnpm install 已执行且引擎包 postinstall 已跑（pnpm.onlyBuiltDependencies
 * 含 @nuwax-ai/nuwax-harness）；缓存缺失时本脚本会先调引擎包 launcher 自动补下，
 * 补下失败即 fail fast。打包时 electron-builder extraResources 会打包到
 * .app/Contents/Resources/nuwax-harness-acp-ts/。
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { createRequire } = require('module');
const { getProjectRoot } = require('../utils/project-paths');

const PKG_NAME = '@nuwax-ai/nuwax-harness-acp-ts';
const ENGINE_PKG_NAME = '@nuwax-ai/nuwax-harness';
const BUNDLED_DIR_NAME = 'nuwax-harness-acp-ts';
const CACHE_DIRECTORY = '.nuwax-harness-cache';

const projectRoot = getProjectRoot();

/** 平台三元组，与引擎包 bin/runtime.js getTargetTriple 对齐；linux-x64 musl 优先。 */
function targetTriples() {
  const { platform, arch } = process;
  if (platform === 'darwin') {
    if (arch === 'arm64') return ['aarch64-apple-darwin'];
    if (arch === 'x64') return ['x86_64-apple-darwin'];
  } else if (platform === 'linux') {
    if (arch === 'arm64') return ['aarch64-unknown-linux-musl'];
    if (arch === 'x64') return ['x86_64-unknown-linux-musl', 'x86_64-unknown-linux-gnu'];
  } else if (platform === 'win32') {
    if (arch === 'arm64') return ['aarch64-pc-windows-msvc'];
    if (arch === 'x64') return ['x86_64-pc-windows-msvc'];
  }
  console.error(`[prepare-codex-acp-ts] 不支持的平台/架构: ${platform}/${arch}`);
  process.exit(1);
}

function engineBinaryName() {
  return process.platform === 'win32' ? 'nuwax-harness.exe' : 'nuwax-harness';
}

function fail(msg) {
  console.error(`[prepare-codex-acp-ts] ${msg}`);
  process.exit(1);
}

async function main() {
  // 1. 定位 adapter 真实路径（pnpm symlink → require.resolve）
  const projectRequire = createRequire(path.join(projectRoot, 'package.json'));
  let adapterPkgPath;
  try {
    adapterPkgPath = projectRequire.resolve(`${PKG_NAME}/package.json`);
  } catch {
    fail(`node_modules 中未找到 ${PKG_NAME}，请先执行 pnpm install`);
  }
  const srcDir = path.dirname(adapterPkgPath);
  const srcPkg = JSON.parse(fs.readFileSync(adapterPkgPath, 'utf-8'));
  console.log(`[prepare-codex-acp-ts] 源: ${srcPkg.name}@${srcPkg.version}`);

  const srcIndexJs = path.join(srcDir, 'dist', 'index.js');
  if (!fs.existsSync(srcIndexJs)) {
    fail(`dist/index.js 不存在: ${srcIndexJs}`);
  }

  // 2. 引擎版本：读 adapter 依赖的 @nuwax-ai/nuwax-harness/package.json
  const adapterRequire = createRequire(srcIndexJs);
  let enginePkgPath;
  try {
    enginePkgPath = adapterRequire.resolve(`${ENGINE_PKG_NAME}/package.json`);
  } catch {
    fail(`adapter 的 ${ENGINE_PKG_NAME} 依赖未找到，请确认 pnpm install 已跑`);
  }
  const enginePkgDir = path.dirname(enginePkgPath);
  const engineVer = JSON.parse(fs.readFileSync(enginePkgPath, 'utf-8')).version;

  // 3. 定位引擎缓存目录；缺失时先经引擎包 launcher 自动补下（内部走同一 ensureBinary）
  const homeDir = require('os').homedir();
  const cacheCandidates = targetTriples().map((triple) =>
    path.join(homeDir, CACHE_DIRECTORY, engineVer, triple),
  );
  let cacheDir = cacheCandidates.find((dir) =>
    fs.existsSync(path.join(dir, engineBinaryName())),
  );
  if (!cacheDir) {
    console.log(
      `[prepare-codex-acp-ts] 引擎缓存缺失（${engineVer}），尝试自动下载…`,
    );
    const launcher = path.join(enginePkgDir, 'bin', 'nuwax-harness.js');
    const result = spawnSync(process.execPath, [launcher, '--version'], {
      stdio: 'inherit',
      windowsHide: true,
    });
    if (result.status !== 0) {
      fail(
        `引擎二进制自动下载失败（exit ${result.status}）。请手动执行 ` +
          `node ${launcher} --version 后重试`,
      );
    }
    cacheDir = cacheCandidates.find((dir) =>
      fs.existsSync(path.join(dir, engineBinaryName())),
    );
    if (!cacheDir) {
      fail(`引擎下载后仍未找到预期二进制，检查缓存目录: ${cacheCandidates.join(', ')}`);
    }
  }

  // 4. 复制到 resources/nuwax-harness-acp-ts/
  const destDir = path.join(projectRoot, 'resources', BUNDLED_DIR_NAME);
  if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true });
  fs.mkdirSync(path.join(destDir, 'dist'), { recursive: true });

  // dist/index.js（adapter bundle）
  const destIndexJs = path.join(destDir, 'dist', 'index.js');
  fs.copyFileSync(srcIndexJs, destIndexJs);
  fs.chmodSync(destIndexJs, 0o755);
  console.log(`  dist/index.js (${(fs.statSync(destIndexJs).size / 1024 / 1024).toFixed(1)} MB)`);

  // vendor/nuwax-harness/<ver>/（按引擎包 runtime.js 的 requiredBundleFiles 权威清单
  // 选择性复制——缓存目录可能残留旧名二进制等历史产物，整目录复制会把它们带进包里）
  let requiredFiles;
  try {
    const runtime = await import(
      pathToFileURL(path.join(enginePkgDir, 'bin', 'runtime.js')).href
    );
    requiredFiles = runtime.requiredBundleFiles();
  } catch (err) {
    fail(`读取引擎包 requiredBundleFiles 失败: ${err instanceof Error ? err.message : err}`);
  }
  requiredFiles = [...requiredFiles, 'SHA256SUMS'];
  for (const rel of requiredFiles) {
    if (!fs.existsSync(path.join(cacheDir, rel))) {
      fail(`引擎缓存缺少必需文件 ${rel}（目录: ${cacheDir}），请删除该目录后重跑`);
    }
  }
  const destEngineDir = path.join(destDir, 'vendor', 'nuwax-harness', engineVer);
  const engineFiles = [];
  for (const rel of requiredFiles) {
    const srcFile = path.join(cacheDir, rel);
    const destFile = path.join(destEngineDir, rel);
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    fs.copyFileSync(srcFile, destFile);
    if (rel.endsWith('SHA256SUMS')) continue;
    fs.chmodSync(destFile, 0o755);
    engineFiles.push(destFile);
  }
  // macOS ad-hoc 签名（arm64 运行所需占位签名；正式 Developer ID 签名由 after-sign.js 覆盖）
  if (process.platform === 'darwin') {
    for (const file of engineFiles) {
      try {
        spawnSync('codesign', ['--force', '--sign', '-', file], { stdio: 'pipe' });
      } catch (err) {
        console.warn(`[prepare-codex-acp-ts] codesign failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    console.log(`  codesign (ad-hoc): ${engineFiles.length} 个可执行文件`);
  }
  const engineSize = fs.statSync(path.join(destEngineDir, engineBinaryName())).size;
  console.log(
    `  vendor/nuwax-harness/${engineVer}/ (${(engineSize / 1024 / 1024).toFixed(0)} MB 主二进制, ${engineFiles.length} 个可执行)`,
  );

  // 精简 package.json（bin 与发布包保持一致，旧命令名保留兼容别名）。
  // type 必须保留：dist/index.js 是 esbuild 的 ESM 产物，缺了它 Node 每次 spawn
  // 都打 MODULE_TYPELESS_PACKAGE_JSON 警告（靠宽容解析才跑起来）。
  const slimPkg = {
    name: srcPkg.name,
    version: srcPkg.version,
    type: 'module',
    bin: {
      'nuwax-harness-acp-ts': './dist/index.js',
      'nuwax-codex-acp-ts': './dist/index.js',
    },
    main: './dist/index.js',
  };
  fs.writeFileSync(path.join(destDir, 'package.json'), JSON.stringify(slimPkg, null, 2) + '\n');

  console.log(`[prepare-codex-acp-ts] ✓ resources/${BUNDLED_DIR_NAME}/ (${srcPkg.version}, 引擎 ${engineVer})`);
}

main();