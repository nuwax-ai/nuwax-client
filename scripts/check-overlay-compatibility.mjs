#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run } from './client/core.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reviewFile = 'overlay-base-reviews.json';

function overlayFiles(directory, prefix = '') {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).flatMap(name => {
    if (!prefix && name === 'README.md') return [];
    const relative = prefix ? `${prefix}/${name}` : name;
    const absolute = path.join(directory, name);
    const stat = fs.lstatSync(absolute);
    if (stat.isDirectory()) return overlayFiles(absolute, relative);
    if (stat.isFile() || stat.isSymbolicLink() && fs.statSync(absolute).isFile()) return [relative];
    throw new Error(`不支持的 overlay 文件类型: ${JSON.stringify(relative)}`);
  }).sort();
}

function readReviews(root) {
  const file = path.join(root, reviewFile);
  if (!fs.existsSync(file)) return [];
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value?.schemaVersion !== 1 || !Array.isArray(value.reviews)) throw new Error(`${reviewFile} 必须使用 schemaVersion: 1 和 reviews 数组`);
  for (const review of value.reviews) {
    if (!review || typeof review.path !== 'string' || !review.path || review.path.startsWith('/') || review.path.split('/').some(part => ['.', '..', ''].includes(part)) ||
        !(review.baseBlob === null && review.baseMode === null || typeof review.baseBlob === 'string' && /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(review.baseBlob) && /^(100644|100755|120000|160000|040000)$/.test(review.baseMode)) ||
        typeof review.overlaySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(review.overlaySha256) || typeof review.note !== 'string' || !review.note.trim()) {
      throw new Error(`${reviewFile} 存在无效审查记录；需要 path、baseBlob、baseMode、overlaySha256 和人工审查 note`);
    }
  }
  return value.reviews;
}

function treeEntries(output) {
  const entries = new Map();
  for (const record of output.split('\0').filter(Boolean)) {
    const separator = record.indexOf('\t');
    const [mode, , blob] = record.slice(0, separator).split(' ');
    if (separator < 0 || !mode || !blob) throw new Error('无法解析基座 git ls-tree 输出');
    entries.set(record.slice(separator + 1), { blob, mode });
  }
  return entries;
}

/** Read-only comparison of two base commits against the current commercial overlay. */
export async function checkOverlayCompatibility(root, { from, to = 'HEAD' } = {}, dependencies = {}) {
  const execute = dependencies.run ?? run;
  const base = path.join(root, 'nuwa-electron-shell');
  const git = async args => {
    const result = await execute('git', args, { cwd: base, capture: true, env: { GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' } });
    if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed (${result.status})`);
    return result.stdout;
  };
  const resolve = async ref => {
    if (typeof ref !== 'string' || !ref || ref.startsWith('-') || /[\x00-\x20]/.test(ref)) throw new Error(`无效基座引用: ${JSON.stringify(ref)}`);
    return (await git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim();
  };
  const oldSha = await resolve(from), newSha = await resolve(to);
  const files = overlayFiles(path.join(root, 'overlay'));
  const reviews = readReviews(root);
  const oldTree = treeEntries(await git(['ls-tree', '-r', '-t', '-z', '--full-tree', oldSha]));
  const newTree = treeEntries(await git(['ls-tree', '-r', '-t', '-z', '--full-tree', newSha]));
  const changes = [];
  // Compare each path independently: rename deletions/additions need review on both
  // overlay endpoints, without similarity detection that would hydrate partial-clone blobs.
  for (const relative of files) {
    const oldBase = oldTree.get(relative) ?? null, newBase = newTree.get(relative) ?? null;
    const segments = relative.split('/');
    const blockedBy = newBase && !['100644', '100755'].includes(newBase.mode)
      ? relative
      : segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'))
        .find(ancestor => newTree.has(ancestor) && newTree.get(ancestor).mode !== '040000');
    if (!blockedBy && oldBase?.blob === newBase?.blob && oldBase?.mode === newBase?.mode) continue;
    const overlaySha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'overlay', relative))).digest('hex');
    const candidates = reviews.filter(review => review.path === relative);
    const reviewed = !blockedBy && candidates.some(review => review.baseBlob === (newBase?.blob ?? null) && review.baseMode === (newBase?.mode ?? null) && review.overlaySha256 === overlaySha256);
    changes.push({
      path: relative,
      kind: blockedBy === relative ? 'path-collision' : blockedBy ? 'ancestor-collision' : !oldBase ? 'new-collision' : !newBase ? 'deleted' : oldBase.blob === newBase.blob ? 'mode-changed' : 'modified',
      oldBase, newBase, overlaySha256,
      ...(blockedBy ? { blockedBy, blockingBase: newTree.get(blockedBy) } : {}),
      review: blockedBy ? 'blocked' : reviewed ? 'reviewed' : candidates.length ? 'stale' : 'missing',
    });
  }
  const unreviewed = changes.filter(change => change.review !== 'reviewed').length;
  return { schemaVersion: 1, from: oldSha, to: newSha, overlayFiles: files.length, changes, unreviewed, ok: unreviewed === 0 };
}

export async function assertOverlayCompatibility(root, options, dependencies = {}) {
  const report = await checkOverlayCompatibility(root, options, dependencies);
  if (!report.ok) {
    const paths = report.changes.filter(change => change.review !== 'reviewed').map(change => JSON.stringify(change.path)).join(', ');
    const instruction = report.changes.some(change => change.review === 'blocked')
      ? '存在基座路径结构冲突；先迁移/移除对应 overlay 路径或修正基座文件/目录结构，审查记录不能放行此冲突'
      : `先对照新基座合入商业实现，再更新 ${reviewFile}`;
    throw new Error(`overlay 基座兼容审查未通过 (${report.unreviewed}): ${paths}。${instruction}；可运行 node scripts/check-overlay-compatibility.mjs --from ${report.from} --to ${report.to} --json 查看绑定值`);
  }
  return report;
}

async function main(argv) {
  const options = { root: defaultRoot, to: 'HEAD', json: false };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === '--json') options.json = true;
    else if (argument === '--help') {
      console.log('Usage: node scripts/check-overlay-compatibility.mjs --from BASE_REF [--to BASE_REF] [--root CLIENT_ROOT] [--json]');
      return;
    } else if (['--from', '--to', '--root'].includes(argument) && argv[i + 1] && !argv[i + 1].startsWith('--')) options[argument.slice(2)] = argv[++i];
    else throw new Error(`未知参数或缺少值: ${argument}`);
  }
  const report = await checkOverlayCompatibility(path.resolve(options.root), options);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`[overlay:compat] ${report.from.slice(0, 9)} → ${report.to.slice(0, 9)}: ${report.changes.length} 个重叠变化，${report.unreviewed} 个未通过兼容审查`);
    for (const change of report.changes) console.log(`  ${change.review} ${change.kind} ${JSON.stringify(change.path)}`);
    if (report.changes.some(change => change.review === 'blocked')) console.log('[overlay:compat] 基座文件/祖先路径与 overlay 存在结构冲突；先迁移/移除 overlay 路径或修正基座结构，审查记录不能放行。');
    else if (!report.ok) console.log(`[overlay:compat] 人工核对并合入后，在 ${reviewFile} 记录目标基座对象/模式、当前 overlay SHA-256 和审查说明；--json 可查看绑定值。`);
  }
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    if (process.argv.includes('--json')) console.log(JSON.stringify({ ok: false, error: error.message }));
    else console.error(`[overlay:compat] ${error.message}`);
    process.exitCode = 2;
  });
}
