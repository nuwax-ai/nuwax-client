#!/usr/bin/env node
/**
 * UOS 1050 (arm64) 本地启动客户端。
 *
 * 这台机器和普通开发机有系统性差异，通用的 `make dev` 起不来：
 * - 没有系统 Node，只有已安装包里的 bundled Node；
 * - 开发副本是同步过去的，没有 .git，子模块与 pin 检查无法进行；
 * - 原生模块必须针对 glibc 2.28 重编（系统 GCC 8 编不过 Electron 43 的 V8 头）；
 * - 开发模式下关闭沙箱会让沙箱化的 webview 来宾渲染进程崩溃；
 * - 图形会话变量（DISPLAY / WAYLAND_DISPLAY）只在登录会话里，SSH 直连起不来窗口。
 *
 * 本命令做前置检查与环境装配，再通过 systemd 用户单元启动客户端：
 * 用户单元继承登录会话的图形环境，窗口才能真正显示。
 *
 * 用法：
 *   node scripts/client/dev-uos.mjs [--check-only] [--foreground]
 *     --check-only   只做检查，不启动
 *     --foreground   直接在本进程前台运行（需要当前 shell 已有图形会话变量）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as core from './core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 原生模块与 glibc 的检查逻辑与打包侧共用同一份实现。 */
const requirePolicy = createRequire(import.meta.url);
const { checkGlibcFloor } = requirePolicy(
  path.join(root, 'nuwa-electron-shell/crates/agent-electron-client/scripts/build/linux-package-policy.cjs'),
);

/** 目标系统的 glibc 上限；UOS 20 Pro 1050 是 2.28。 */
export const GLIBC_LIMIT = '2.28';

/** 已安装包里的 bundled Node 位置；这台机器没有系统 Node。 */
export const BUNDLED_NODE_DIR = '/opt/Nuwax/resources/node/linux-arm64/bin';

/** 目标平台；UOS 1050 只有 arm64 有真机。 */
export const TARGET_PLATFORM = 'linux';
export const TARGET_ARCH = 'arm64';

/** 启动客户端用的 systemd 用户单元名。 */
export const UNIT_NAME = 'nuwax-dev';

/** 日志文件：客户端的输出落在这里，方便事后查看。 */
export const LOG_FILE = '~/nuwax-dev-logs/dev.log';

/**
 * 校验当前机器是不是目标平台。
 * @returns {{ok: boolean, reason?: string}}
 */
export function checkTargetPlatform(platform = process.platform, arch = process.arch) {
  if (platform !== TARGET_PLATFORM) {
    return { ok: false, reason: `本命令只用于 ${TARGET_PLATFORM}，当前是 ${platform}` };
  }
  if (arch !== TARGET_ARCH) {
    return { ok: false, reason: `本命令只用于 ${TARGET_ARCH}，当前是 ${arch}` };
  }
  return { ok: true };
}

/**
 * 找出可用的 Node：这台机器没有系统 Node，要用已安装包里的 bundled Node。
 * @returns {{ok: boolean, node: string|null, reason?: string}}
 */
export function resolveNode(env = process.env) {
  const fromPath = spawnSync('sh', ['-c', 'command -v node'], { encoding: 'utf8', env });
  const node = fromPath.stdout.trim();
  if (node) return { ok: true, node };
  const bundled = path.join(BUNDLED_NODE_DIR, 'node');
  if (fs.existsSync(bundled)) return { ok: true, node: bundled };
  return { ok: false, node: null, reason: `找不到 node，也不在 ${bundled}` };
}

/**
 * 检查原生模块是否能在目标 glibc 上加载。
 * @returns {{ok: boolean, required: number|null, reason?: string}}
 */
export function checkNativeModule(file, limit = GLIBC_LIMIT) {
  const result = checkGlibcFloor(file, limit);
  if (result.ok) return { ok: true, required: result.required };
  return { ok: false, required: result.required, reason: result.reason };
}

/**
 * 装配启动环境。
 * PATH 需要包含 bundled Node 与 corepack 生成的 pnpm 垫片：
 * 这台机器既没有系统 Node，也没有系统 pnpm。
 * @returns {object} 传给子进程的环境变量
 */
export function buildEnv(base = process.env, { nodeDir = BUNDLED_NODE_DIR, home = base.HOME } = {}) {
  const shims = home ? path.join(home, '.local', 'bin') : null;
  const pathEntries = [nodeDir, shims, base.PATH].filter(Boolean).join(path.delimiter);
  return {
    ...base,
    PATH: pathEntries,
    // 独立开发档案，不碰正式版的 ~/.nuwax。
    NUWAX_DEV_PROFILE: '1',
    // 保留沙箱：这台机器允许 user namespace，而晚追加的 --no-sandbox 会打死来宾渲染进程。
    NUWAX_DEV_KEEP_SANDBOX: '1',
  };
}

