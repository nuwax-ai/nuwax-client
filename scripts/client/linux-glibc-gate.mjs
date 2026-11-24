#!/usr/bin/env node
/**
 * Linux 安装包的 glibc 门禁。
 *
 * 背景：CI runner 是 Ubuntu 24.04（glibc 2.39），在那里编出的原生件会带
 * GLIBC_2.34～2.39 的符号；UOS 20 Pro 1050 只有 glibc 2.28，加载即失败。
 * 安装不受影响（dpkg 只拷文件），Electron 自身也不受影响（只需 2.25），
 * 出问题的只有我们自己编的原生件。
 *
 * 本脚本扫描打包产物里的每个 ELF，读它需要的最高 GLIBC 符号版本，超过上限
 * 即失败。用途是防回归：谁在构建容器之外编了东西、或新依赖带了新的原生件，
 * 这里会直接拦下，而不是等装到目标系统上才发现。
 *
 * 自己解析 ELF，不依赖 readelf：门禁的结论不应随 runner 装了什么而变。
 *
 * 用法：
 *   node scripts/client/linux-glibc-gate.mjs --verify-output <产物目录> --arch <arm64|x64> [--report-only]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packagedResources } from '../prepare-release-updater.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseGlibcVersion, compareGlibcVersions } = require(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../../nuwa-electron-shell/crates/agent-electron-client/scripts/build/linux-package-policy.cjs'),
);

/** 目标系统的 glibc 上限。改这个值等于改变对客户的承诺，须同步 UOS 真机验收。 */
export const GLIBC_FLOOR = '2.28';

/**
 * 豁免清单。每项必须写明原因和处置办法，否则以后会有人为了过门禁随手往里加。
 * 匹配的是相对安装目录（`linux-<arch>-unpacked/`）的路径，所以带 `resources/` 前缀；
 * 支持单个 `*` 通配一段目录名（用于架构目录）。
 */
export const ALLOWLIST = [
  {
    pattern: 'resources/agent-desktop/*/agent-desktop-linux-*',
    required: '2.35',
    reason: '上游 npm 包 agent-desktop 的预编译二进制，不是我们编的；容器无法降低它的 glibc 需求',
    resolution: '按产品决定，UOS 上不支持 Agent Desktop 引擎，默认的 CUA Driver 不受影响；需要时另行从源码构建',
  },
];

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

/** 判断一个文件是不是 ELF。只读文件头，不读全文。 */
export function isElfFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const header = Buffer.alloc(4);
    fs.readSync(fd, header, 0, 4, 0);
    return header.equals(ELF_MAGIC);
  } catch {
    return false;
  } finally {
    fd?.closeSync?.();
  }
}

/**
 * 解析 ELF，返回它引用的 (文件名, 版本) 列表里所有 GLIBC_x.y 中的最高者。
 * 读的是 .gnu.version_r 段：动态加载器就是靠它判断 "version `GLIBC_x.y' not found"。
 *
 * @returns {{major:number, minor:number}|null} 没有 GLIBC 版本引用（如纯静态）时返回 null
 */
export function readHighestGlibc(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.length < 64 || !buffer.subarray(0, 4).equals(ELF_MAGIC)) return null;
  const is64 = buffer[4] === 2;
  const littleEndian = buffer[5] === 1;
  const u16 = (offset) => (littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset));
  const u32 = (offset) => (littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset));
  const u64 = (offset) => (littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset));
  const readString = (start) => {
    const end = buffer.indexOf(0, start);
    return buffer.subarray(start, end < 0 ? start : end).toString('latin1');
  };

  // ELF 头：节头表位置在 e_shoff（64 位偏移 0x28，32 位偏移 0x20）。
  const shoff = Number(is64 ? u64(0x28) : u32(0x20));
  const shentsize = u16(is64 ? 0x3a : 0x2e);
  const shnum = u16(is64 ? 0x3c : 0x30);
  const shstrndx = u16(is64 ? 0x3e : 0x32);
  if (!shoff || !shnum || shstrndx >= shnum) return null;

  // 节头字段随位宽变化，按偏移逐个取。
  const sectionAt = (index) => shoff + index * shentsize;
  const shName = (i) => u32(sectionAt(i));
  const shType = (i) => u32(sectionAt(i) + 4);
  const shOffset = (i) => Number(is64 ? u64(sectionAt(i) + 0x18) : u32(sectionAt(i) + 0x10));
  const shSize = (i) => Number(is64 ? u64(sectionAt(i) + 0x20) : u32(sectionAt(i) + 0x14));
  const shLink = (i) => u32(sectionAt(i) + (is64 ? 0x28 : 0x18));

  const strtabOffset = shOffset(shstrndx);

  // SHT_GNU_verneed = 0x6ffffffe，SHT_GNU_versym = 0x6fffffff
  const SHT_GNU_VERNEED = 0x6ffffffe;
  let highest = null;
  for (let i = 0; i < shnum; i += 1) {
    if (shType(i) !== SHT_GNU_VERNEED) continue;
    const strTabOffset = shOffset(shLink(i));
    let entry = shOffset(i);
    const end = entry + shSize(i);
    while (entry < end) {
      // Elf64_Verneed: vn_version(2) vn_cnt(2) vn_file(4) vn_aux(4) vn_next(4) = 16 bytes.
      // vn_file and vn_aux are offsets: into the linked string table and to the
      // first Vernaux, measured from the start of this Verneed.
      const vnCnt = u16(entry + 2);
      let aux = entry + u32(entry + 8);
      for (let n = 0; n < vnCnt; n += 1) {
        // Elf64_Vernaux: vna_hash(4) vna_flags(2) vna_other(2) vna_name(4) vna_next(4) = 16 bytes.
        const version = readString(strTabOffset + u32(aux + 8));
        // "GLIBC_x.y" is a version name only the glibc family defines, so the
        // name alone identifies it; no need to filter by which library needs it.
        const glibc = /^GLIBC_(\d+)\.(\d+)$/.exec(version);
        if (glibc) {
          const parsed = { major: Number(glibc[1]), minor: Number(glibc[2]) };
          if (highest === null || compareGlibcVersions(parsed, highest) > 0) highest = parsed;
        }
        const vnaNext = u32(aux + 12);
        if (!vnaNext) break;
        aux += vnaNext;
      }
      const vnNext = u32(entry + 12);
      if (!vnNext) break;
      entry += vnNext;
    }
  }
  return highest;
}

