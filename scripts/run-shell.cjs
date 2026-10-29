#!/usr/bin/env node
/**
 * 在本仓 nuwa-electron-shell/ 源码目录执行命令，并按参数准备依赖及构建身份。
 *
 * 用法：
 *   npm run shell:exec -- [--no-inject | --no-env] -- <command> [args...]
 * 日常开发、打包使用根目录 setup/dev/pack/release，商业测试使用 test:commercial。
 *
 * 执行顺序：
 *   1. 准备仓库根依赖；--no-inject 不准备依赖、不注入身份，供 CI 自行编排。
 *   2. 商业 env 注入（可被外层同名变量覆盖），与 CI 构建步骤保持一致：
 *   NUWAX_APP_IDENTIFIER=nuwax        → 数据目录 ~/.nuwax，不导入其他产品的历史数据
 *   NUWAX_APP_DISPLAY_NAME=女娲Nuwax  → 客户端展示名（窗口标题/菜单/托盘/设置「关于」）；
 *                                       UA、文件名与数据目录使用独立的 ASCII 技术标识
 *   NUWAX_UPDATE_FEED_BASE            → 独立更新通道 nuwax-electron
 *   NUWAX_DOWNLOAD_PAGE_URL           → 官网下载页（不支持自动更新的安装形态引导；
 *                                       商业暂无产品页，先指官网首页）
 *   NUWAX_PORT_OFFSET=1000             → 兼容端口默认值；商业运行端口由主进程自动分配
 *   NUWAX_FRONTEND_DIST                → 本仓 nuwax-dist/ 前端产物位置
 *   --no-env：准备依赖但不注入身份，用于 test:commercial；测试保留缺省值断言，
 *   商业身份差异由专项 env 测试覆盖，源码始终使用本仓版本。
 * 构建期 define 注入见 nuwa-electron-shell/crates/agent-electron-client/src/shared/constants.ts。
 */
const { spawnSync } = require('child_process');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const shellDir = path.join(rootDir, 'nuwa-electron-shell');

// 解析参数：[--no-inject | --no-env] -- <command> [args...]
// --no-inject：不注入商业 env、不准备商业依赖
// --no-env   ：准备商业依赖但不注入 env（商业测试门禁 test:commercial 口径）
const argv = process.argv.slice(2);
const noInject = argv[0] === '--no-inject';
if (noInject) argv.shift();
const noEnv = argv[0] === '--no-env';
if (noEnv) argv.shift();
if (argv[0] !== '--' || argv.length < 2) {
  console.error('用法: node scripts/run-shell.cjs [--no-inject | --no-env] -- <command> [args...]');
  process.exit(1);
}
const cmd = argv.slice(1);

if (!noInject) {
  const dependencies = spawnSync(process.execPath, [path.join(__dirname, 'client/commercial-dependencies.mjs')], {
    stdio: 'inherit', cwd: rootDir,
  });
  if (dependencies.status !== 0) {
    console.error('[run-shell] 商业依赖准备失败，中止');
    process.exit(dependencies.status ?? 1);
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
      NUWAX_LOCAL_PORT_MODE: 'auto',
      NUWAX_FRONTEND_DIST: process.env.NUWAX_FRONTEND_DIST || path.join(rootDir, 'nuwax-dist'),
    };

const result = spawnSync(cmd[0], cmd.slice(1), {
  stdio: 'inherit',
  cwd: shellDir,
  env,
});
process.exit(result.status ?? 1);
