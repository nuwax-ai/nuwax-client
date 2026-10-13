#!/usr/bin/env node
/**
 * 特性模块边界检查（守卫）。
 *
 * 扫描 overlay 源码树 `overlay/crates/agent-electron-client/src`，强制特性之间、特性与
 * 客户端其余代码之间保持独立：
 *
 *   R1 特性文件只能 import：自身特性的文件、`main/features/_kit`、`shared/types/hostBridge`、
 *      第三方包/Node/Electron。不得 import 客户端其余代码或其他特性。
 *   R2 特性之外的代码只能经「公开入口」使用特性：`main/features/index`、`preload/features/index`、
 *      `renderer/features/<id>/index`、`shared/features/<id>/contract`。
 *   R3 `_kit` 不得依赖任何特性或客户端其余代码。
 *   R4 特性内不得出现 `APP_NAME_IDENTIFIER`（产品门控只看特性清单的 `products`）。
 *
 * 用法：node scripts/check-feature-boundaries.mjs [--root <repo root>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const overlaySrc = 'overlay/crates/agent-electron-client/src';

const ALIASES = [
  ['@shared/', 'shared/'],
  ['@main/', 'main/'],
  ['@preload/', 'preload/'],
  ['@renderer/', 'renderer/'],
  ['@/', ''],
];

const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const IMPORT_PATTERNS = [
  /(?:^|[\n;])\s*(?:import|export)\s[^'";]*?from\s*['"]([^'"]+)['"]/g,
  /(?:^|[\n;])\s*import\s*['"]([^'"]+)['"]/g,
  /\b(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const toPosix = (p) => p.split(path.sep).join('/');

/** 把相对 src 的路径分类：feature / kit / registry / other。 */
export function classify(relNoExt) {
  relNoExt = relNoExt.replace(/\.(test|spec)$/, '');
  let m = /^(main|renderer|shared)\/features\/([^/]+)(?:\/|$)/.exec(relNoExt);
  if (!m) m = /^(preload)\/features\/([^/.]+)(?:\/|\.|$)/.exec(relNoExt);
  if (!m) return { kind: 'other' };
  const [, area, id] = m;
  if (id === '_kit') return { kind: 'kit', area, id };
  if (id === 'index') return { kind: 'registry', area, id };
  return { kind: 'feature', area, id };
}

/** 解析 import 说明符：包 → null；内部路径 → 相对 src 的无扩展路径。 */
function resolveSpecifier(spec, fromRel) {
  for (const [alias, target] of ALIASES) {
    if (spec.startsWith(alias)) return stripExt(toPosix(path.posix.normalize(target + spec.slice(alias.length))));
  }
  if (spec.startsWith('.')) {
    return stripExt(toPosix(path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec))));
  }
  return null;
}

function stripExt(p) {
  return p.replace(SOURCE_EXT, '');
}

export function extractImports(source) {
  const found = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) found.add(match[1]);
  }
  return [...found];
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

/** 外部代码允许 import 的特性公开入口。 */
function isPublicEntry(target) {
  const rel = target.rel;
  if (target.kind === 'registry') return /^(main|preload)\/features\/index$/.test(rel);
  if (target.area === 'renderer') return new RegExp(`^renderer/features/${target.id}(/index)?$`).test(rel);
  if (target.area === 'shared') return new RegExp(`^shared/features/${target.id}/contract$`).test(rel);
  return false;
}

export function checkFeatureBoundaries(root = defaultRoot) {
  const src = path.join(root, overlaySrc);
  const violations = [];
  const add = (file, rule, message) => violations.push({ file, rule, message });

  for (const file of walk(src)) {
    const rel = toPosix(path.relative(src, file));
    const relNoExt = stripExt(rel);
    const here = classify(relNoExt);
    const text = fs.readFileSync(file, 'utf8');
    const isTest = /\.test\.[tj]sx?$/.test(rel);

    if (here.kind === 'feature' && !isTest && /\bAPP_NAME_IDENTIFIER\b/.test(text)) {
      add(rel, 'R4', '特性内不得出现 APP_NAME_IDENTIFIER，产品门控只看特性清单的 products');
    }

    for (const spec of extractImports(text)) {
      const resolved = resolveSpecifier(spec, relNoExt);
      if (resolved === null) continue; // 第三方包 / Node / Electron
      const target = { ...classify(resolved), rel: resolved };

      if (here.kind === 'feature') {
        const ownFeature = target.kind === 'feature' && target.id === here.id;
        const kit = target.kind === 'kit' && target.area === 'main';
        const hostContract = resolved === 'shared/types/hostBridge';
        if (!ownFeature && !kit && !hostContract) {
          add(rel, 'R1', `特性 ${here.id} 不得 import「${spec}」（只能引用自身、_kit、shared/types/hostBridge 与第三方包）`);
        }
      } else if (here.kind === 'kit') {
        if (!(target.kind === 'kit')) {
          add(rel, 'R3', `_kit 不得 import「${spec}」（只能引用 _kit 自身与第三方包）`);
        }
      } else if (target.kind === 'feature' || target.kind === 'registry') {
        // 注册表本身允许引用各特性的入口
        const fromRegistry = here.kind === 'registry' && target.kind === 'feature';
        if (!fromRegistry && !isPublicEntry(target)) {
          add(rel, 'R2', `「${spec}」是特性内部实现，外部只能经公开入口使用特性`);
        }
      } else if (target.kind === 'kit') {
        // 特性之外使用 _kit：仅注册表所在位置需要
        if (here.kind !== 'registry') {
          add(rel, 'R2', `「${spec}」是特性套件内部实现，外部只能经 features/index 使用`);
        }
      }
    }
  }
  return violations;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let root = defaultRoot;
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--root' && process.argv[i + 1]) root = path.resolve(process.argv[++i]);
    else {
      console.error(`Unknown argument: ${process.argv[i]}`);
      process.exit(1);
    }
  }
  const violations = checkFeatureBoundaries(root);
  for (const v of violations) console.error(`[feature-boundaries] ${v.rule} ${v.file}: ${v.message}`);
  if (violations.length) process.exit(1);
  console.log('[feature-boundaries] OK');
}
