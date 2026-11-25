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

/**
 * deb 依赖的核对。
 *
 * 客户端内升级 deb 时要弹管理员密码框，用的是 zenity（见 src/main/services/linuxDebInstaller.ts）；
 * 统信 UOS 这类系统默认不带它，所以让安装包自己依赖 zenity，装客户端时一并装上。
 *
 * electron-builder 25 只要配置了 deb.depends，就不再带它自己的默认依赖（fpm 只收到 -d <配置项>，
 * libgtk-3-0 等会全部消失），所以 package.json 里写的是"electron-builder 默认依赖 + zenity"的完整列表。
 * 这里以那份配置为准，打包后读控制文件逐项核对。
 */

/** crate 的 package.json；build.deb.depends 以它为唯一出处，CI 与本地打包读的也是它。 */
const PACKAGE_FILE = path.join(__dirname, '..', '..', 'package.json');

/** package.json 里为 deb 配置的依赖列表。 */
function configuredDebDepends(packageFile = PACKAGE_FILE) {
  const depends = JSON.parse(fs.readFileSync(packageFile, 'utf8')).build?.deb?.depends;
  if (!Array.isArray(depends) || depends.length === 0) throw new Error(`${packageFile} 没有配置 build.deb.depends`);
  return depends;
}

/** 解析 Debian 控制文件：字段名 → 值；以空白开头的续行并回上一个字段。 */
function parseControl(text) {
  const fields = {};
  let current = null;
  for (const line of String(text).split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9-]*):[ ]?(.*)$/.exec(line);
    if (match) {
      current = match[1];
      fields[current] = match[2].trim();
    } else if (current && /^[ \t]/.test(line)) {
      fields[current] = `${fields[current]} ${line.trim()}`.trim();
    }
  }
  return fields;
}

/** Depends 字段里的包名：去掉版本约束，多选一（a | b）只取第一个。 */
function dependencyNames(depends) {
  return String(depends ?? '')
    .split(',')
    .map((item) => item.split('|')[0].trim().replace(/\s*\([^)]*\)$/, ''))
    .filter(Boolean);
}

/** 读取 deb 控制文件里的字段。 */
function readDebControl(debFile) {
  const buffer = fs.readFileSync(debFile);
  const control = readArMembers(debFile).find((member) => /^control\.tar/.test(member.name));
  if (!control) throw new Error(`${debFile} 里没有控制归档`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-deb-control-'));
  const archive = path.join(work, control.name);
  try {
    fs.writeFileSync(archive, buffer.subarray(control.offset, control.offset + control.size));
    // tar 自己能识别 xz/gzip 压缩；成员固定叫 ./control，直接输出到 stdout。
    const result = spawnSync('tar', ['-xOf', archive, './control'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (result.error || result.status !== 0) {
      throw new Error(`无法读取 ${debFile} 的控制文件：${result.error?.message ?? result.stderr}`);
    }
    return parseControl(result.stdout);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * 校验目录里每个 deb 都声明了全部应有的依赖。
 * @param {string} expectedPackageFile 取 build.deb.depends 的 package.json
 * @returns {{checked: number, dependencies: string[]}}
 */
function verifyLinuxPackageDependencies(directory, expectedPackageFile = PACKAGE_FILE) {
  const expected = configuredDebDepends(expectedPackageFile);
  const packages = listLinuxPackages(directory).filter((file) => file.endsWith('.deb'));
  const missing = [];
  for (const file of packages) {
    const declared = dependencyNames(readDebControl(file).Depends);
    for (const name of expected) {
      if (!declared.includes(name)) missing.push(`${path.basename(file)}: ${name}`);
    }
  }
  if (missing.length) {
    throw new Error(`[linux-package] 安装包缺少依赖，装到目标系统后客户端内升级无法使用：\n${missing.map((item) => `  ${item}`).join('\n')}`);
  }
  return { checked: packages.length, dependencies: expected };
}

/**
 * 解析 "主.次" 形式的 glibc 版本。glibc 的版本号是两段整数，不能当小数比较：
 * 2.9 和 2.10 当小数是 2.9 > 2.1，而实际 2.9 < 2.10。
 * @returns {{major: number, minor: number}|null}
 */
function parseGlibcVersion(text) {
  const match = /^(\d+)\.(\d+)$/.exec(String(text ?? '').trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function compareGlibcVersions(a, b) {
  return a.major !== b.major ? a.major - b.major : a.minor - b.minor;
}

function formatGlibcVersion(version) {
  return version ? `${version.major}.${version.minor}` : null;
}

/**
 * 读取一个 ELF 文件需要的最高 GLIBC 符号版本。
 * @returns {{major: number, minor: number}|null} 非 ELF 或读取失败时返回 null
 */
function highestGlibcVersion(file) {
  // readelf 对非 ELF 文件退出码非 0；对没有版本信息的 ELF 退出 0 但输出里没有 GLIBC_。
  const result = spawnSync('readelf', ['-V', file], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) return null;
  let highest = null;
  for (const match of result.stdout.matchAll(/GLIBC_(\d+)\.(\d+)/g)) {
    const version = { major: Number(match[1]), minor: Number(match[2]) };
    if (highest === null || compareGlibcVersions(version, highest) > 0) highest = version;
  }
  return highest;
}

/**
 * 检查一个 ELF 文件是否能在给定的 glibc 版本上加载。
 * 没有 GLIBC 版本引用的 ELF（例如纯静态链接）视为满足任意上限。
 */
function checkGlibcFloor(file, limit) {
  const floor = parseGlibcVersion(limit);
  if (!floor) return { ok: false, required: null, limit, reason: `glibc 上限格式无效：${limit}` };
  if (!fs.existsSync(file)) return { ok: false, required: null, limit, reason: '文件不存在' };
  const required = highestGlibcVersion(file);
  if (required === null) return { ok: false, required: null, limit, reason: '无法读取 ELF 版本信息' };
  const ok = compareGlibcVersions(required, floor) <= 0;
  return { ok, required: formatGlibcVersion(required), limit, reason: ok ? undefined : `需要 GLIBC_${formatGlibcVersion(required)}，目标上限 GLIBC_${limit}` };
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
  configuredDebDepends,
  parseControl,
  dependencyNames,
  readDebControl,
  verifyLinuxPackageDependencies,
  parseGlibcVersion,
  compareGlibcVersions,
  highestGlibcVersion,
  checkGlibcFloor,
};
