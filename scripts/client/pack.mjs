import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../../client.config.mjs';
import * as core from './core.mjs';
import { parseReleaseTag } from '../release-version.mjs';
import { buildFrontend } from './frontend.mjs';
import { prepare, commercialEnv, fileReady, inputDigest } from './prepare.mjs';
import { captureSourceLockFile, inspectCaptureResource } from './capture-resources.mjs';
import { CAPTURE_RESOURCE_FILES, captureWindowSourceLockFile, inspectCaptureWindowResource } from './capture-window-resources.mjs';
import { shippedResourcePaths } from './third-party-notices.mjs';
import { generateThirdPartyNotices } from './source-notices.mjs';
import { terminalCompatLockFile, inspectTerminalCompatResource } from './terminal-compat-resources.mjs';
import { verifyUpdaterOutput } from '../prepare-release-updater.mjs';
import updater from '../../nuwa-electron-shell/crates/agent-electron-client/scripts/build/app-update-config.cjs';
import archivePolicy from '../../nuwa-electron-shell/crates/agent-electron-client/scripts/build/installer-archive-policy.cjs';
import { configureSystemAppName } from './system-app-name.mjs';
import { configurePackagePayload, verifyPackagePayload } from './package-payload.mjs';

const { resolveInstallerArchiveMode, installedBuilderVersions, applyInstallerArchivePolicy } = archivePolicy;

export function unsignedEnv(root) {
  return commercialEnv(root, {
    NODE_ENV: 'production', SKIP_PREPARE: '1', SKIP_WINDOWS_AFTER_SIGN: '1',
    CSC_IDENTITY_AUTO_DISCOVERY: 'false', CSC_LINK: '', WIN_CSC_LINK: '',
    APPLE_SIGNING_IDENTITY: '', APPLE_API_KEY: '', APPLE_API_KEY_ID: '', APPLE_ISSUER_ID: '',
    WINDOWS_CERTIFICATE_SHA1: '', WINDOWS_CERTIFICATE_PATH: '', WINDOWS_CERTIFICATE_PASSWORD: '',
    CS_CERT_SHA1: '', CS_CERT_PATH: '', CS_CERT_PASSWORD: '', SIGN_IDENTITY: '',
  });
}

export async function localVersion(root, tools = core) {
  const tag = await tools.git(root, ['describe', '--tags', '--match', 'v*', '--match', 'electron-v*', '--match', 'prerelease-v*', '--abbrev=0', 'HEAD'], { allowFailure: true });
  try { return `${parseReleaseTag(tag, { allowLegacy: true }).version}-dev`; }
  catch { return '0.0.0-dev'; }
}

