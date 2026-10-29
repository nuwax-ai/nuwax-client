#!/usr/bin/env node
/**
 * 在本仓客户端 crate 转发签名、验签与镜像同步命令。
 * 发布仓库、资产前缀来自 client.config.mjs，同步目标取当前仓库分支；
 * 显式环境覆盖优先。常规发布由根 release 编排，此入口供人工兜底使用。
 * 参数原样透传，实际脚本位于 nuwa-electron-shell/crates/agent-electron-client/。
 */
import { fileURLToPath } from 'node:url';
import config from '../../client.config.mjs';
import { run, git, paths } from './core.mjs';
import { parseReleaseVersion } from '../release-version.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

export function forwardEnv(processEnv = process.env, branch = '') {
  const env = {
    SIGN_RELEASE_REPO: processEnv.SIGN_RELEASE_REPO || config.release.repo,
    SYNC_OSS_REPO: processEnv.SYNC_OSS_REPO || config.release.repo,
    SIGN_WIN_ARTIFACT_PREFIX: processEnv.SIGN_WIN_ARTIFACT_PREFIX || config.product.name,
  };
  if (branch && !processEnv.SYNC_OSS_REF) env.SYNC_OSS_REF = branch;
  return env;
}

export function main(argv = process.argv.slice(2)) {
  const [script, ...args] = argv;
  if (!script || script.startsWith('-')) {
    console.error('用法: node scripts/client/forward.mjs <客户端 crate npm 脚本> [args...]（外层同名 env 优先）');
    process.exitCode = 1;
    return;
  }
  const branch = git(root, ['branch', '--show-current'], { allowFailure: true });
  const env = forwardEnv(process.env, branch);
  if (script === 'sign:win' && args[0] && !process.env.SIGN_RELEASE_TAG) {
    const identity = parseReleaseVersion(args[0]);
    if (identity.channel !== 'stable') throw new Error('Windows 签名仅适用 stable');
    env.SIGN_RELEASE_TAG = `v${identity.version}`;
  }
  const result = run('npm', ['run', script, ...(args.length ? ['--', ...args] : [])],
    { cwd: paths(root).client, env, allowFailure: true });
  process.exitCode = result.status;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
