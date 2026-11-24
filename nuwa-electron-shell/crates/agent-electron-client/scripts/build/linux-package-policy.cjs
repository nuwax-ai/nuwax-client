const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Linux 安装包（deb/rpm）的硬链接策略。
 *
 * 背景：electron-builder 在 CI 里默认用硬链接复制文件
 * （builder-util/out/fs.js: `USE_HARD_LINKS` 未显式关闭且 isCI 为真），
 * fpm 打包时保留源文件的链接关系（fpm/lib/fpm/util.rb: 源文件 nlink > 1 即按硬链接处理），
 * tar 于是把同一 inode 的第二个路径写成硬链接条目。dpkg 安装时要在目标位置重建这个链接，
 * 而 UOS 20 Pro 1050 的 /opt 与 /usr 分属不同文件系统，重建跨设备硬链接必然失败
 * （dpkg 报 Invalid cross-device link），整个安装中断。
 *
 * 做法：Linux 目标一律关闭 builder 的硬链接复制，让同一源文件在包内成为两份独立文件。
 * 代价是包体略大（重复内容不再共享 inode），换来任意文件系统布局都能安装。
 */

/** electron-builder 的开关名；置为 "false" 即关闭硬链接复制。 */
const HARD_LINKS_ENV = 'USE_HARD_LINKS';

/** 关闭硬链接时的取值，builder 只认这个字符串。 */
const HARD_LINKS_DISABLED = 'false';

/**
 * 只有 Linux 目标需要这个策略：deb/rpm 会把文件装到多个挂载点。
 * 'mixed' 表示一次构建里混了多个目标，此时按最保守的方式处理。
 */
function needsHardLinkPolicy(platform) {
  return platform === 'linux' || platform === 'mixed';
}

/**
 * 给 Linux 打包补上关闭硬链接的环境变量；其他平台原样返回。
 */
function applyHardLinkPolicy(env, platform) {
  if (!needsHardLinkPolicy(platform)) return env;
  return { ...env, [HARD_LINKS_ENV]: HARD_LINKS_DISABLED };
}

/**
 * 解析 ar 归档（deb 就是 ar 容器）的成员。
 * macOS 自带的 ar 不认识 deb 的成员名，所以这里自己读文件头。
 */
function readArMembers(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.subarray(0, 8).toString('latin1') !== '!<arch>\n') throw new Error(`${file} 不是 ar 归档`);
  const members = [];
  let offset = 8;
  while (offset + 60 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 60);
    if (header.subarray(58, 60).toString('latin1') !== '`\n') throw new Error(`${file} 的成员头损坏`);
    const name = header.subarray(0, 16).toString('latin1').trim().replace(/\/$/, '');
    const size = Number(header.subarray(48, 58).toString('latin1').trim());
    members.push({ name, offset: offset + 60, size });
    offset = offset + 60 + size + (size % 2);
  }
  return members;
}

/**
 * 列出 deb 内数据归档的条目类型，标出其中的硬链接。
 * 硬链接条目在 tar 里以类型字符 'h' 开头，安装时需要在目标位置重建链接。
 * @returns {{hardLinks: Array<{entry: string, target: string}>, entries: number}}
 */
function inspectDebHardLinks(debFile) {
  const members = readArMembers(debFile);
  const data = members.find((member) => member.name.startsWith('data.tar'));
  if (!data) throw new Error(`${debFile} 里没有数据归档`);
  const buffer = fs.readFileSync(debFile);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-deb-'));
  const archive = path.join(work, data.name);
  try {
    fs.writeFileSync(archive, buffer.subarray(data.offset, data.offset + data.size));
    // tar 自身能识别 xz/gzip 压缩，直接列目录即可读到条目类型。
    const result = spawnSync('tar', ['-tvf', archive], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (result.error || result.status !== 0) {
      throw new Error(`无法列出 ${debFile} 的内容：${result.error?.message ?? result.stderr}`);
    }
    const hardLinks = [];
    let entries = 0;
    for (const line of result.stdout.split('\n')) {
      if (!line.trim()) continue;
      entries += 1;
      if (!line.startsWith('h')) continue;
      // 条目形如 "hrw-r--r-- 0/0 0 Nov 24 14:45 ./path link to ./target"：
      // 路径是最后一个以 "./" 开头、且在 "link to" 之前的字段。
      const target = line.match(/ link to (.+)$/)?.[1]?.trim() ?? '';
      const before = line.replace(/\s+link to\s+.+$/, '');
      const fields = before.trim().split(/\s+/);
      const entry = fields.findLast((field) => field.startsWith('./')) ?? fields[fields.length - 1];
      hardLinks.push({ entry, target });
    }
    return { hardLinks, entries };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * 列出目录里的 Linux 安装包（deb/rpm）。
 */
function listLinuxPackages(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith('.deb') || name.endsWith('.rpm'))
    .map((name) => path.join(directory, name));
}

/**
 * 校验 Linux 安装包里没有硬链接条目。
 */
function verifyLinuxPackageLinks(directory) {
  const packages = listLinuxPackages(directory).filter((file) => file.endsWith('.deb'));
  const findings = [];
  for (const file of packages) {
    const { hardLinks } = inspectDebHardLinks(file);
    for (const link of hardLinks) {
      findings.push({ package: path.basename(file), entry: link.entry, target: link.target });
    }
  }
  if (findings.length) {
    const detail = findings
      .map((item) => `  ${item.package}: ${item.entry}${item.target ? ` → ${item.target}` : ''}`)
      .join('\n');
    throw new Error(`[linux-package] 安装包内含硬链接条目，跨文件系统安装会失败：\n${detail}`);
  }
  return { checked: packages.length };
}

/** 读取一个 ELF 文件依赖的最高 GLIBC 符号版本，例如 2.28。 */
function highestGlibcVersion(file) {
  const result = spawnSync('readelf', ['-V', file], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) return null;
  let highest = null;
  for (const match of result.stdout.matchAll(/GLIBC_(\d+)\.(\d+)/g)) {
    const version = Number(`${match[1]}.${match[2]}`);
    if (highest === null || version > highest) highest = version;
  }
  return highest;
}

/**
 * 检查一个 ELF 文件是否能在给定的 glibc 上限内加载。
 */
function checkGlibcFloor(file, limit) {
  if (!fs.existsSync(file)) return { ok: false, required: null, limit, reason: '文件不存在' };
  const required = highestGlibcVersion(file);
  if (required === null) return { ok: false, required: null, limit, reason: '无法读取 ELF 版本信息' };
  const [limitMajor, limitMinor] = limit.split('.').map(Number);
  const ok = required <= limitMajor + limitMinor / 100;
  return { ok, required, limit, reason: ok ? undefined : `需要 GLIBC_${required}，目标上限 GLIBC_${limit}` };
}

module.exports = {
  HARD_LINKS_ENV,
  HARD_LINKS_DISABLED,
  needsHardLinkPolicy,
  applyHardLinkPolicy,
  readArMembers,
  inspectDebHardLinks,
  listLinuxPackages,
  verifyLinuxPackageLinks,
  highestGlibcVersion,
  checkGlibcFloor,
};
