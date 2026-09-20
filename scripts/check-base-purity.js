#!/usr/bin/env node
/**
 * 基座纯净守卫：防商业（overlay）代码泄回中立基座仓。
 *
 * 三种模式：
 *   node scripts/check-base-purity.js                 # worktree：基座工作树脏文件必须 ⊆ overlay 托管集
 *   node scripts/check-base-purity.js --staged        # staged：基座已暂存文件不得含 overlay 托管路径
 *   node scripts/check-base-purity.js --remote <ref>  # remote：基座 <ref> 上 overlay 托管路径的 blob
 *                                                     #   与 overlay 源完全相等 = 商业版本被提交进了基座 → 违规
 *                                                     #   （中立版与商业覆写版按约定永不字节相等；不相等才是正常）
 *
 * overlay 托管集按 overlay/ 目录实时扫描（与 sync-overlay.js 同规则，排除根 README.md），
 * 不依赖本地 .overlay-sync.json。提交基座的标准流程见 README「三仓分支模型」。
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const staged = args.includes("--staged");
const remoteIdx = args.indexOf("--remote");
const remoteRef = remoteIdx >= 0 ? args[remoteIdx + 1] : null;
const rootIdx = args.indexOf("--root");
const root = rootIdx >= 0 ? path.resolve(args[rootIdx + 1]) : path.join(__dirname, "..");

const overlayDir = path.join(root, "overlay");
const baseDir = path.join(root, "nuwa-electron-shell");

function fail(msg) {
  console.error(`[check-pin] ${msg}`);
  process.exit(1);
}

function git(baseArgs, opts = {}) {
  const r = spawnSync("git", baseArgs, { cwd: baseDir, encoding: "buffer", ...opts });
  return r;
}

/** 与 sync-overlay.js 同规则：递归收集 overlay/ 文件（相对基座仓路径），排除根 README.md。 */
function collectOverlayFiles(dir, prefix = "") {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (!prefix && name === "README.md") continue;
    const abs = path.join(dir, name);
    if (fs.statSync(abs).isDirectory()) {
      out.push(...collectOverlayFiles(abs, rel));
    } else {
      out.push(rel);
    }
  }
  return out.sort();
}

if (!fs.existsSync(path.join(baseDir, ".git"))) {
  fail("基座 submodule 不存在，先 git submodule update --init nuwa-electron-shell");
}
if (!fs.existsSync(overlayDir)) {
  fail("overlay/ 目录不存在");
}

const overlayFiles = collectOverlayFiles(overlayDir);
const managed = new Set(overlayFiles);

if (staged) {
  const r = git(["diff", "--cached", "--name-only"]);
  if (r.status !== 0) fail(`git diff --cached 失败: ${r.stderr}`);
  const stagedFiles = r.stdout.toString().split("\n").filter(Boolean);
  const leaks = stagedFiles.filter((f) => managed.has(f));
  if (leaks.length > 0) {
    fail(
      `基座 staged 文件含 ${leaks.length} 个 overlay 托管路径（商业代码不得提交进基座）：\n  ` +
        leaks.join("\n  ") +
        `\n取消暂存：git -C nuwa-electron-shell restore --staged <path>；商业改动应落外层仓 overlay/。`,
    );
  }
  console.log(`[check-pin] staged 检查通过：${stagedFiles.length} 个已暂存文件，0 个 overlay 托管路径`);
  process.exit(0);
}

if (remoteRef) {
  const r = spawnSync("git", ["cat-file", "-e", `${remoteRef}^{commit}`], { cwd: baseDir, encoding: "buffer" });
  if (r.status !== 0) fail(`基座内不存在引用 ${remoteRef}（先 git -C nuwa-electron-shell fetch origin）`);
  const violations = [];
  for (const rel of overlayFiles) {
    const exists = git(["cat-file", "-e", `${remoteRef}:${rel}`]).status === 0;
    if (!exists) continue; // 基座尚无此文件（overlay 新增），无从泄回
    const blob = git(["show", `${remoteRef}:${rel}`]);
    const src = fs.readFileSync(path.join(overlayDir, rel));
    if (blob.status === 0 && blob.stdout.equals(src)) {
      violations.push(rel);
    }
  }
  if (violations.length > 0) {
    fail(
      `基座 ${remoteRef} 上有 ${violations.length} 个路径与 overlay 商业版字节相同（商业版本被提交进了基座）：\n  ` +
        violations.join("\n  ") +
        `\n须在基座回退为中立版本（外层仓的 overlay/ 才是商业实现的家）。`,
    );
  }
  console.log(
    `[check-pin] remote 检查通过：${remoteRef} 上 ${overlayFiles.length} 个 overlay 托管路径均为中立版本`,
  );
  process.exit(0);
}

// 默认 worktree 模式：基座脏文件必须全部是 overlay 同步产物
// -uall：untracked 展开到文件级——overlay 新增目录（基座无同名文件，如 cua/）默认
// 会被折叠成 "?? path/" 目录形态，与 manifest 的文件路径精确匹配失配而误报
const r = git(["status", "--porcelain", "-uall"]);
if (r.status !== 0) fail(`git status 失败: ${r.stderr}`);
const dirty = r.stdout
  .toString()
  .split("\n")
  .filter(Boolean)
  .map((line) => ({ code: line.slice(0, 2), path: line.slice(3).replace(/"(.*)"/, "$1") }));

const foreign = dirty.filter((d) => !managed.has(d.path));
if (foreign.length > 0) {
  fail(
    `基座工作树有 ${foreign.length} 个非 overlay 托管的改动（商业改动只允许经 overlay/ 进工作树；其他改动须先确认归属——是基座中立修复请直接提交基座，是商业改动请移入 overlay/）：\n  ` +
      foreign.map((d) => `${d.code} ${d.path}`).join("\n  "),
  );
}
const overlayDirty = dirty.filter((d) => managed.has(d.path));
console.log(
  `[check-pin] worktree 检查通过：基座脏文件 ${dirty.length} 个，全部 ${overlayDirty.length} 个为 overlay 同步产物`,
);
