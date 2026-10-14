/** 只下载锁定的目标平台 Koffi 预编译模块，不运行 npm 安装脚本、不触碰基座依赖。 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as core from './core.mjs';
import { detectLicense } from './third-party-notices.mjs';

export const captureWindowSourceLockFile = root => path.join(root, 'third-party/capture-window-sources.json');
const digest = file => core.fileHash(file);
export const CAPTURE_RESOURCE_FILES = ['ffmpeg', 'ffmpeg.exe', 'resource.json', 'koffi.node', 'koffi.json'];

export function readCaptureWindowSourceLock(root) {
  const lock = core.readJson(captureWindowSourceLockFile(root));
  if (lock.schema !== 1 || !/^\d+\.\d+\.\d+$/.test(lock.version)) throw new Error('[capture] Invalid Koffi source lock');
  for (const [target, entry] of Object.entries({ source: lock.source, ...lock.targets })) {
    if (!entry || !/^https:\/\/registry\.npmjs\.org\//.test(entry.url) || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || !/^[A-Za-z0-9._-]+\.tgz$/.test(entry.archive)) throw new Error('[capture] Invalid Koffi package lock');
    if (target !== 'source' && (!/^(darwin|win32|linux)-(arm64|x64)$/.test(target)
      || entry.binary !== `package/${target.replace('-', '_')}/koffi.node` || !/^[a-f0-9]{64}$/.test(entry.binarySha256))) {
      throw new Error('[capture] Invalid Koffi target lock');
    }
  }
  if (lock.source.licenseFile !== 'package/LICENSE.txt') throw new Error('[capture] Invalid Koffi license path');
  return lock;
}

export function inspectCaptureWindowResource(root, { platform = process.platform, arch = process.arch } = {}) {
  const lock = readCaptureWindowSourceLock(root);
  const target = lock.targets[`${platform}-${arch}`];
  if (!target) return null;
  const dir = path.join(root, 'resources/capture', `${platform}-${arch}`);
  const binary = path.join(dir, 'koffi.node');
  try {
    const record = core.readJson(path.join(dir, 'koffi.json'));
    if (record.schema !== 1 || record.version !== lock.version || record.platform !== platform || record.arch !== arch
      || record.sha256 !== target.binarySha256 || digest(binary) !== record.sha256) return null;
    return { dir, binary, record };
  } catch { return null; }
}

async function archive(root, entry, tools) {
  const file = path.join(core.paths(root).cache, 'capture-koffi', entry.archive);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    if (digest(file) !== entry.sha256) throw new Error('[capture] Koffi archive SHA256 mismatch');
    return file;
  }
  const partial = `${file}.${randomUUID()}.part`;
  try {
    await tools.run('curl', ['--fail', '--location', '--retry', '3', '--retry-all-errors', '--max-time', '60', entry.url, '--output', partial], { capture: true });
    if (digest(partial) !== entry.sha256) throw new Error('[capture] Koffi download SHA256 mismatch');
    fs.renameSync(partial, file); return file;
  } finally { fs.rmSync(partial, { force: true }); }
}

export async function prepareCaptureWindowResources(root, { platform = process.platform, arch = process.arch, tools = core } = {}) {
  const lock = readCaptureWindowSourceLock(root), target = lock.targets[`${platform}-${arch}`];
  if (!target) throw new Error('[capture] Unsupported Koffi platform/architecture');
  const dir = path.join(root, 'resources/capture', `${platform}-${arch}`);
  const binary = path.join(dir, 'koffi.node');
  // 手工准备的同版本官方模块可接管；不覆盖未知或被改动的文件。
  if (fs.existsSync(binary) && digest(binary) !== target.binarySha256) throw new Error('[capture] Refusing to overwrite changed Koffi resource');
  const sourceArchive = await archive(root, lock.source, tools);
  const targetArchive = await archive(root, target, tools);
  const staging = path.join(core.paths(root).cache, 'capture-koffi', randomUUID());
  fs.mkdirSync(staging, { recursive: true });
  try {
    // Git Bash 的 GNU tar 会把盘符当作远程主机；Windows 必须明确调用系统 BSD tar。
    const tar = platform === 'win32'
      ? path.win32.join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
    await tools.run(tar, ['-xf', sourceArchive, '-C', staging, lock.source.licenseFile], { capture: true });
    await tools.run(tar, ['-xf', targetArchive, '-C', staging, target.binary], { capture: true });
    const license = path.join(staging, lock.source.licenseFile), native = path.join(staging, target.binary);
    if (detectLicense(fs.readFileSync(license, 'utf8')) !== 'MIT' || digest(native) !== target.binarySha256) throw new Error('[capture] Koffi extracted payload failed verification');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(native, binary);
    core.atomicJson(path.join(dir, 'koffi.json'), { schema: 1, platform, arch, version: lock.version, sha256: target.binarySha256 });
    const sources = path.join(root, 'resources/capture/sources'), licenses = path.join(root, 'third-party/licenses');
    fs.mkdirSync(sources, { recursive: true }); fs.mkdirSync(licenses, { recursive: true });
    fs.copyFileSync(sourceArchive, path.join(sources, lock.source.archive));
    fs.copyFileSync(license, path.join(licenses, 'koffi.txt'));
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  if (!inspectCaptureWindowResource(root, { platform, arch })) throw new Error('[capture] Koffi resource admission failed');
  return dir;
}
