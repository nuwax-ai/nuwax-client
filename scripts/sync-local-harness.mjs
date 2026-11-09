#!/usr/bin/env node
/**
 * 把 fork 仓库(/Volumes/zhitai/git_workspace/fork-nuwax-codex)源码构建的
 * nuwax-harness 引擎同步进客户端 dev 资源目录,用于不发 npm 的本地联调。
 *
 * 做三件事:
 *   1. prefetch rusty_v8(优先离线缓存 ~/.cache/nuwax/rusty_v8),生成 env 文件
 *   2. cargo build(--profile 由 HARNESS_PROFILE 控制,默认 release)
 *      主二进制 codex + codex-code-mode-host
 *   3. 备份并替换 resources/nuwax-harness-acp-ts/vendor/nuwax-harness/<ver>/
 *      下的同名文件(备份后缀 .released-orig,只备份一次;restore 时还原)
 *
 * 版本目录名沿用 vendor 里现有的(如 0.18.32):运行时 NUWAX_PATH 直指文件,
 * 不校验二进制自身的 --version;本地构建默认 0.0.0,可通过 HARNESS_VERSION
 * 走与 CI 相同的 Cargo.toml sed 打点(会改动 fork 工作区文件,用完记得还原)。
 *
 * 用法(经 Makefile):
 *   make harness-local        # 构建并替换,随后以本地引擎启动 dev
 *   make dev                  # 启动前自动 --restore 还原发布版(静默 no-op 安全)
 * 直接调用:
 *   node scripts/sync-local-harness.mjs --ensure-frontend  # 仅前端产物守卫(条件重建)
 *   node scripts/sync-local-harness.mjs                 # 构建并替换
 *   HARNESS_PROFILE=dev node scripts/sync-local-harness.mjs   # debug 快很多
 *   node scripts/sync-local-harness.mjs --restore       # 还原为发布版
 *
 * 环境变量:
 *   FORK_REPO       fork 仓库路径(默认 /Volumes/zhitai/git_workspace/fork-nuwax-codex)
 *   HARNESS_PROFILE cargo profile:release|dev(默认 release)
 *   HARNESS_VERSION 可选,打点到二进制的版本号(默认不打点,显示 0.0.0)
 */
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

// --quiet: 只保留错误输出(供 make dev 的静默自动还原使用)
const QUIET = process.argv.includes("--quiet");
const info = (...a) => { if (!QUIET) console.log(...a); };

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FORK_REPO = process.env.FORK_REPO || "/Volumes/zhitai/git_workspace/fork-nuwax-codex";
const PROFILE = process.env.HARNESS_PROFILE || "release";
const VENDOR_ROOT = path.join(
  clientRoot,
  "nuwa-electron-shell/crates/agent-electron-client/resources/nuwax-harness-acp-ts/vendor/nuwax-harness",
);
const ENV_FILE = "/tmp/nuwax-v8.env";
const BACKUP_SUFFIX = ".released-orig";

function fail(msg) {
  console.error(`[sync-local-harness] ${msg}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  info(`[sync-local-harness] + ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, {stdio: "inherit", ...opts});
  if (result.status !== 0) fail(`命令失败(exit ${result.status}): ${cmd}`);
  return result;
}

function currentVendorDir() {
  if (!fs.existsSync(VENDOR_ROOT)) fail(`vendor 目录不存在: ${VENDOR_ROOT}`);
  const versions = fs.readdirSync(VENDOR_ROOT).filter(v =>
    fs.existsSync(path.join(VENDOR_ROOT, v, "nuwax-harness")),
  );
  if (versions.length === 0) fail(`vendor 下没有引擎版本目录(先跑 make setup/pnpm install)`);
  return path.join(VENDOR_ROOT, versions[0]);
}

function restore() {
  const vendorDir = currentVendorDir();
  let restored = 0;
  for (const name of ["nuwax-harness", "codex-code-mode-host"]) {
    const live = path.join(vendorDir, name);
    const backup = live + BACKUP_SUFFIX;
    if (fs.existsSync(backup)) {
      fs.copyFileSync(backup, live);
      fs.chmodSync(live, 0o755);
      restored += 1;
      info(`[sync-local-harness] 已还原 ${name}`);
    }
  }
  if (restored === 0) {
    info("[sync-local-harness] 无本地构建需要还原");
  }
}

function stampVersion(version) {
  const manifest = path.join(FORK_REPO, "codex-rs", "Cargo.toml");
  const original = fs.readFileSync(manifest, "utf8");
  const stamped = original.replace(
    /^version = "0\.0\.0"$/m,
    `version = "${version}"`,
  );
  if (stamped === original) {
    info("[sync-local-harness] Cargo.toml 没有 0.0.0 可打点,跳过");
    return null;
  }
  fs.writeFileSync(manifest, stamped);
  info(`[sync-local-harness] 已打点版本 ${version}(构建后还原)`);
  return () => fs.writeFileSync(manifest, original);
}

/**
 * 前端产物守卫:nuwax(源码)与 nuwax-dist(产物)双 pin 不匹配时,本地重建
 * 并提交(nuwax-dist 一个产物 commit + 外层一个 gitlink commit,均不推送)。
 * 戳一致时是瞬时 no-op,由 make harness-local 启动前调用,免去手动 sub:update。
 */