/** 把 glob 模式编译成正则。只支持 `*`，且 `*` 不跨 `/`。 */
export function patternToRegExp(pattern) {
  const escaped = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*');
  return new RegExp(`^${escaped}$`);
}

/** 递归列出目录下的所有普通文件（不跟随符号链接）。 */
export function listFiles(directory) {
  const files = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(directory);
  return files.sort();
}

/**
 * 扫描一个目录里所有 ELF 的 glibc 需求。
 * @returns {{violations: object[], allowed: object[], scanned: number, elves: number}}
 */
export function scanGlibc(directory, { floor = GLIBC_FLOOR, allowlist = ALLOWLIST } = {}) {
  const limit = parseGlibcVersion(floor);
  if (!limit) throw new Error(`[linux-glibc-gate] glibc 上限格式无效：${floor}`);
  for (const entry of allowlist) {
    if (!entry.reason || !entry.resolution) throw new Error(`[linux-glibc-gate] 豁免项必须写明 reason 和 resolution：${entry.pattern}`);
  }
  const files = listFiles(directory);
  const violations = [];
  const allowed = [];
  let elves = 0;
  for (const file of files) {
    if (!isElfFile(file)) continue;
    elves += 1;
    const required = readHighestGlibc(file);
    if (required === null) continue;
    if (compareGlibcVersions(required, limit) <= 0) continue;
    const relative = path.relative(directory, file).split(path.sep).join('/');
    const entry = { file: relative, required: `${required.major}.${required.minor}` };
    const exemption = allowlist.find((item) => patternToRegExp(item.pattern).test(relative));
    if (exemption) allowed.push({ ...entry, reason: exemption.reason });
    else violations.push(entry);
  }
  return { violations, allowed, scanned: files.length, elves };
}

/**
 * 某个架构的解包安装目录（electron-builder 的输出布局）。
 * x64 的目录不带架构后缀（`linux-unpacked`），arm64 带（`linux-arm64-unpacked`）。
 * 规则只有这一处：取自 prepare-release-updater 的 packagedResources，
 * 调用方（含镜像 workflow 里把产物摆成安装目录的步骤）都从这里拿，不要各抄一份。
 */
export function unpackedAppDir(output, arch) {
  return path.dirname(packagedResources(output, 'linux', arch));
}

/**
 * 校验打包产物的 glibc 需求。
 * @param {string} output electron-builder 的输出目录
 */
export function verifyLinuxGlibc(output, { platform, arch, reportOnly = false, floor = GLIBC_FLOOR } = {}) {
  if (platform !== 'linux') return null;
  // 扫描整个安装目录，不只是 resources/：Electron 自带的二进制也在承诺范围内。
  const appDir = unpackedAppDir(output, arch);
  let stat;
  try { stat = fs.lstatSync(appDir); } catch { /* 统一按缺失处理 */ }
  if (!stat?.isDirectory()) throw new Error(`[linux-glibc-gate] 找不到打包目录：${appDir}`);
  const result = scanGlibc(appDir, { floor });
  if (result.violations.length) {
    const detail = result.violations.map((item) => `  ${item.file}  需要 GLIBC_${item.required}`).join('\n');
    const message = `[linux-glibc-gate] 以下 ELF 需要的 glibc 高于 ${floor}，在 UOS 1050 等系统上无法加载：\n${detail}`;
    if (reportOnly) console.warn(`${message}\n（--report-only：本次只报告，不失败）`);
    else throw new Error(message);
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    const names = new Set(['--verify-output', '--platform', '--arch']);
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '--report-only') { options.reportOnly = true; continue; }
      if (!names.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || options[args[i]]) throw new Error('[linux-glibc-gate] Invalid command arguments');
      options[args[i]] = args[i + 1];
      i += 1;
    }
    if (!options['--verify-output']) throw new Error('[linux-glibc-gate] Use --verify-output DIRECTORY [--platform linux] [--arch ARCH] [--report-only]');
    const result = verifyLinuxGlibc(options['--verify-output'], {
      platform: options['--platform'] || process.platform,
      arch: options['--arch'] || process.arch,
      reportOnly: options.reportOnly,
    });
    if (!result) console.log('[linux-glibc-gate] 非 Linux 平台，本门禁不适用');
    else {
      console.log(`[linux-glibc-gate] ${result.elves} 个 ELF 均不超过 glibc ${GLIBC_FLOOR}（共扫描 ${result.scanned} 个文件）`);
      for (const item of result.allowed) console.log(`[linux-glibc-gate] 豁免：${item.file} 需要 GLIBC_${item.required} — ${item.reason}`);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
