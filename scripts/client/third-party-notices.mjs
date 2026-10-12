/**
 * 开源组件声明：清单生成与体检（纯函数 + 少量文件系统读取，均可注入）。
 *
 * 原则：许可证由工具从文件/包元数据读取，**不凭记忆手写**。读不出来的组件会被标成问题，
 * 严格模式（pack / 发版）下问题即失败，保证没核实过的条目不会进安装包。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const SCHEMA_VERSION = 1;

const LICENSE_FILE = /^(licen[sc]e|copying|unlicen[sc]e|notice)([-_.].*)?$/i;

/** 从许可证全文识别 SPDX 标识；识别不了返回 null（宁可不认，也不猜）。 */
export function detectLicense(text) {
  if (!text) return null;
  if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(text)) return 'AGPL-3.0';
  if (/GNU LESSER GENERAL PUBLIC LICENSE/i.test(text)) {
    if (/Version 3/i.test(text)) return 'LGPL-3.0';
    if (/Version 2\.1/i.test(text)) return 'LGPL-2.1';
    return null;
  }
  if (/GNU GENERAL PUBLIC LICENSE/i.test(text)) {
    if (/Version 3/i.test(text)) return 'GPL-3.0';
    if (/Version 2/i.test(text)) return 'GPL-2.0';
    return null;
  }
  if (/Mozilla Public License,?\s+(Version|v\.?)\s*2\.0/i.test(text)) return 'MPL-2.0';
  if (/Apache License[\s\S]{0,60}Version 2\.0/i.test(text)) return 'Apache-2.0';
  if (/Permission is hereby granted, free of charge, to any person obtaining a copy/i.test(text)) return 'MIT';
  if (/Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee/i.test(text)) return 'ISC';
  if (/Redistribution and use in source and binary forms/i.test(text)) {
    return /Neither the name of/i.test(text) ? 'BSD-3-Clause' : 'BSD-2-Clause';
  }
  if (/This is free and unencumbered software released into the public domain/i.test(text)) return 'Unlicense';
  return null;
}

/** package.json 的 license 字段（字符串 / {type} / 旧式 licenses 数组）→ 字符串。 */
export function normalizeLicenseField(pkg) {
  if (!pkg) return null;
  if (typeof pkg.license === 'string' && pkg.license.trim()) return pkg.license.trim();
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type.trim();
  if (Array.isArray(pkg.licenses) && pkg.licenses.length) {
    const types = pkg.licenses.map((l) => (typeof l === 'string' ? l : l?.type)).filter(Boolean);
    if (types.length) return types.join(' OR ');
  }
  return null;
}

const PERMISSIVE = /^(MIT|MIT-0|ISC|BSD-[23]-Clause|0BSD|Apache-2\.0|Unlicense|CC0-1\.0|BlueOak-1\.0\.0|Zlib|Python-2\.0|CC-BY-[34]\.0|WTFPL)$/i;
const WEAK = /^(LGPL-[\d.]+(-only|-or-later)?|MPL-[\d.]+|EPL-[\d.]+|CDDL-[\d.]+)$/i;
const STRONG = /^(A?GPL-[\d.]+(-only|-or-later)?)$/i;

/** 许可证表达式分类：OR 里任一备选是宽松许可即视为宽松。AND/WITH 取最严的一项。 */
export function classifyLicense(expression) {
  if (!expression) return 'unknown';
  const expr = expression.replace(/[()]/g, ' ').trim();
  const rank = { permissive: 0, 'weak-copyleft': 1, 'strong-copyleft': 2, unknown: 3 };
  const classifyOne = (id) => {
    const clean = id.trim().replace(/\+$/, '-or-later');
    if (PERMISSIVE.test(clean)) return 'permissive';
    if (WEAK.test(clean)) return 'weak-copyleft';
    if (STRONG.test(clean)) return 'strong-copyleft';
    return 'unknown';
  };
  const alternatives = expr.split(/\s+OR\s+/i).map((alt) => {
    // `X WITH 某例外` 的例外条款不改变 X 的类别；AND 取最严的一项
    const parts = alt.split(/\s+AND\s+/i).map((p) => p.replace(/\s+WITH\s+.*$/i, '')).filter(Boolean);
    return parts.map(classifyOne).reduce((worst, c) => (rank[c] > rank[worst] ? c : worst), 'permissive');
  });
  return alternatives.reduce((best, c) => (rank[c] < rank[best] ? c : best), 'unknown');
}

export function findLicenseFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && LICENSE_FILE.test(e.name))
    .map((e) => path.join(dir, e.name))
    .sort();
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/**
 * 按 Node 的查找规则向上找 `node_modules/<name>/package.json`。
 * 不用 require.resolve：带 exports 映射、且没导出 package.json 的包会解析失败而被漏掉。
 */
function findPackageDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    if (path.basename(dir) !== 'node_modules') {
      const candidate = path.join(dir, 'node_modules', name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * 从若干起点包目录出发，沿 dependencies（可选 devDependencies）求依赖闭包。
 * 每个包用 realpath 作为下一跳的起点，兼容 pnpm 的符号链接布局；未安装的可选依赖跳过。
 */
export function collectNpmClosure(startDirs, { includeDev = false, extraNames = [] } = {}) {
  const found = new Map();
  const queue = [];

  const enqueueDeps = (pkgDir, pkg, withDev) => {
    const names = {
      ...(pkg.dependencies || {}),
      ...(pkg.optionalDependencies || {}),
      ...(withDev ? pkg.devDependencies || {} : {}),
    };
    for (const name of Object.keys(names)) queue.push({ name, from: pkgDir });
  };

  for (const dir of startDirs) {
    const pkgFile = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgFile)) continue;
    const pkg = readJson(pkgFile);
    const real = fs.realpathSync(dir);
    enqueueDeps(real, pkg, includeDev);
    for (const name of extraNames) queue.push({ name, from: real });
  }

  while (queue.length) {
    const { name, from } = queue.shift();
    const located = findPackageDir(name, from);
    if (!located) continue; // 未安装的可选依赖 / 仅类型包等
    const dir = fs.realpathSync(located);
    let pkg;
    try {
      pkg = readJson(path.join(dir, 'package.json'));
    } catch {
      continue;
    }
    if (!pkg.name || !pkg.version) continue;
    const key = `${pkg.name}@${pkg.version}`;
    if (found.has(key)) continue;
    found.set(key, {
      id: key,
      name: pkg.name,
      version: pkg.version,
      kind: 'npm',
      dir,
      licenseField: normalizeLicenseField(pkg),
      homepage: pkg.homepage || (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url) || null,
    });
    enqueueDeps(dir, pkg, false);
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** 解析 `ffmpeg -version` 输出里的 configuration 行。 */
export function parseFfmpegConfiguration(versionOutput) {
  const m = /^configuration:\s*(.*)$/im.exec(versionOutput || '');
  return m ? m[1].trim() : null;
}

/** ffmpeg 体检：必须是可再分发的 LGPL 构建。返回问题列表。 */
export function inspectFfmpegConfiguration(configuration) {
  if (configuration === null || configuration === undefined) {
    return [{ code: 'FFMPEG_CONFIG_UNREADABLE', message: '读不到 ffmpeg 的 configuration 行，无法确认是 LGPL 构建' }];
  }
  const problems = [];
  if (/--enable-gpl\b/.test(configuration)) {
    problems.push({ code: 'FFMPEG_GPL', message: 'ffmpeg 以 --enable-gpl 构建，整包将受 GPL 约束，不得随包分发' });
  }
  if (/--enable-nonfree\b/.test(configuration)) {
    problems.push({ code: 'FFMPEG_NONFREE', message: 'ffmpeg 以 --enable-nonfree 构建，不可再分发' });
  }
  return problems;
}

/**
 * 汇总组件并体检。
 *
 * @param {object} args
 * @param {string} args.root 仓库根（用于解析清单里的相对路径）
 * @param {object} args.manifest third-party/manifest.json 的内容
 * @param {string|null} args.resourcesDir 随包 resources 目录（不存在则跳过资源体检）
 * @param {Array} args.npmComponents collectNpmClosure 的结果
 * @param {(binary:string)=>string|null} [args.readFfmpegVersion] 注入：返回 `ffmpeg -version` 输出
 */
export function buildNotices({ root, manifest, resourcesDir, resourcePaths, npmComponents, readFfmpegVersion }) {
  const components = [];
  const problems = [];
  const allow = new Map(
    (manifest.allow || [])
      .filter((a) => a && typeof a.reason === 'string' && a.reason.trim())
      .map((a) => [a.id, a.reason]),
  );
  const problem = (code, id, message) => problems.push({ code, id, message });

  // npm 组件
  for (const c of npmComponents) {
    let license = c.licenseField;
    let licenseFile = null;
    const files = findLicenseFiles(c.dir);
    if (files.length) licenseFile = files[0];
    if (!license && licenseFile) license = detectLicense(fs.readFileSync(licenseFile, 'utf8'));
    components.push({
      id: c.id,
      name: c.name,
      version: c.version,
      kind: 'npm',
      usedBy: 'core',
      license: license || null,
      homepage: c.homepage,
      sourceUrl: c.homepage,
      modified: false,
      licenseSourceFile: licenseFile,
    });
  }

  // 随包资源（二进制/预编译包）：必须在清单里登记
  const declared = manifest.resources || {};
  const onDisk = resourcePaths ? Object.keys(resourcePaths) : resourcesDir && fs.existsSync(resourcesDir)
    ? fs.readdirSync(resourcesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : [];
  for (const dirName of onDisk) {
    if (!declared[dirName]) {
      problem('UNDECLARED_RESOURCE', dirName, `resources/${dirName} 随包但未在 third-party/manifest.json 的 resources 里登记`);
    }
  }
  const entries = Object.entries(declared).flatMap(([dirName, entry]) => [
    [dirName, entry], ...(entry.components ?? []).map((component) => [dirName, component]),
  ]);
  for (const [dirName, entry] of entries) {
    const dir = resourcePaths ? resourcePaths[dirName] ?? null : resourcesDir ? path.join(resourcesDir, dirName) : null;
    let version = entry.version ?? null;
    let license = entry.license ?? null;
    let licenseFile = entry.licenseFile ? path.join(root, entry.licenseFile) : null;
    if (dir && fs.existsSync(dir)) {
      const pkgFile = path.join(dir, 'package.json');
      if (fs.existsSync(pkgFile)) {
        const pkg = readJson(pkgFile);
        if (!version || version === 'auto') version = pkg.version ?? null;
        if (!license) license = normalizeLicenseField(pkg);
      }
      const files = findLicenseFiles(dir);
      if (!licenseFile && files.length) licenseFile = files[0];
    }
    if (!license && licenseFile && fs.existsSync(licenseFile)) {
      license = detectLicense(fs.readFileSync(licenseFile, 'utf8'));
    }
    components.push({
      id: entry.id || dirName,
      name: entry.name || dirName,
      version: version && version !== 'auto' ? version : null,
      kind: 'binary',
      usedBy: entry.usedBy || 'core',
      license,
      homepage: entry.homepage || null,
      sourceUrl: entry.sourceUrl || null,
      modified: entry.modified === true,
      licenseSourceFile: licenseFile && fs.existsSync(licenseFile) ? licenseFile : null,
      sourceArchive: entry.sourceArchive || null,
      sourceSourceFile: entry.sourceFile ? path.join(root, entry.sourceFile) : null,
      sourceSha256: entry.sourceSha256 || null,
      notes: entry.notes || null,
    });

    if (entry.sourceFile || entry.usedBy === 'capture') {
      if (!entry.sourceFile) {
        problem('SOURCE_INTEGRITY', entry.id || dirName, `${entry.id || dirName} 没有锁定源码归档`);
      } else {
      const source = path.join(root, entry.sourceFile);
      if (!/^[a-f0-9]{64}$/.test(entry.sourceSha256 ?? '') || !fs.existsSync(source) || fileSha256(source) !== entry.sourceSha256) {
        problem('SOURCE_INTEGRITY', entry.id || dirName, `${entry.id || dirName} 源码归档缺失或 SHA256 未核验`);
      }
      }
    }
    if ((entry.checkIntegrity || entry.usedBy === 'capture') && (!licenseFile || !fs.existsSync(licenseFile))) {
      problem('MISSING_LICENSE_TEXT', entry.id || dirName, `${entry.id || dirName} 缺少可分发的许可证全文`);
    }

    if (entry.check === 'ffmpeg' && dir && fs.existsSync(dir)) {
      const binary = findFfmpegBinary(dir);
      if (!binary) {
        problem('FFMPEG_BINARY_MISSING', entry.id || dirName, `resources/${dirName} 里找不到 ffmpeg 可执行文件`);
      } else if (readFfmpegVersion) {
        const configuration = parseFfmpegConfiguration(readFfmpegVersion(binary));
        for (const p of inspectFfmpegConfiguration(configuration)) {
          problem(p.code, entry.id || dirName, p.message);
        }
        if (entry.checkIntegrity) {
          let record;
          try { record = readJson(path.join(path.dirname(binary), 'resource.json')); } catch { record = null; }
          if (record?.schema !== 1 || !/^[a-f0-9]{64}$/.test(record.sha256 ?? '') || fileSha256(binary) !== record.sha256 || record.configuration !== configuration || record.version !== entry.version) {
            problem('FFMPEG_INTEGRITY', entry.id || dirName, 'ffmpeg 未通过构建记录、版本与 SHA256 核验');
          }
        }
      } else {
        problem('FFMPEG_CONFIG_UNREADABLE', entry.id || dirName, '未执行 ffmpeg configuration 核验');
      }
    } else if (entry.check === 'ffmpeg') {
      problem('FFMPEG_BINARY_MISSING', entry.id || dirName, '找不到随包 ffmpeg 目录');
    }
  }

  // 体检
  for (const c of components) {
    const waived = allow.has(c.id) || allow.has(c.name);
    if (!c.license) {
      problem('UNKNOWN_LICENSE', c.id, `${c.id} 读不到许可证`);
    } else {
      const cls = classifyLicense(c.license);
      if (cls === 'unknown' && !waived) problem('UNKNOWN_LICENSE', c.id, `${c.id} 的许可证「${c.license}」无法归类`);
      if (cls === 'strong-copyleft' && !waived) problem('COPYLEFT', c.id, `${c.id} 使用强 copyleft 许可证「${c.license}」，需带理由登记到 allow`);
    }
    if (c.kind === 'binary' && !c.sourceUrl) {
      problem('MISSING_SOURCE_URL', c.id, `${c.id} 缺少源代码地址（sourceUrl）`);
    }
  }

  components.sort((a, b) => a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version)));
  return { components, problems };
}

const fileSha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function findFfmpegBinary(dir) {
  const names = new Set(['ffmpeg', 'ffmpeg.exe']);
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (names.has(e.name)) return full;
    }
  }
  return null;
}

