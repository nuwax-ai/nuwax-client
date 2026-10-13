import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import * as core from './core.mjs';
import { buildNotices, inspectFfmpegConfiguration, parseFfmpegConfiguration, writeNotices } from './third-party-notices.mjs';

export const CAPTURE_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64'];
export const captureSourceLockFile = (root) => path.join(root, 'third-party/capture-sources.json');
export const captureResourceDir = (root, platform = process.platform, arch = process.arch) => path.join(root, 'resources/capture', `${platform}-${arch}`);
export const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function readCaptureSourceLock(root) {
  const lock = core.readJson(captureSourceLockFile(root));
  if (lock.schema !== 1) throw new Error('[capture] 未知源码锁格式');
  for (const name of ['ffmpeg', 'libvpx', 'openh264']) {
    const item = lock[name];
    if (!item?.version || !/^https:\/\//.test(item.url ?? '') || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '')) throw new Error(`[capture] ${name} 必须有固定源码 URL、版本和 SHA256`);
    if (!/^[A-Za-z0-9._-]+$/.test(item.archive ?? '') || !/^[A-Za-z0-9._-]+$/.test(item.directory ?? '')) throw new Error(`[capture] ${name} 路径无效`);
  }
  return lock;
}

const captureSourceNames = (platform) => ['ffmpeg', 'libvpx', ...(platform === 'linux' ? ['openh264'] : [])];

function readWindowsRuntimeSource(root, tools = core) {
  const entry = tools.readJson(path.join(root, 'third-party/manifest.json')).resources?.capture?.components?.find((item) => item.id === 'winpthreads');
  if (!entry?.version || !entry.toolchainPackageVersion || !/^https:\/\//.test(entry.sourceUrl ?? '') || !/^[a-f0-9]{64}$/.test(entry.sourceSha256 ?? '') || !entry.sourceFile) {
    throw new Error('[capture] 缺少固定 Winpthreads 版本、工具链包版本、源码 URL 或 SHA256');
  }
  return { version: entry.version, toolchainPackageVersion: entry.toolchainPackageVersion, url: entry.sourceUrl, sha256: entry.sourceSha256, archive: path.basename(entry.sourceFile) };
}

function matchesRuntimeSource(actual, expected) {
  return !!actual && ['version', 'toolchainPackageVersion', 'url', 'sha256', 'archive'].every((key) => actual[key] === expected[key]);
}

/** No system/PATH fallback: the only admitted binary is this verified resource. */
export async function inspectCaptureResource(root, { platform = process.platform, arch = process.arch, tools = core } = {}) {
  if (!CAPTURE_PLATFORMS.includes(`${platform}-${arch}`)) return null;
  const dir = captureResourceDir(root, platform, arch);
  const binary = path.join(dir, platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const lock = readCaptureSourceLock(root);
  let record;
  try { record = tools.readJson(path.join(dir, 'resource.json')); } catch { return null; }
  if (record.schema !== 1 || record.platform !== platform || record.arch !== arch || record.version !== lock.ffmpeg.version) return null;
  if (!/^[a-f0-9]{64}$/.test(record.sha256 ?? '') || !fs.existsSync(binary) || sha256(binary) !== record.sha256) return null;
  for (const name of captureSourceNames(platform)) {
    if (record.sources?.[name]?.sha256 !== lock[name].sha256 || record.sources[name].url !== lock[name].url || record.sources[name].version !== lock[name].version) return null;
    const archive = path.join(root, 'resources/capture/sources', lock[name].archive);
    if (!fs.existsSync(archive) || sha256(archive) !== lock[name].sha256) return null;
  }
  if (platform === 'win32') {
    let runtime;
    try { runtime = readWindowsRuntimeSource(root, tools); } catch { return null; }
    if (!matchesRuntimeSource(record.sources?.winpthreads, runtime)) return null;
    const archive = path.join(root, 'resources/capture/sources', runtime.archive);
    if (!fs.existsSync(archive) || sha256(archive) !== runtime.sha256) return null;
  }
  const run = await tools.run(binary, ['-version'], { capture: true, allowFailure: true, timeout: 15000 });
  if (run.status !== 0 || !run.stdout.startsWith(`ffmpeg version ${lock.ffmpeg.version} `)) return null;
  const configuration = parseFfmpegConfiguration(run.stdout);
  if (inspectFfmpegConfiguration(configuration).length || configuration !== record.configuration) return null;
  return { dir, binary, record };
}

export function captureBuildArguments(lock, { platform, arch, prefix, compiler, sdk }) {
  if (!CAPTURE_PLATFORMS.includes(`${platform}-${arch}`)) throw new Error(`[capture] 不支持 ${platform}-${arch}`);
  const cpu = arch === 'arm64' ? 'arm64' : 'x86_64';
  // darwin 版本须与实际 SDK 一致（arm64 runner=macOS 26/darwin25，intel runner=macos-15/darwin24）
  const darwinVersion = platform === 'darwin' ? (sdk?.match(/MacOSX(\d+)\.sdk/)?.[1] ?? '25') : null;
  const vpxTarget = `${cpu}-${platform === 'darwin' ? `darwin${darwinVersion}` : platform === 'win32' ? 'win64' : 'linux'}-gcc`;
  const h264Encoder = platform === 'darwin' ? 'h264_videotoolbox' : platform === 'win32' ? 'h264_mf' : 'libopenh264';
  const libvpx = [`--prefix=${prefix}`, `--target=${vpxTarget}`, '--disable-examples', '--disable-tools', '--disable-docs', '--disable-unit-tests', '--disable-shared', '--enable-static', '--disable-vp8', '--enable-vp9', '--enable-pic'];
  const ffmpeg = [
    `--prefix=${prefix}`, '--disable-autodetect', '--disable-gpl', '--disable-nonfree', '--disable-version3',
    '--disable-doc', '--disable-debug', '--disable-network', '--disable-everything', '--disable-ffplay', '--disable-ffprobe',
    '--enable-ffmpeg', '--enable-avcodec', '--enable-avformat', '--enable-avfilter', '--enable-swscale', '--enable-static', '--disable-shared', '--enable-libvpx',
    `--enable-${platform === 'darwin' ? 'videotoolbox' : platform === 'win32' ? 'mediafoundation' : 'libopenh264'}`,
    `--enable-encoder=${h264Encoder},libvpx_vp9,gif`,
    '--enable-decoder=vp8,vp9,h264,wrapped_avframe', '--enable-demuxer=matroska,mov', '--enable-muxer=mp4,webm,gif,null',
    '--enable-protocol=file,pipe', '--enable-indev=lavfi', '--enable-filter=crop,pad,scale,format,palettegen,paletteuse,split,fps,null,color,testsrc2,setpts,setsar',
    `--extra-cflags=-I${prefix}/include`, `--extra-ldflags=-L${prefix}/lib${platform === 'win32' ? ' -static' : ''}`,
  ];
  if (platform === 'darwin') {
    ffmpeg.push(`--cc=${compiler}`, `--host-cc=${compiler}`, `--host-cflags=-isysroot ${sdk}`, `--host-ldflags=-isysroot ${sdk}`, `--sysroot=${sdk}`, `--arch=${arch === 'arm64' ? 'aarch64' : 'x86_64'}`);
  } else if (platform === 'win32') ffmpeg.push('--target-os=mingw32', `--arch=${arch === 'arm64' ? 'aarch64' : 'x86_64'}`, '--enable-d3d11va');
  else ffmpeg.push('--target-os=linux', `--arch=${arch === 'arm64' ? 'aarch64' : 'x86_64'}`, '--pkg-config-flags=--static');
  const openh264 = platform === 'linux' ? [`PREFIX=${prefix}`, 'OS=linux', `ARCH=${arch === 'arm64' ? 'aarch64' : 'x86_64'}`, 'BUILDTYPE=Release'] : undefined;
  return { libvpx, ffmpeg, ...(openh264 ? { openh264 } : {}) };
}

/** Configure and make must see the same MSYS path, including when the checkout
 * lives on another drive or contains spaces. Never interpolate it into a shell. */
export async function captureBuildPaths(prefix, { platform, shell, tools = core }) {
  const buildPrefix = platform === 'win32'
    ? (await tools.run(shell, ['-c', 'cygpath -u "$1"', 'capture-path', prefix], { capture: true })).stdout.trim()
    : prefix;
  if (!buildPrefix.startsWith('/')) throw new Error('[capture] 构建 shell 必须提供绝对 Unix 路径（Windows 需要 MSYS2 cygpath）');
  return { prefix: buildPrefix, pkgConfigPath: `${buildPrefix}/lib/pkgconfig` };
}

export async function assertCaptureWindowsToolchain({ shell, arch, tools = core, runtimePackageVersion }) {
  const probe = await tools.run(shell, ['-c', 'for tool in gcc make pkg-config cygpath; do command -v "$tool" >/dev/null || { echo "Missing $tool"; exit 1; }; done; command -v yasm >/dev/null || command -v nasm >/dev/null || { echo "Missing yasm/nasm"; exit 1; }; gcc -dumpmachine'], { capture: true, allowFailure: true });
  const target = arch === 'arm64' ? 'aarch64' : 'x86_64';
  if (probe.status !== 0 || !new RegExp(`^${target}-[^\\s]*mingw`).test(probe.stdout.trim())) {
    throw new Error(`[capture] Windows 构建需要 MSYS2 MinGW ${arch} GCC、make、pkg-config、cygpath 和 yasm/nasm。请设置 NUWAX_CAPTURE_BUILD_BASH 为 MSYS2 bash，并将对应工具链 bin 与 MSYS2 usr/bin 加入 PATH；仅设置 bash 路径不会配置编译器。${(probe.stderr || probe.stdout).trim()}`);
  }
  if (runtimePackageVersion) {
    const runtime = await tools.run(shell, ['-c', 'library=$(gcc -print-file-name=libwinpthread.a); package=$(pacman -Qoq "$library") || exit 1; pacman -Q "$package"'], { capture: true, allowFailure: true });
    if (runtime.status !== 0 || runtime.stdout.trim().split(/\s+/).at(-1) !== runtimePackageVersion) {
      throw new Error(`[capture] Winpthreads 静态运行库必须匹配固定源码包 ${runtimePackageVersion}；当前为 ${(runtime.stdout || runtime.stderr).trim() || '未知'}。请安装匹配的 MSYS2 包或同步审核更新源码/许可证声明。`);
    }
    const [toolchainPackage, toolchainPackageVersion] = runtime.stdout.trim().split(/\s+/);
    return { toolchainPackage, toolchainPackageVersion };
  }
}

export async function assertCaptureLinuxToolchain({ shell = '/bin/bash', arch, tools = core }) {
  const probe = await tools.run(shell, ['-c', 'for tool in gcc g++ make pkg-config tar; do command -v "$tool" >/dev/null || { echo "Missing $tool"; exit 1; }; done; command -v yasm >/dev/null || command -v nasm >/dev/null || { echo "Missing yasm/nasm"; exit 1; }; gcc -dumpmachine'], { capture: true, allowFailure: true });
  const target = arch === 'arm64' ? 'aarch64' : 'x86_64';
  if (probe.status !== 0 || !new RegExp(`^${target}-[^\\s]*linux`).test(probe.stdout.trim())) {
    throw new Error(`[capture] Linux 构建需要原生 ${arch} GCC/G++、make、pkg-config、tar 和 yasm/nasm；请安装 build-essential pkg-config nasm，并在对应架构构建。${(probe.stderr || probe.stdout).trim()}`);
  }
}

async function ensureArchive(root, name, source, tools) {
  const file = path.join(core.paths(root).cache, 'capture/downloads', source.archive);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    if (sha256(file) === source.sha256) return file;
    throw new Error(`[capture] ${name} 已缓存源码校验失败，拒绝使用: ${file}`);
  }
  const partial = `${file}.${randomUUID()}.part`;
  try {
    await tools.run('curl', ['--fail', '--location', '--retry', '4', '--retry-all-errors', source.url, '--output', partial], { capture: true });
    if (sha256(partial) !== source.sha256) throw new Error(`[capture] ${name} 下载 SHA256 不匹配`);
    fs.renameSync(partial, file);
    return file;
  } finally { fs.rmSync(partial, { force: true }); }
}

async function buildCaptureBinary(root, lock, options) {
  const { tools, platform, arch } = options;
  if (platform !== process.platform || arch !== process.arch) throw new Error('[capture] 原生资源必须在对应平台/架构构建；此脚本不隐式交叉编译');
  const shell = platform === 'win32' ? process.env.NUWAX_CAPTURE_BUILD_BASH || 'bash' : '/bin/bash';
  let runtimeSource;
  if (platform === 'win32') {
    const expected = readWindowsRuntimeSource(root, tools);
    const actual = await assertCaptureWindowsToolchain({ shell, arch, tools, runtimePackageVersion: expected.toolchainPackageVersion });
    runtimeSource = { ...expected, ...actual };
  }
  if (platform === 'linux') await assertCaptureLinuxToolchain({ shell, arch, tools });
  // Always extract the locked archives afresh. Failed configure runs and local
  // changes in an older build directory can never become a new shipped binary.
  const parent = path.join(core.paths(root).cache, 'capture/build', `${platform}-${arch}`, randomUUID());
  fs.mkdirSync(parent, { recursive: true });
  const archives = {};
  const sourceNames = captureSourceNames(platform);
  for (const name of sourceNames) {
    archives[name] = await ensureArchive(root, name, lock[name], tools);
    const source = path.join(parent, lock[name].directory);
    if (!fs.existsSync(source)) await tools.run('tar', ['-xf', archives[name], '-C', parent], { capture: true });
  }
  const prefix = path.join(parent, 'prefix');
  let compiler, sdk;
  if (platform === 'darwin') {
    compiler = (await tools.run('xcrun', ['--find', 'clang'], { capture: true })).stdout.trim();
    // Xcode's compiler and SDK must match; the host's CLT SDK can be newer than ld.
    const developer = (await tools.run('xcode-select', ['-p'], { capture: true })).stdout.trim();
    const xcodeSdk = path.join(developer, 'Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk');
    sdk = fs.existsSync(xcodeSdk) ? xcodeSdk : (await tools.run('xcrun', ['--show-sdk-path'], { capture: true })).stdout.trim();
  }
  const buildPaths = await captureBuildPaths(prefix, { platform, shell, tools });
  const args = captureBuildArguments(lock, { platform, arch, prefix: buildPaths.prefix, compiler, sdk });
  const env = { ...process.env, PKG_CONFIG_PATH: buildPaths.pkgConfigPath };
  if (platform === 'darwin') Object.assign(env, { CC: compiler, CXX: compiler.replace(/clang$/, 'clang++'), SDKROOT: sdk });
  const jobs = String(Math.max(1, Math.min(8, os.cpus().length)));
  if (platform === 'linux') {
    const cwd = path.join(parent, lock.openh264.directory);
    console.log(`[capture] 编译 openh264 ${lock.openh264.version} (${platform}-${arch})`);
    await tools.run(shell, ['-c', 'exec make "$@"', 'capture-make', `-j${jobs}`, ...args.openh264, 'libraries'], { cwd, env, capture: true });
    // install-static supplies a pkg-config file with the exact C++/pthread dependencies.
    await tools.run(shell, ['-c', 'exec make "$@"', 'capture-make', ...args.openh264, 'install-static'], { cwd, env, capture: true });
  }
  for (const name of ['libvpx', 'ffmpeg']) {
    const cwd = path.join(parent, lock[name].directory);
    console.log(`[capture] 编译 ${name} ${lock[name].version} (${platform}-${arch})`);
    await tools.run(shell, ['./configure', ...args[name]], { cwd, env, capture: true }).catch(error => {
      throw new Error(`[capture] ${name} configure 失败:\n${error.message}`);
    });
    // Use the configure shell's make and path semantics. A Windows PATH may
    // otherwise pick mingw32-make or a different Git Bash/WSL installation.
    await tools.run(shell, ['-c', 'exec make "$@"', 'capture-make', `-j${jobs}`], { cwd, env, capture: true });
    await tools.run(shell, ['-c', 'exec make "$@"', 'capture-make', 'install'], { cwd, env, capture: true });
  }
  if (runtimeSource) await assertCaptureWindowsToolchain({ shell, arch, tools, runtimePackageVersion: runtimeSource.toolchainPackageVersion });
  return { binary: path.join(prefix, 'bin', platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'), archives, sourceDirs: Object.fromEntries(sourceNames.map((name) => [name, path.join(parent, lock[name].directory)])), args, runtimeSource };
}

/** Separate capture audit never stands in for the complete shipped-resource audit. */
export async function writeCaptureNotices(root, { tools = core, platform = process.platform, arch = process.arch, outDir = path.join(root, 'third-party/generated-capture') } = {}) {
  const manifest = tools.readJson(path.join(root, 'third-party/manifest.json'));
  const capture = manifest.resources?.capture;
  if (!capture) throw new Error('[capture] 缺少 capture 开源组件声明');
  const result = buildNotices({ root, manifest: { ...manifest, resources: { capture } }, resourcePaths: { capture: captureResourceDir(root, platform, arch) }, npmComponents: [], readFfmpegVersion: (binary) => core.run(binary, ['-version'], { capture: true, allowFailure: true }).stdout, platform });
  if (result.problems.length) throw new Error(`[capture] 开源声明未通过: ${result.problems.map((p) => `${p.code}:${p.id}`).join(', ')}`);
  return writeNotices(result, outDir);
}

export async function prepareCaptureResources(root, options = {}) {
  const opt = { tools: core, platform: process.platform, arch: process.arch, ...options };
  if (!CAPTURE_PLATFORMS.includes(`${opt.platform}-${opt.arch}`)) throw new Error(`[capture] 不支持 ${opt.platform}-${opt.arch}`);
  if (opt.platform === 'win32') {
    const runtime = readWindowsRuntimeSource(root, opt.tools);
    const sourceFile = path.join(root, 'resources/capture/sources', runtime.archive);
    if (fs.existsSync(sourceFile)) {
      if (sha256(sourceFile) !== runtime.sha256) throw new Error('[capture] Winpthreads 源码归档 SHA256 不匹配');
    } else {
      const archive = await ensureArchive(root, 'winpthreads', runtime, opt.tools);
      fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
      fs.copyFileSync(archive, sourceFile);
    }
  }
  const existing = await inspectCaptureResource(root, opt);
  if (existing && !opt.refreshResources) {
    await writeCaptureNotices(root, opt);
    console.log(`[capture] 复用已核验 LGPL FFmpeg ${existing.record.version}`);
    return existing.dir;
  }
  const dir = captureResourceDir(root, opt.platform, opt.arch);
  if (fs.existsSync(dir) && !existing) throw new Error(`[capture] 拒绝覆盖未知或已改动的资源目录 ${dir}`);
  const lock = readCaptureSourceLock(root);
  const built = await (opt.buildBinary ?? buildCaptureBinary)(root, lock, opt);
  if (opt.platform === 'win32' && !matchesRuntimeSource(built.runtimeSource, readWindowsRuntimeSource(root, opt.tools))) {
    throw new Error('[capture] Windows 构建缺少匹配的实际 Winpthreads 来源记录，拒绝用当前声明补写未知二进制');
  }
  const version = await opt.tools.run(built.binary, ['-version'], { capture: true });
  const configuration = parseFfmpegConfiguration(version.stdout);
  const problems = inspectFfmpegConfiguration(configuration);
  if (problems.length) throw new Error(`[capture] 拒绝 ${problems.map((p) => p.code).join(', ')} 构建`);
  if (!version.stdout.startsWith(`ffmpeg version ${lock.ffmpeg.version} `)) throw new Error('[capture] 构建版本与源码锁不匹配');
  const sources = path.join(root, 'resources/capture/sources');
  fs.mkdirSync(sources, { recursive: true });
  for (const name of captureSourceNames(opt.platform)) {
    if (sha256(built.archives[name]) !== lock[name].sha256) throw new Error(`[capture] ${name} 构建输入校验失败`);
    fs.copyFileSync(built.archives[name], path.join(sources, lock[name].archive));
    const licenseDir = path.join(root, 'third-party/licenses');
    fs.mkdirSync(licenseDir, { recursive: true });
    fs.copyFileSync(path.join(built.sourceDirs[name], lock[name].licenseFile), path.join(licenseDir, `${name}.txt`));
    if (name === 'libvpx') fs.appendFileSync(path.join(licenseDir, 'libvpx.txt'), '\n\n' + fs.readFileSync(path.join(built.sourceDirs[name], 'PATENTS'), 'utf8'));
  }
  const staging = `${dir}.${randomUUID()}.tmp`;
  fs.mkdirSync(staging, { recursive: true });
  try {
    const binary = path.join(staging, opt.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    fs.copyFileSync(built.binary, binary);
    fs.chmodSync(binary, 0o755);
    opt.tools.atomicJson(path.join(staging, 'resource.json'), { schema: 1, platform: opt.platform, arch: opt.arch, version: lock.ffmpeg.version, sha256: sha256(binary), configuration, sources: { ...Object.fromEntries(captureSourceNames(opt.platform).map((name) => [name, lock[name]])), ...(opt.platform === 'win32' ? { winpthreads: built.runtimeSource } : {}) }, buildArguments: built.args });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    if (existing) fs.rmSync(dir, { recursive: true });
    fs.renameSync(staging, dir);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  await writeCaptureNotices(root, opt);
  if (!await inspectCaptureResource(root, opt)) throw new Error('[capture] 构建结果核验失败');
  return dir;
}