async function ensureFrontend() {
  const {validatePinnedFrontend} = await import("./client/prepare.mjs");
  try {
    await validatePinnedFrontend(clientRoot);
    info("[sync-local-harness] 前端产物 pin 一致,无需重建");
    return;
  } catch (err) {
    const message = String(err?.message || err);
    if (!message.includes("不匹配") && !message.includes("双 pin")) {
      fail(`前端校验失败(非产物戳问题,请人工处理): ${message}`);
    }
  }
  info("[sync-local-harness] 前端产物与源码 pin 不匹配,本地重建并提交(不推送)…");
  // 不用 --no-commit:validatePinnedFrontend 要求 nuwax-dist 工作树干净且
  // HEAD == 外层 pin,只有本地提交(不推送)才能同时满足双 pin 与干净树。
  // IDE 的 git 监视器可能瞬时持有 index.lock,失败后重试(清理残留锁)。
  const updateArgs = [
    path.join(clientRoot, "scripts", "client", "cli.mjs"),
    "sub:update", "--no-push-dist", "--force",
  ];
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = spawnSync("node", updateArgs, {cwd: clientRoot, stdio: "inherit"});
    if (result.status === 0) { lastError = null; break; }
    lastError = result.status;
    if (attempt < 3) {
      info(`[sync-local-harness] sub:update 失败(第 ${attempt} 次),清理锁后重试…`);
      for (const module of ["nuwax", "nuwax-dist"]) {
        const lock = path.join(clientRoot, ".git", "modules", module, "index.lock");
        if (fs.existsSync(lock)) fs.rmSync(lock);
      }
      // 重试前把上次构建留下的脏产物树还原,否则 sub:update 会因
      // “有源码改动”拒绝执行
      for (const sub of ["nuwax-dist"]) {
        spawnSync("git", ["-C", path.join(clientRoot, sub), "checkout", "--", "."]);
        spawnSync("git", ["-C", path.join(clientRoot, sub), "clean", "-fdq"]);
      }
      // 等锁释放
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
    }
  }
  if (lastError !== null) fail(`sub:update 重试 ${3} 次后仍失败(exit ${lastError})`);
  // 重建后必须通过,否则说明环境有更深的问题
  const {validatePinnedFrontend: revalidate} = await import("./client/prepare.mjs");
  await revalidate(clientRoot);
  info("[sync-local-harness] 前端产物已就绪");
}

async function main() {
  if (process.argv.includes("--restore")) {
    restore();
    return;
  }
  if (process.argv.includes("--ensure-frontend")) {
    await ensureFrontend();
    return;
  }
  if (!fs.existsSync(path.join(FORK_REPO, "codex-rs", "Cargo.toml"))) {
    fail(`fork 仓库不存在: ${FORK_REPO}(可用 FORK_REPO 覆盖)`);
  }

  // 1. rusty_v8 prefetch:--offline 优先(共享缓存),失败再联网
  const prefetch = path.join(FORK_REPO, "scripts", "prefetch_rusty_v8.sh");
  const pre = spawnSync("bash", [prefetch, "--offline", "--env-file", ENV_FILE], {stdio: "inherit"});
  if (pre.status !== 0) {
    info("[sync-local-harness] 离线缓存未命中,联网 prefetch");
    run("bash", [prefetch, "--env-file", ENV_FILE]);
  }

  // 2. 构建(可选版本打点)
  const version = process.env.HARNESS_VERSION;
  const unstamp = version ? stampVersion(version) : null;
  try {
    const profileArgs = PROFILE === "release" ? ["--release"] : [];
    // 两条独立命令:--bin 是全局目标过滤器,混在一个命令里会把
    // codex-code-mode-host(名字不叫 codex)过滤掉(release 下实测踩坑)。
    const manifest = path.join(FORK_REPO, "codex-rs", "Cargo.toml");
    // prefetch 生成的 env 文件必须注入 cargo:rusty_v8 的 build.rs 只认
    // RUSTY_V8_ARCHIVE/RUSTY_V8_SRC_BINDING_PATH,缺了会直连 GitHub 下载
    // (国内网络 504)。不 source 而是解析后并入 env,避免依赖 shell。
    const v8env = {};
    if (fs.existsSync(ENV_FILE)) {
      for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
        const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (m) v8env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
      }
    } else {
      fail(`缺少 ${ENV_FILE}(prefetch 步骤未生成)`);
    }
    const buildEnv = {
      cwd: path.join(FORK_REPO, "codex-rs"),
      env: {...process.env, ...v8env,
        CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR || path.join(FORK_REPO, "codex-rs", "target"),
      },
    };
    run("cargo", ["build", ...profileArgs, "--manifest-path", manifest,
      "-p", "codex-cli", "--bin", "codex"], buildEnv);
    run("cargo", ["build", ...profileArgs, "--manifest-path", manifest,
      "-p", "codex-code-mode-host"], buildEnv);
  } finally {
    if (unstamp) unstamp();
  }

  // 3. 替换 vendor
  const vendorDir = currentVendorDir();
  const targetDir = path.join(FORK_REPO, "codex-rs", "target", PROFILE === "release" ? "release" : "debug");
  const pairs = [
    ["codex", "nuwax-harness"],
    ["codex-code-mode-host", "codex-code-mode-host"],
  ];
  for (const [built, installed] of pairs) {
    const src = path.join(targetDir, built);
    if (!fs.existsSync(src)) fail(`构建产物不存在: ${src}`);
    const dest = path.join(vendorDir, installed);
    const backup = dest + BACKUP_SUFFIX;
    if (fs.existsSync(dest) && !fs.existsSync(backup)) {
      fs.copyFileSync(dest, backup);
      info(`[sync-local-harness] 已备份发布版 → ${path.basename(backup)}`);
    }
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, 0o755);
  }

  const versionOut = spawnSync(path.join(vendorDir, "nuwax-harness"), ["--version"], {encoding: "utf8"});
  info(`[sync-local-harness] 完成:${vendorDir}`);
  info(`[sync-local-harness] 引擎 --version → ${(versionOut.stdout || "").trim() || versionOut.stderr}`);
}

await main();