/** 写出 third-party-notices.json 与 licenses/ 全文。返回写出的清单。 */
export function writeNotices({ components }, outDir) {
  fs.mkdirSync(path.join(outDir, 'licenses'), { recursive: true });
  const published = components.map((c) => {
    let licenseText = null;
    if (c.licenseSourceFile) {
      const safeId = c.id.replace(/[^A-Za-z0-9._-]+/g, '_');
      licenseText = `licenses/${safeId}.txt`;
      fs.copyFileSync(c.licenseSourceFile, path.join(outDir, licenseText));
    }
    if (c.sourceSourceFile && fs.existsSync(c.sourceSourceFile) && c.sourceArchive) {
      const target = path.join(outDir, c.sourceArchive);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(c.sourceSourceFile, target);
    }
    const { licenseSourceFile, sourceSourceFile, ...rest } = c;
    return { ...rest, licenseText };
  });
  const document = { schema: SCHEMA_VERSION, components: published };
  fs.writeFileSync(path.join(outDir, 'third-party-notices.json'), `${JSON.stringify(document, null, 2)}\n`);
  return document;
}

/** Audit the actual builder payload, excluding resources that its filters omit. */
export function shippedResourcePaths(builder, clientDir, platform) {
  const result = {};
  const entries = [...(builder.extraResources ?? []), ...(platform === 'win32' ? builder.win?.extraResources ?? [] : [])];
  for (const entry of entries) {
    const from = typeof entry === 'string' ? entry : entry?.from;
    if (typeof from !== 'string') continue;
    const resolved = path.resolve(clientDir, from);
    const match = /(?:^|[/\\])resources[/\\]([^/\\]+)/.exec(resolved);
    if (!match) continue;
    const name = match[1];
    const resourceRoot = resolved.slice(0, match.index + match[0].length);
    // capture selects just the target binary, rather than probing other-platform executables.
    result[name] = name === 'capture' ? resolved : resourceRoot;
  }
  return result;
}

