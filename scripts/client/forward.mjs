#!/usr/bin/env node
/**
 * 在基座 crate（nuwa-electron-shell/crates/agent-electron-client）内转发 npm 脚本，
 * 预注入商业版发布 env（外层同名 env 优先），免去手敲基座目录与三个易漏变量：
 *   SIGN_RELEASE_REPO / SYNC_OSS_REPO ← client.config.mjs release.repo（基座默认社区仓 nuwaclaw）
 *   SIGN_WIN_ARTIFACT_PREFIX         ← product.name（基座本地 productName=NuwaClaw，不注入取错产物名）
 *   SYNC_OSS_REF                     ← 外层当前分支（sync:oss 须指向含同版 workflow 的发布线；
 *                                      在基座目录运行时脚本自身的默认 ref 不可依赖，见 docs/sign-windows.md）
 * 用法（外层仓库根，参数原样透传给基座脚本）：
 *   npm run sign:win -- 1.0.46            # Windows 签名（正常发版由 npm run release 经 SSH 编排）
 *   npm run verify:sign:win               # 本地验签
 *   npm run sync:oss -- v3.0.10 stable
 * 不做 overlay 同步：签名/同步只读基座 scripts 与 package.json，与 overlay 托管文件无关。
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
    console.error('用法: node scripts/client/forward.mjs <基座 npm 脚本> [args...]（外层同名 env 优先）');
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
