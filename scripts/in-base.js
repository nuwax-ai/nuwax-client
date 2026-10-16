#!/usr/bin/env node
/**
 * node scripts/in-base.js [--no-inject | --no-env] -- <command> [args...]
 * 默认同步商业 overlay、准备壳依赖并注入产品环境。
 * --no-env 同步 overlay 但不注入环境，供商业测试使用。
 * --no-inject 还原 overlay 后使用社区默认值，必须在隔离副本运行。
 * 构建参数与各入口见 docs/npm-scripts.md；身份 define 机制见共享 constants。
 */
const { spawnSync } = require('child_process');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const baseDir = path.join(rootDir, 'nuwa-electron-shell');

const argv = process.argv.slice(2);
const noInject = argv[0] === '--no-inject';
if (noInject) argv.shift();
const noEnv = argv[0] === '--no-env';
if (noEnv) argv.shift();
if (argv[0] !== '--' || argv.length < 2) {
  console.error('用法: node scripts/in-base.js [--no-inject | --no-env] -- <command> [args...]');
  process.exit(1);
}
const cmd = argv.slice(1);

if (!noInject) {
  const sync = spawnSync('node', [path.join(__dirname, 'sync-overlay.js')], {
    stdio: 'inherit',
    cwd: rootDir,
  });
  if (sync.status !== 0) {
    console.error('[in-base] overlay 同步失败，中止');
    process.exit(sync.status ?? 1);
  }
  const dependencies = spawnSync(process.execPath, [path.join(__dirname, 'client/commercial-dependencies.mjs')], {
    stdio: 'inherit', cwd: rootDir,
  });
  if (dependencies.status !== 0) {
    console.error('[in-base] 商业依赖准备失败，中止');
    process.exit(dependencies.status ?? 1);
  }
} else {
  // 社区基线须跑在干净基座源码上：还原上一轮同步进工作树的 overlay 文件
  // （仅清单内文件；不影响基座工作树里的其他本地改动）
  const clean = spawnSync('node', [path.join(__dirname, 'sync-overlay.js'), '--clean'], {
    stdio: 'inherit',
    cwd: rootDir,
  });
  if (clean.status !== 0) {
    console.error('[in-base] overlay 还原失败，中止');
    process.exit(clean.status ?? 1);
  }
}

const env = noInject || noEnv
  ? { ...process.env }
  : {
      ...process.env,
      NUWAX_APP_IDENTIFIER: process.env.NUWAX_APP_IDENTIFIER || 'nuwax',
      NUWAX_APP_DISPLAY_NAME: process.env.NUWAX_APP_DISPLAY_NAME || '女娲Nuwax',
      NUWAX_UPDATE_FEED_BASE:
        process.env.NUWAX_UPDATE_FEED_BASE ||
        'https://nuwa-packages.oss-rg-china-mainland.aliyuncs.com/nuwax-electron',
      // 商业版官网下载页（MSI 等不支持自动更新的形态引导用；商业版暂无独立
      // 产品页先指官网首页，待上线后改正式值——社区默认 nuwaclaw.html 不适用）
      NUWAX_DOWNLOAD_PAGE_URL:
        process.env.NUWAX_DOWNLOAD_PAGE_URL || 'https://nuwax.com',
      NUWAX_PORT_OFFSET: process.env.NUWAX_PORT_OFFSET || '1000',
      NUWAX_FRONTEND_DIST: process.env.NUWAX_FRONTEND_DIST || path.join(rootDir, 'nuwax-dist'),
    };

const result = spawnSync(cmd[0], cmd.slice(1), {
  stdio: 'inherit',
  cwd: baseDir,
  env,
});
process.exit(result.status ?? 1);