export function generateThirdPartyNotices(root, { outDir = path.join(root, 'third-party/generated'), resourcesDir = path.join(root, 'nuwa-electron-shell/crates/agent-electron-client/resources'), resourcePaths, strict = false, captureOnly = false, platform = process.platform, arch = process.arch, readFfmpegVersion } = {}) {
  const manifest = readJson(path.join(root, 'third-party/manifest.json'));
  let paths = resourcePaths;
  let selected = manifest;
  if (captureOnly) {
    paths = { capture: path.join(root, 'resources/capture', `${platform}-${arch}`) };
    selected = { ...manifest, resources: { capture: manifest.resources.capture } };
  } else if (paths) {
    selected = { ...manifest, resources: Object.fromEntries(Object.entries(manifest.resources ?? {}).filter(([name]) => Object.hasOwn(paths, name))) };
  } else if (fs.existsSync(path.join(root, 'resources/capture', `${platform}-${arch}`))) {
    paths = Object.fromEntries(fs.existsSync(resourcesDir) ? fs.readdirSync(resourcesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => [entry.name, path.join(resourcesDir, entry.name)]) : []);
    paths.capture = path.join(root, 'resources/capture', `${platform}-${arch}`);
  }
  const npmComponents = captureOnly ? [] : collectNpmClosure((manifest.npmRoots ?? ['.']).map((relative) => path.resolve(root, relative)), { extraNames: manifest.npmExtra ?? [] });
  const probe = readFfmpegVersion ?? ((binary) => {
    const run = spawnSync(binary, ['-version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    return run.status === 0 ? run.stdout : null;
  });
  const result = buildNotices({ root, manifest: selected, resourcesDir, resourcePaths: paths, npmComponents, readFfmpegVersion: probe });
  if (strict && result.problems.length) throw new Error(`[third-party] 严格模式拒绝入包 (${result.problems.length}): ${result.problems.map((p) => `${p.code}:${p.id}`).join(', ')}`);
  const document = writeNotices(result, outDir);
  return { ...result, document, outDir };
}
