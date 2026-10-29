#!/usr/bin/env node
/**
 * 生成「开源组件声明」：third-party-notices.json + licenses/ 全文。
 *
 * 用法：
 *   node scripts/generate-third-party-notices.mjs [--out <dir>] [--resources <dir>] [--strict]
 *
 * - 默认输出到 third-party/generated/（pack 前置步骤会再把它放进 extraResources）；
 * - 非严格模式：问题只打印为警告（开发期不阻塞）；
 * - 严格模式（pack / 发版必须开）：任何问题都返回非零，未核实的条目进不了安装包。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shippedResourcePaths } from './client/third-party-notices.mjs';
import { generateThirdPartyNotices } from './client/source-notices.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? path.resolve(args[i + 1]) : fallback;
};

const manifestFile = path.join(root, 'third-party/manifest.json');
if (!fs.existsSync(manifestFile)) {
  console.error(`[third-party] 缺少 ${path.relative(root, manifestFile)}`);
  process.exit(1);
}
const strict = flag('--strict');
const outDir = option('--out', path.join(root, 'third-party/generated'));
const resourcesDir = option('--resources', path.join(root, 'nuwa-electron-shell/crates/agent-electron-client/resources'));

const builderFile = option('--builder-config', null);
const value = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const platform = value('--platform', process.platform);
try {
  const resourcePaths = builderFile ? shippedResourcePaths(JSON.parse(fs.readFileSync(builderFile, 'utf8')), path.join(root, 'nuwa-electron-shell/crates/agent-electron-client'), platform) : undefined;
  const result = generateThirdPartyNotices(root, { outDir, resourcesDir, resourcePaths, strict, captureOnly: flag('--capture-only'), platform, arch: value('--arch', process.arch) });
  console.log(`[third-party] ${result.document.components.length} 个组件 → ${path.relative(root, outDir)}${flag('--capture-only') ? '（仅 capture，不代表完整安装包）' : ''}`);
  for (const problem of result.problems) console.error(`[third-party] WARN ${problem.code} ${problem.id}: ${problem.message}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
