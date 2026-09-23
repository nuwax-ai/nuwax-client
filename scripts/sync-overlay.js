#!/usr/bin/env node
/**
 * 同步 overlay/（商业自有代码）到基座 submodule 工作树 nuwa-electron-shell/ —— 文件覆写机制。
 *
 * overlay/ 内的目录结构 = 基座仓相对路径（overlay/crates/... → nuwa-electron-shell/crates/...），
 * 同名文件整文件覆写基座版本；overlay/README.md 为机制说明，不参与同步。
 * 已同步文件的清单记在 .overlay-sync.json（gitignore）：overlay 删除文件时联动清理工作树，
 * --clean 可整体还原基座工作树干净态。
 *
 * 用法：
 *   node scripts/sync-overlay.js            # 同步（差异文件才写）
 *   node scripts/sync-overlay.js --check    # 干跑：只报告差异（bump pin 时人工核对用）
 *   node scripts/sync-overlay.js --clean    # 还原：移除/还原所有已同步文件
 *
 * 纯 Node 实现（CI Windows runner 无 rsync）；同内容不重写（mtime 不变，利于增量构建）。
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const overlayDir = path.join(root, "overlay");
const baseDir = path.join(root, "nuwa-electron-shell");
const manifestPath = path.join(root, ".overlay-sync.json");

const dryRun = process.argv.includes("--check") || process.argv.includes("--dry-run");
const clean = process.argv.includes("--clean");

function fail(msg) {
  console.error(`[sync-overlay] ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(baseDir, ".git"))) {
  fail("基座 submodule 不存在，先 git submodule update --init nuwa-electron-shell");
}

/** 递归收集 overlay/ 下所有文件（相对路径），排除根 README.md。 */
function collectFiles(dir, prefix = "") {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (!prefix && name === "README.md") continue;
    const abs = path.join(dir, name);
    if (fs.statSync(abs).isDirectory()) {
      out.push(...collectFiles(abs, rel));
    } else {
      out.push(rel);
    }
  }
  return out.sort();
}

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch {
    return [];
  }
}

function writeManifest(list) {
  fs.writeFileSync(manifestPath, JSON.stringify(list, null, 2) + "\n");
}

function filesEqual(a, b) {
  const fa = fs.readFileSync(a);
  const fb = fs.readFileSync(b);
  return fa.equals(fb);
}

/** 基座内该路径是否为 git 跟踪文件（还原时用 checkout 而非删除）。 */
function isTrackedInBase(rel) {
  const r = spawnSync("git", ["ls-files", "--error-unmatch", rel], {
    cwd: baseDir,
    encoding: "utf-8",
  });
  return r.status === 0;
}

const overlayFiles = collectFiles(overlayDir);
const prevManifest = readManifest();

if (clean) {
  if (prevManifest.length === 0) {
    console.log("[sync-overlay] 清单为空，无事可还原");
    process.exit(0);
  }
  for (const rel of prevManifest) {
    const dest = path.join(baseDir, rel);
    if (!fs.existsSync(dest)) {
      console.log(`  MISS    ${rel}`);
      continue;
    }
    if (isTrackedInBase(rel)) {
      spawnSync("git", ["checkout", "--", rel], { cwd: baseDir, stdio: "inherit" });
      console.log(`  RESTORE ${rel}`);
    } else {
      fs.rmSync(dest);
      console.log(`  REMOVE  ${rel}`);
    }
  }
  writeManifest([]);
  console.log(`[sync-overlay] 已还原 ${prevManifest.length} 个文件`);
  process.exit(0);
}

const nextManifest = [];
const actions = [];
for (const rel of overlayFiles) {
  const src = path.join(overlayDir, rel);
  const dest = path.join(baseDir, rel);
  if (!fs.existsSync(dest)) {
    actions.push(["ADD", rel, () => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }]);
  } else if (!filesEqual(src, dest)) {
    actions.push(["OVERWRITE", rel, () => fs.copyFileSync(src, dest)]);
  } else {
    actions.push(["SAME", rel, null]);
  }
  nextManifest.push(rel);
}

// overlay 里已删除、但上一轮同步过的文件 → 清出工作树
const removed = prevManifest.filter((rel) => !nextManifest.includes(rel));
for (const rel of removed) {
  const dest = path.join(baseDir, rel);
  actions.push(["PRUNE", rel, () => {
    if (isTrackedInBase(rel)) {
      spawnSync("git", ["checkout", "--", rel], { cwd: baseDir, stdio: "inherit" });
    } else if (fs.existsSync(dest)) {
      fs.rmSync(dest);
    }
  }]);
}

let changed = 0;
for (const [kind, rel, apply] of actions) {
  if (kind === "SAME") continue;
  changed++;
  console.log(`  ${dryRun ? "WOULD " : ""}${kind.padEnd(9)} ${rel}`);
  if (!dryRun && apply) apply();
}
if (!dryRun) writeManifest(nextManifest);

const summary = dryRun
  ? `干跑完成：${changed} 个文件待同步（当前一致 ${actions.length - changed} 个）`
  : changed > 0
    ? `同步完成：${changed} 个文件写入基座工作树`
    : "已是同步状态，无变更";
console.log(`[sync-overlay] ${summary}${dryRun ? "（--check）" : ""}`);
if (dryRun && changed > 0) process.exitCode = 1;
