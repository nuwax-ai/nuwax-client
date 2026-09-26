import fs from 'node:fs';
import path from 'node:path';
import config from '../../client.config.mjs';
import * as core from './core.mjs';
import { buildFrontend } from './frontend.mjs';
import { prepare, commercialEnv, fileReady, inputDigest } from './prepare.mjs';

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
  const tag = await tools.git(root, ['describe', '--tags', '--match', 'electron-v*', '--match', 'prerelease-v*', '--abbrev=0', 'HEAD'], { allowFailure: true });
  const value = tag.replace(/^(?:electron|prerelease)-v/, '');
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) ? value.endsWith('-dev') ? value : `${value}-dev` : '0.0.0-dev';
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
  const protectedPaths = [p.base, p.frontend, p.dist, p.cache, ...['.git', '.github', '.agents', '.claude', '.zcode', 'overlay', 'scripts', 'docs', 'plans', 'specs', 'release-notes', 'templates'].map((name) => path.join(root, name))];
  if (protectedPaths.some((file) => inside(canonical(file), candidate))) throw new Error('[pack] 输出目录不能位于源码、子模块或工具链缓存中');
  if (fs.existsSync(path.join(candidate, '.git')) || fs.existsSync(candidate) && !fs.statSync(candidate).isDirectory()) throw new Error('[pack] 输出目标必须是独立产物目录');
  return output;
}

export function builderConfig(packageJson, { frontendDist, output, version, product = config.product, helperDir }) {
  if (version && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('[pack] version 必须是有效的 semver 版本');
  const result = structuredClone(packageJson.build ?? {});
  result.extends = null;
  result.appId = product.appId;
  result.productName = product.name;
  result.afterSign = undefined;
  result.publish = null;
  result.extraMetadata = { ...result.extraMetadata, name: product.identifier, productName: product.name, ...(version ? { version } : {}) };
  result.directories = { ...result.directories, output };
  result.extraResources = (result.extraResources ?? []).filter((entry) => typeof entry === 'string' || !['nuwax-dist', 'computer-use'].includes(entry.to));
  result.extraResources.push({ from: frontendDist, to: 'nuwax-dist', filter: ['**/*', '!.git', '!.git/**', '!README.md'] });
  if (helperDir) result.extraResources.push({ from: helperDir, to: 'computer-use', filter: ['**/*'] });
  result.mac ??= {};
  result.mac.identity = null;
  result.mac.hardenedRuntime = false;
  result.mac.notarize = false;
  result.mac.extendInfo = { ...result.mac.extendInfo, CFBundleName: product.name, CFBundleDisplayName: product.displayName };
  delete result.mac.extendInfo.CFBundleIdentifier;
  result.nsis = { ...result.nsis, shortcutName: product.displayName, warningsAsErrors: false };
  // Keep rcedit metadata/icon updates for branding; certificate discovery is
  // disabled by unsignedEnv, so this does not enable code signing.
  result.win = { ...result.win, signAndEditExecutable: true, signDlls: false };
  result.deb = { ...result.deb, packageName: product.identifier };
  result.rpm = { ...result.rpm, packageName: product.identifier };
  result.linux = { ...result.linux, desktop: { ...result.linux?.desktop, entry: { ...result.linux?.desktop?.entry, Name: product.displayName } } };
  return result;
}

export async function prepareComputerUse(root, { tools = core, platform = process.platform, arch = process.arch, refreshResources = false } = {}) {
  const p = tools.paths(root);
  const helperDir = path.join(p.client, 'resources/computer-use');
  const helper = path.join(helperDir, platform === 'darwin' ? 'Nuwax Computer Use.app/Contents/MacOS/Nuwax Computer Use' : platform === 'win32' ? 'NuwaxComputerUse.exe' : 'NuwaxComputerUse');
  const stateFile = path.join(p.cache, 'computer-use.json');
  const inputs = [path.join(root, 'scripts/computer-use'), path.join(root, 'docs/computer-use-poc/0001-0003-cua-nuwax-helper-bundle.patch'), path.join(p.client, 'public/icon.icns')];
  if (process.env.NUWAX_CUA_SOURCE_DIR) inputs.push(path.join(process.env.NUWAX_CUA_SOURCE_DIR, 'libs/cua-driver/rust'));
  const key = tools.fingerprint([platform, arch, process.env.CUA_COMMIT ?? '625118a90', process.env.CUA_VERSION ?? '0.28.2', inputDigest(inputs)]);
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
    env: { ...unsignedEnv(root), TARGET_TRIPLE: triple, OUT_DIR: helperDir, RUNNER_TEMP: p.cache, ICON_ICNS: path.join(p.client, 'public/icon.icns') },
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
  const frontendMode = options.frontend ?? 'dist';
  if (!['darwin', 'win32', 'linux'].includes(platform)) throw new Error(`[pack] 不支持的平台 ${platform}`);
  const version = options.version ?? await localVersion(root, tools);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('[pack] version 必须是有效的 semver 版本');
  const output = validateOutput(root, path.resolve(root, options.output ?? path.join('release', version)), tools);
  const prepared = await (options.prepare ?? prepare)(root, { ...options, frontend: frontendMode });
  if (options.dryRun) {
    console.log(`[pack] dry-run: ${platform}-${arch}，前端=${frontendMode}，无签名，不发布`);
    return { ...prepared, dryRun: true };
  }
  const frontend = frontendMode === 'source' ? await (options.buildFrontend ?? buildFrontend)(root, { allowDirty: true, restoreGenerated: true, cleanDist: false }) : prepared.frontend;
  if (!frontend?.distDir || !fileReady(path.join(frontend.distDir, 'index.html'))) throw new Error('[pack] 前端 index.html 缺失');
  const helperDir = await (options.prepareComputerUse ?? prepareComputerUse)(root, { ...options, tools, platform, arch });
  const pkg = tools.readJson(path.join(p.client, 'package.json'));
  const generated = builderConfig(pkg, { frontendDist: frontend.distDir, output, version, helperDir });
  fs.mkdirSync(p.cache, { recursive: true });
  const configFile = path.join(p.cache, `electron-builder-${platform}-${arch}.json`);
  tools.atomicJson(configFile, generated);
  const env = unsignedEnv(root);
  await tools.npmRun(p.client, 'build', [], { env });
  const target = platform === 'darwin' ? '--mac' : platform === 'win32' ? '--win' : '--linux';
  await tools.pnpmRun(p.client, ['exec', 'electron-builder', '--config', configFile, target, `--${arch}`, '--publish', 'never', ...(options.dir ? ['--dir'] : [])], { env });
  if (!fs.existsSync(output) || fs.readdirSync(output).length === 0) throw new Error(`[pack] 打包完成但输出目录为空: ${output}`);
  console.log(`[pack] Nuwax 无签名包: ${output}；前端 ${frontend.stamp ?? frontend.sourceSha} (${frontendMode})`);
  return { output, configFile, frontend, platform, arch, version };
}