function canonical(file) {
  const suffix = [];
  let parent = path.resolve(file);
  while (!fs.existsSync(parent)) {
    suffix.unshift(path.basename(parent));
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  return path.resolve(fs.realpathSync(parent), ...suffix);
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

export function validateOutput(root, output, tools = core) {
  const p = tools.paths(root);
  const candidate = canonical(output);
  const repository = canonical(root);
  if (inside(candidate, repository)) throw new Error('[pack] 输出目录不能是仓库根或其父目录');
  const protectedPaths = [p.base, p.frontend, p.dist, p.cache, ...['.git', '.github', '.agents', '.claude', '.zcode', 'scripts', 'docs', 'plans', 'specs', 'release-notes', 'templates'].map((name) => path.join(root, name))];
  if (protectedPaths.some((file) => inside(canonical(file), candidate))) throw new Error('[pack] 输出目录不能位于源码、子模块或工具链缓存中');
  if (fs.existsSync(path.join(candidate, '.git')) || fs.existsSync(candidate) && !fs.statSync(candidate).isDirectory()) throw new Error('[pack] 输出目标必须是独立产物目录');
  return output;
}

export function builderConfig(packageJson, { frontendDist, output, version, product = config.product, helperDir, captureDir, noticesDir, platform = process.platform, arch = process.arch, env = process.env, builderVersions }) {
  if (version && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('[pack] version 必须是有效的 semver 版本');
  const result = structuredClone(packageJson.build ?? {});
  result.extends = null;
  result.appId = product.appId;
  result.afterSign = undefined;
  // prepare already probes SQLite under this Electron ABI. Rebuilding it again
  // here would discard the validated native cache on every local package.
  result.npmRebuild = false;
  result.asarUnpack = [...new Set([
    ...(Array.isArray(result.asarUnpack) ? result.asarUnpack : result.asarUnpack ? [result.asarUnpack] : []),
    'dist/main/mac-notification-permission.node',
    'dist/main/mac-capture-shortcuts.node',
  ])];
  result.files = [...(Array.isArray(result.files) ? result.files : result.files ? [result.files] : ['**/*']), '!node_modules/agent-gui-server/**/*', '!node_modules/@nut-tree-fork/**/*'];
  result.extraMetadata = { ...result.extraMetadata, name: product.identifier, ...(version ? { version } : {}) };
  result.directories = { ...result.directories, output };
  const legacySandboxResources = new Set(['sandboxed-bash-mcp', 'sandboxed-fs-mcp', 'sandbox-runtime', 'sandbox-helper', 'agent-gui-server', 'windows-mcp']);
  result.extraResources = (result.extraResources ?? []).filter((entry) => typeof entry === 'string' || !['nuwax-dist', 'computer-use', 'capture', 'third-party'].includes(entry.to?.split('/')[0]) && !legacySandboxResources.has(entry.to));
  result.extraResources.push({ from: frontendDist, to: 'nuwax-dist', filter: ['**/*', '!.git', '!.git/**', '!README.md'] });
  if (platform !== 'win32') {
    for (const entry of result.extraResources) {
      if (typeof entry === 'object' && entry.to === 'ttyd') entry.filter = [...(entry.filter ?? ['**/*']), '!legacy/**'];
    }
  }
  if (helperDir) result.extraResources.push({ from: helperDir, to: 'computer-use', filter: ['**/*'] });
  if (captureDir) result.extraResources.push({ from: captureDir, to: `capture/${path.basename(captureDir)}`, filter: CAPTURE_RESOURCE_FILES });
  if (noticesDir) result.extraResources.push({ from: noticesDir, to: 'third-party', filter: ['third-party-notices.json', 'licenses/**', 'sources/**'] });
  result.mac ??= {};
  result.mac.identity = null;
  result.mac.hardenedRuntime = false;
  result.mac.notarize = false;
  result.nsis = { ...result.nsis, warningsAsErrors: false };
  // Keep rcedit metadata/icon updates for branding; certificate discovery is
  // disabled by unsignedEnv, so this does not enable code signing.
  result.win = { ...result.win, signAndEditExecutable: true, signDlls: false };
  result.win.extraResources = (result.win.extraResources ?? []).filter((entry) => typeof entry === 'string' || !legacySandboxResources.has(entry.to));
  result.deb = { ...result.deb, packageName: product.identifier };
  result.rpm = { ...result.rpm, packageName: product.identifier };
  return applyInstallerArchivePolicy(updater.configureUpdater(configureSystemAppName(configurePackagePayload(result), { platform, arch, product,
    macStringsFile: fileURLToPath(new URL('../../nuwa-electron-shell/crates/agent-electron-client/build/InfoPlist.strings', import.meta.url)),
  }), {
    feedBase: product.feedBase,
    hook: fileURLToPath(new URL('../../nuwa-electron-shell/crates/agent-electron-client/scripts/build/app-update-config.cjs', import.meta.url)),
  }), { env, platform, builderVersions });
}

export async function prepareComputerUse(root, { tools = core, platform = process.platform, arch = process.arch, refreshResources = false, development = false } = {}) {
  const p = tools.paths(root);
  const helperDir = development ? path.join(p.cache, 'dev/computer-use') : path.join(p.client, 'resources/computer-use');
  const appName = development ? 'Nuwax Computer Use Dev.app' : 'Nuwax Computer Use.app';
  const helper = path.join(helperDir, platform === 'darwin' ? `${appName}/Contents/MacOS/Nuwax Computer Use` : platform === 'win32' ? 'NuwaxComputerUse.exe' : 'NuwaxComputerUse');
  const stateFile = path.join(p.cache, development ? 'computer-use-dev.json' : 'computer-use.json');
  const inputs = [path.join(root, 'scripts/computer-use'), path.join(root, 'docs/computer-use-poc/0001-0003-cua-nuwax-helper-bundle.patch'), path.join(p.client, 'public/icon.icns')];
  if (process.env.NUWAX_CUA_SOURCE_DIR) {
    for (const input of ['libs/cua-driver/rust', 'libs/cua/Cargo.toml', 'libs/cua/crates/cua-telemetry',
      'libs/cua/crates/cua-teleport/src/ux/targets.json', 'libs/images/sandbox-images.json']) {
      inputs.push(path.join(process.env.NUWAX_CUA_SOURCE_DIR, input));
    }
  }
  const key = tools.fingerprint([platform, arch, process.env.CUA_COMMIT ?? '85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19', process.env.CUA_VERSION ?? '0.38.0', inputDigest(inputs),
    ...(development ? ['development-profile', platform === 'darwin' ? 'strip-none' : 'default'] : [])]);
  let state;
  try { state = tools.readJson(stateFile); } catch { state = null; }
  if (!refreshResources && state?.key === key && state?.artifact === inputDigest([helperDir]) && fileReady(helper)) return helperDir;
  const triples = { 'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin', 'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc', 'linux-x64': 'x86_64-unknown-linux-gnu', 'linux-arm64': 'aarch64-unknown-linux-gnu' };
  const triple = triples[`${platform}-${arch}`];
  if (!triple) throw new Error(`[pack] Computer Use helper 不支持 ${platform}-${arch}`);
  await tools.run('cargo', ['--version'], { cwd: root, capture: true });
  await tools.run('rustup', ['--version'], { cwd: root, capture: true });
  const bash = platform === 'win32' ? path.join(p.client, 'resources/git/bin/bash.exe') : 'bash';
  if (platform === 'win32' && !fileReady(bash)) throw new Error('[pack] 缺少已准备的 Git Bash');
  await tools.run(bash, [path.join(root, 'scripts/computer-use/build-helper.sh')], {
    cwd: root,
    env: { ...unsignedEnv(root), ...(development ? { NUWAX_CUA_TARGET_DIR: path.join(p.cache, 'dev/cargo-target'), CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS || '2' } : {}),
      // Local Apple linker/strip combinations can produce unloadable Rust proc-macro dylibs.
      ...(development && platform === 'darwin' ? { CARGO_PROFILE_RELEASE_STRIP: 'none' } : {}),
      NUWAX_CUA_DEV_PROFILE: development ? '1' : '', TARGET_TRIPLE: triple, OUT_DIR: helperDir, RUNNER_TEMP: p.cache, ICON_ICNS: path.join(p.client, 'public/icon.icns') },
  });
  if (!fileReady(helper)) throw new Error(`[pack] Computer Use helper 构建完成但缺少 ${helper}`);
  tools.atomicJson(stateFile, { key, artifact: inputDigest([helperDir]), triple });
  return helperDir;
}

/** Current-platform unsigned commercial package, without modifying base package.json. */
export async function pack(root, options = {}) {
  const tools = options.tools ?? core;
  const p = tools.paths(root);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const archiveMode = resolveInstallerArchiveMode({ platform });
  const frontendMode = options.frontend ?? config.frontend.mode;
  if (!['darwin', 'win32', 'linux'].includes(platform)) throw new Error(`[pack] 不支持的平台 ${platform}`);
  const version = options.version ?? await localVersion(root, tools);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('[pack] version 必须是有效的 semver 版本');
  const output = validateOutput(root, path.resolve(root, options.output ?? path.join(config.pack.outputDir, version)), tools);
  const prepared = await (options.prepare ?? prepare)(root, { ...options, frontend: frontendMode });
  let pkg;
  let builderVersions;
  if (archiveMode) {
    pkg = tools.readJson(path.join(p.client, 'package.json'));
    builderVersions = installedBuilderVersions(p.client);
    applyInstallerArchivePolicy(pkg.build ?? {}, { platform, builderVersions });
  }
  if (options.dryRun) {
    console.log(`[pack] dry-run: ${platform}-${arch}，前端=${frontendMode}，无签名，不发布`);
    return { ...prepared, dryRun: true };
  }
  const frontend = frontendMode === 'source' ? await (options.buildFrontend ?? buildFrontend)(root, { allowDirty: true, restoreGenerated: true, cleanDist: false }) : prepared.frontend;
  if (!frontend?.distDir || !fileReady(path.join(frontend.distDir, 'index.html'))) throw new Error('[pack] 前端 index.html 缺失');
  const helperDir = await (options.prepareComputerUse ?? prepareComputerUse)(root, { ...options, tools, platform, arch });
  pkg ??= tools.readJson(path.join(p.client, 'package.json'));
  let captureDir = prepared.captureDir ?? null;
  if (config.features?.capture?.enabled !== false && fs.existsSync(captureSourceLockFile(root))) {
    const inspected = await inspectCaptureResource(root, { platform, arch, tools });
    if (!inspected) throw new Error('[pack] capture 编码资源尚未通过 LGPL、源码与 SHA256 核验，运行 npm run prepare:capture');
    captureDir = inspected.dir;
    if (fs.existsSync(captureWindowSourceLockFile(root)) && !inspectCaptureWindowResource(root, { platform, arch })) {
      throw new Error('[pack] capture 窗口识别资源尚未通过 SHA256 核验，运行 npm run prepare:capture');
    }
  }
  const noticesDir = path.join(p.cache, 'third-party', `${platform}-${arch}`);
  if (platform === 'win32' && fs.existsSync(terminalCompatLockFile(root)) && !inspectTerminalCompatResource(root, { platform, arch, tools })) {
    throw new Error('[pack] Windows 10 1511 terminal resources are missing or changed; run npm run prepare:terminal-compat');
  }
  const generated = builderConfig(pkg, { frontendDist: frontend.distDir, output, version, helperDir, captureDir, noticesDir, platform, arch, builderVersions });
  await (options.generateNotices ?? generateThirdPartyNotices)(root, { strict: true, outDir: noticesDir, resourcePaths: shippedResourcePaths(generated, p.client, platform), platform, arch });
  fs.mkdirSync(p.cache, { recursive: true });
  const configFile = path.join(p.cache, `electron-builder-${platform}-${arch}.json`);
  tools.atomicJson(configFile, generated);
  const env = unsignedEnv(root);
  await tools.npmRun(p.client, 'build', [], { env });
  const target = platform === 'darwin' ? '--mac' : platform === 'win32' ? '--win' : '--linux';
  await tools.pnpmRun(p.client, ['exec', 'electron-builder', '--config', configFile, target, `--${arch}`, '--publish', 'never', ...((options.dir ?? config.pack.dir) ? ['--dir'] : [])], { env });
  if (!fs.existsSync(output) || fs.readdirSync(output).length === 0) throw new Error(`[pack] 打包完成但输出目录为空: ${output}`);
  await (options.verifyPackagePayload ?? verifyPackagePayload)(output, { platform, arch });
  await (options.verifyUpdaterOutput ?? verifyUpdaterOutput)(output, { platform, arch, archives: !(options.dir ?? config.pack.dir), tools });
  console.log(`[pack] Nuwax 无签名包: ${output}；前端 ${frontend.stamp ?? frontend.sourceSha} (${frontendMode})`);
  return { output, configFile, frontend, platform, arch, version };
}
