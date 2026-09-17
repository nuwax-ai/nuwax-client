#!/usr/bin/env node
/**
 * 在基座（nuwa-electron-shell/ submodule，main 分支）内执行命令，并预注入商业构建环境变量。
 *
 * 用法：
 *   node scripts/in-base.js [--no-inject | --no-env] -- <command> [args...]
 *   npm run base:install / base:dev / base:test / base:bundle / test:commercial
 *
 * 执行顺序：
 *   1. overlay 同步（scripts/sync-overlay.js）——把 overlay/ 商业自有代码覆写进基座
 *      工作树（当前为空即 no-op）；--no-inject 跳过（社区基线须用干净基座源码跑）。
 *   2. 商业 env 注入（可被外层同名变量覆盖），与 CI 构建步骤保持一致：
 *   NUWAX_APP_IDENTIFIER=nuwax        → 数据目录 ~/.nuwax（历史目录迁移链已被
 *                                       overlay 覆写 migrate.ts 阻断，全新开始）
 *   NUWAX_APP_DISPLAY_NAME=Nuwax      → 客户端展示名（窗口标题/设置「关于」/
 *                                       UA token Nuwax/<ver>）；刻意 ASCII——
 *                                       女娲Nuwax 为营销名，只出现在 README/发布文案
 *   NUWAX_UPDATE_FEED_BASE            → 独立更新通道 nuwax-electron
 *   NUWAX_PORT_OFFSET=1000             → 默认端口整体 +1000（19099/61002~61009/61173），
 *                                         与社区版 nuwaclaw、nuwa-cli 同机双开不冲突
 *   NUWAX_FRONTEND_DIST                → dev 模式 nuwax 前端 dist 位置（壳根 nuwax/ 子模块）
 *   --no-env：同步 overlay 但不注入 env——测试门禁口径（test:commercial）。测试套件
 *   断言「未注入 env 时为社区缺省身份」，env 只供构建/打包；商业行为由 overlay 文件
 *   在场 + 专项 env 测试（vi.stubEnv，如 migrate.commercial.test.ts）覆盖。
 * 机制详见基座 crates/agent-electron-client/src/shared/constants.ts 头注（构建期 define 注入）。
 */
const { spawnSync } = require('child_process');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const baseDir = path.join(rootDir, 'nuwa-electron-shell');

// 解析参数：[--no-inject | --no-env] -- <command> [args...]
// --no-inject：不注入商业 env；并先还原已同步的 overlay 文件（社区基线须用
//              干净基座源码 + 社区默认值跑，商业行为由专项 env 测试覆盖，如
//              migrate.commercial.test.ts / constants.port-offset.test.ts）
// --no-env   ：同步 overlay 但不注入 env（商业测试门禁 test:commercial 口径）
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
      NUWAX_APP_DISPLAY_NAME: process.env.NUWAX_APP_DISPLAY_NAME || 'Nuwax',
      NUWAX_UPDATE_FEED_BASE:
        process.env.NUWAX_UPDATE_FEED_BASE ||
        'https://nuwa-packages.oss-rg-china-mainland.aliyuncs.com/nuwax-electron',
      NUWAX_PORT_OFFSET: process.env.NUWAX_PORT_OFFSET || '1000',
      NUWAX_FRONTEND_DIST: process.env.NUWAX_FRONTEND_DIST || path.join(rootDir, 'nuwax', 'dist'),
    };

const result = spawnSync(cmd[0], cmd.slice(1), {
  stdio: 'inherit',
  cwd: baseDir,
  env,
});
process.exit(result.status ?? 1);
