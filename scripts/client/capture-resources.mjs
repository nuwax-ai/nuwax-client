import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import * as core from './core.mjs';
import { buildNotices, inspectFfmpegConfiguration, parseFfmpegConfiguration, writeNotices } from './third-party-notices.mjs';

export const CAPTURE_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64'];
export const captureSourceLockFile = (root) => path.join(root, 'third-party/capture-sources.json');
export const captureResourceDir = (root, platform = process.platform, arch = process.arch) => path.join(root, 'resources/capture', `${platform}-${arch}`);
export const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function readCaptureSourceLock(root) {
  const lock = core.readJson(captureSourceLockFile(root));
  if (lock.schema !== 1) throw new Error('[capture] 未知源码锁格式');
  for (const name of ['ffmpeg', 'libvpx']) {
    const item = lock[name];
    if (!item?.version || !/^https:\/\//.test(item.url ?? '') || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '')) throw new Error(`[capture] ${name} 必须有固定源码 URL、版本和 SHA256`);
    if (!/^[A-Za-z0-9._-]+$/.test(item.archive ?? '') || !/^[A-Za-z0-9._-]+$/.test(item.directory ?? '')) throw new Error(`[capture] ${name} 路径无效`);
  }
  return lock;
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
  for (const name of ['ffmpeg', 'libvpx']) {
    if (record.sources?.[name]?.sha256 !== lock[name].sha256 || record.sources[name].url !== lock[name].url) return null;
    const archive = path.join(root, 'resources/capture/sources', lock[name].archive);
    if (!fs.existsSync(archive) || sha256(archive) !== lock[name].sha256) return null;
  }
  const run = await tools.run(binary, ['-version'], { capture: true, allowFailure: true, timeout: 15000 });
  if (run.status !== 0 || !run.stdout.startsWith(`ffmpeg version ${lock.ffmpeg.version} `)) return null;
  const configuration = parseFfmpegConfiguration(run.stdout);
  if (inspectFfmpegConfiguration(configuration).length || configuration !== record.configuration) return null;
  return { dir, binary, record };
}

export function captureBuildArguments(lock, { platform, arch, prefix, compiler, sdk }) {
  if (!CAPTURE_PLATFORMS.includes(`${platform}-${arch}`)) throw new Error(`[capture] 不支持 ${platform}-${arch}`);
  const vpxTarget = platform === 'darwin' ? arch === 'arm64' ? 'arm64-darwin25-gcc' : 'x86_64-darwin25-gcc' : arch === 'arm64' ? 'arm64-win64-gcc' : 'x86_64-win64-gcc';
  const libvpx = [`--prefix=${prefix}`, `--target=${vpxTarget}`, '--disable-examples', '--disable-tools', '--disable-docs', '--disable-unit-tests', '--disable-shared', '--enable-static', '--disable-vp8', '--enable-vp9', '--enable-pic'];
  const ffmpeg = [
    `--prefix=${prefix}`, '--disable-autodetect', '--disable-gpl', '--disable-nonfree', '--disable-version3',
    '--disable-doc', '--disable-debug', '--disable-network', '--disable-everything', '--disable-ffplay', '--disable-ffprobe',
    '--enable-ffmpeg', '--enable-avcodec', '--enable-avformat', '--enable-avfilter', '--enable-swscale', '--enable-static', '--disable-shared', '--enable-libvpx',
    `--enable-${platform === 'darwin' ? 'videotoolbox' : 'mediafoundation'}`,
    `--enable-encoder=${platform === 'darwin' ? 'h264_videotoolbox' : 'h264_mf'},libvpx_vp9,gif`,
    '--enable-decoder=vp8,vp9,h264,wrapped_avframe', '--enable-demuxer=matroska,mov', '--enable-muxer=mp4,webm,gif,null',
    '--enable-protocol=file,pipe', '--enable-indev=lavfi', '--enable-filter=crop,pad,scale,format,palettegen,paletteuse,split,fps,null,color,testsrc2,setpts,setsar',
    `--extra-cflags=-I${prefix}/include`, `--extra-ldflags=-L${prefix}/lib`,
  ];
  if (platform === 'darwin') {
    ffmpeg.push(`--cc=${compiler}`, `--host-cc=${compiler}`, `--host-cflags=-isysroot ${sdk}`, `--host-ldflags=-isysroot ${sdk}`, `--sysroot=${sdk}`, `--arch=${arch === 'arm64' ? 'aarch64' : 'x86_64'}`);
  } else ffmpeg.push('--target-os=mingw32', `--arch=${arch === 'arm64' ? 'aarch64' : 'x86_64'}`);
  return { libvpx, ffmpeg };
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
  // Always extract the locked archives afresh. Failed configure runs and local
  // changes in an older build directory can never become a new shipped binary.
  const parent = path.join(core.paths(root).cache, 'capture/build', `${platform}-${arch}`, randomUUID());
  fs.mkdirSync(parent, { recursive: true });
  const archives = {};
  for (const name of ['ffmpeg', 'libvpx']) {
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
  const args = captureBuildArguments(lock, { platform, arch, prefix, compiler, sdk });
  const shell = platform === 'win32' ? process.env.NUWAX_CAPTURE_BUILD_BASH || 'bash' : '/bin/bash';
  const env = { ...process.env, PKG_CONFIG_PATH: path.join(prefix, 'lib/pkgconfig') };
  if (platform === 'darwin') Object.assign(env, { CC: compiler, CXX: compiler.replace(/clang$/, 'clang++'), SDKROOT: sdk });
  const jobs = String(Math.max(1, Math.min(8, os.cpus().length)));
  for (const name of ['libvpx', 'ffmpeg']) {
    const cwd = path.join(parent, lock[name].directory);
    console.log(`[capture] 编译 ${name} ${lock[name].version} (${platform}-${arch})`);
    await tools.run(shell, ['./configure', ...args[name]], { cwd, env, capture: true });
    await tools.run('make', [`-j${jobs}`], { cwd, env, capture: true });
    await tools.run('make', ['install'], { cwd, env, capture: true });
  }
  return { binary: path.join(prefix, 'bin', platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'), archives, sourceDirs: Object.fromEntries(['ffmpeg', 'libvpx'].map((name) => [name, path.join(parent, lock[name].directory)])), args };
}

/** Separate capture audit never stands in for the complete shipped-resource audit. */
export async function writeCaptureNotices(root, { tools = core, platform = process.platform, arch = process.arch, outDir = path.join(root, 'third-party/generated-capture') } = {}) {
  const manifest = tools.readJson(path.join(root, 'third-party/manifest.json'));
  const capture = manifest.resources?.capture;
  if (!capture) throw new Error('[capture] 缺少 capture 开源组件声明');
  const result = buildNotices({ root, manifest: { ...manifest, resources: { capture } }, resourcePaths: { capture: captureResourceDir(root, platform, arch) }, npmComponents: [], readFfmpegVersion: (binary) => core.run(binary, ['-version'], { capture: true, allowFailure: true }).stdout });
  if (result.problems.length) throw new Error(`[capture] 开源声明未通过: ${result.problems.map((p) => `${p.code}:${p.id}`).join(', ')}`);
  return writeNotices(result, outDir);
}

export async function prepareCaptureResources(root, options = {}) {
  const opt = { tools: core, platform: process.platform, arch: process.arch, ...options };
  if (opt.platform === 'linux') return null;
  if (!CAPTURE_PLATFORMS.includes(`${opt.platform}-${opt.arch}`)) throw new Error(`[capture] 不支持 ${opt.platform}-${opt.arch}`);
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
  const version = await opt.tools.run(built.binary, ['-version'], { capture: true });
  const configuration = parseFfmpegConfiguration(version.stdout);
  const problems = inspectFfmpegConfiguration(configuration);
  if (problems.length) throw new Error(`[capture] 拒绝 ${problems.map((p) => p.code).join(', ')} 构建`);
  if (!version.stdout.startsWith(`ffmpeg version ${lock.ffmpeg.version} `)) throw new Error('[capture] 构建版本与源码锁不匹配');
  const sources = path.join(root, 'resources/capture/sources');
  fs.mkdirSync(sources, { recursive: true });
  for (const name of ['ffmpeg', 'libvpx']) {
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
    opt.tools.atomicJson(path.join(staging, 'resource.json'), { schema: 1, platform: opt.platform, arch: opt.arch, version: lock.ffmpeg.version, sha256: sha256(binary), configuration, sources: { ffmpeg: lock.ffmpeg, libvpx: lock.libvpx }, buildArguments: built.args });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    if (existing) fs.rmSync(dir, { recursive: true });
    fs.renameSync(staging, dir);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  await writeCaptureNotices(root, opt);
  if (!await inspectCaptureResource(root, opt)) throw new Error('[capture] 构建结果核验失败');
  return dir;
}