/**
 * 读取 systemd 用户管理器里的图形会话变量。
 * 登录会话才有 DISPLAY / WAYLAND_DISPLAY，SSH 直连的 shell 没有。
 * @returns {object} 可用的会话变量；没有 systemd 时返回空对象
 */
export function readSessionEnvironment() {
  const result = spawnSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return {};
  const env = {};
  for (const line of result.stdout.split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (!match) continue;
    if (!['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_SESSION_TYPE', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY'].includes(match[1])) continue;
    env[match[1]] = match[2];
  }
  return env;
}

/**
 * 前置检查；任何一项不满足都给出可执行的修复提示。
 * @returns {{ok: boolean, problems: string[], node: string|null, native: object}}
 */
export function preflight(options = {}) {
  const p = core.paths(root);
  const problems = [];
  const platform = checkTargetPlatform(options.platform, options.arch);
  if (!platform.ok) problems.push(platform.reason);
  const node = resolveNode(options.env);
  if (!node.ok) problems.push(node.reason);
  const native = path.join(p.client, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node');
  const nativeResult = checkNativeModule(native, options.glibcLimit);
  if (!nativeResult.ok) {
    problems.push(
      `better_sqlite3.node 未就绪（${nativeResult.reason}）：` +
        '需用 glibc 2.28 目标的工具链重编，配方见 plans/20261124-uos-1050-linux-deb-and-local-dev-plan.md',
    );
  }
  return { ok: problems.length === 0, problems, node: node.node, native: nativeResult };
}

/**
 * 组装 systemd-run 的参数：单元继承登录会话的图形环境。
 * PATH 也要显式传过去：systemd 用户管理器里没有 bundled Node，
 * 而单元不继承调用方进程的环境。
 */
export function systemdRunArgs({ unit = UNIT_NAME, workingDirectory = root, logFile = LOG_FILE, env = {} } = {}) {
  const args = [
    `--unit=${unit}`,
    `--working-directory=${workingDirectory}`,
    '--collect',
    '--setenv=NUWAX_DEV_PROFILE=1',
    '--setenv=NUWAX_DEV_KEEP_SANDBOX=1',
    '-p', 'LimitCORE=0',
    '-p', `StandardOutput=append:${logFile}`,
    '-p', `StandardError=append:${logFile}`,
  ];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === null || value === '') continue;
    args.push(`--setenv=${key}=${value}`);
  }
  return args;
}

function main() {
  const checkOnly = process.argv.includes('--check-only');
  const foreground = process.argv.includes('--foreground');
  const result = preflight();
  for (const problem of result.problems) console.error(`[dev-uos] ${problem}`);
  if (!result.ok) {
    console.error('[dev-uos] 前置检查未通过，未启动客户端');
    process.exitCode = 1;
    return;
  }
  console.log(`[dev-uos] 平台 ${process.platform}/${process.arch}，glibc 上限 ${GLIBC_LIMIT}`);
  console.log(`[dev-uos] Node: ${result.node}`);
  console.log(`[dev-uos] 原生模块 glibc 上限检查通过（需要 GLIBC_${result.native.required}）`);
  if (checkOnly) return;

  const env = buildEnv();
  if (foreground) {
    console.log('[dev-uos] 前台启动客户端（Ctrl+C 停止）');
    const child = spawnSync('make', ['dev-direct'], { cwd: root, stdio: 'inherit', env });
    process.exitCode = child.status ?? 1;
    return;
  }

  const session = readSessionEnvironment();
  if (!session.DISPLAY && !session.WAYLAND_DISPLAY) {
    console.error('[dev-uos] systemd 用户管理器里没有图形会话变量（DISPLAY / WAYLAND_DISPLAY）');
    console.error('[dev-uos] 请在图形会话里启动，或用 --foreground 并自行提供会话变量');
    process.exitCode = 1;
    return;
  }
  const logFile = LOG_FILE.replace(/^~/, process.env.HOME ?? '');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, `=== dev-uos ${new Date().toISOString()} ===\n`);
  // 单元不继承调用方环境，PATH 必须显式带上：系统里没有 node，只有已安装包里的 bundled Node。
  const args = ['--user', ...systemdRunArgs({ logFile, env: { PATH: env.PATH } }), 'make', 'dev-direct'];
  console.log(`[dev-uos] 通过 systemd 用户单元 ${UNIT_NAME} 启动，日志：${LOG_FILE}`);
  const child = spawnSync('systemd-run', args, { cwd: root, stdio: 'inherit', env });
  if (child.status !== 0) {
    console.error(`[dev-uos] systemd-run 失败（${child.status}）`);
    process.exitCode = child.status ?? 1;
    return;
  }
  console.log(`[dev-uos] 已启动；查看日志：tail -f ${LOG_FILE}`);
  console.log('[dev-uos] 停止：systemctl --user stop ' + UNIT_NAME);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
