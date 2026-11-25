#!/usr/bin/env node
/**
 * 在 glibc 2.28 的构建镜像里执行一个 Linux 原生件编译步骤；非 Linux 平台原样执行。
 *
 * 这是 .github/actions/linux-native-step 的实现。workflow 里的三个编译步骤
 * （better-sqlite3、capture ffmpeg、cua-driver）通过它在五个平台上共用同一份定义：
 * macOS / Windows 上命令直接跑在 runner 上，Linux 上交给镜像。
 *
 * 为什么只把编译放进镜像、打包留在 runner：Linux 打包 job 有三十多步，依赖 runner 上的
 * fpm、rpm、上传工具等；arm64 打包还要用系统 fpm（electron-builder 内置的只有 x86 版），
 * buster 的 ruby 太老。只换编译这几步，改动面最小。
 *
 * 用法（由 action 调用，环境变量传入）：
 *   STEP_COMMAND   要执行的命令
 *   STEP_WORKDIR   相对仓库根的工作目录（可空）
 *   STEP_ARCH      目标架构 x64 | arm64（空则取 runner 的）
 *   STEP_ENV       额外环境变量，每行一个 KEY=VALUE
 *   STEP_TIMEOUT_MINUTES  步骤超时（分钟），可空
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { imageRef, REGISTRY_HOST } from './linux-native-image.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 把 `KEY=VALUE` 文本解析成对象；空行与没有 `=` 的行忽略。值里可以含 `=`。 */
export function parseStepEnv(text) {
  const env = {};
  for (const line of String(text ?? '').split('\n')) {
    // A `#` line is a comment carried along in the YAML block (the release
    // workflows keep the explanation of an expression next to it). Skip it on
    // its own merits rather than because it happens to contain no `=`.
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    env[line.slice(0, index).trim()] = line.slice(index + 1);
  }
  return env;
}

/**
 * 步骤级超时。复合 action 的 `uses` 步骤上不能写 `timeout-minutes`，所以由这里执行：
 * 给命令前面加 `timeout`，到点先 TERM、宽限期后 KILL。
 * @param {string[]} argv 要执行的命令
 * @param {number|string} [minutes] 超时分钟数；空或非正数表示不限制
 */
export function withTimeout(argv, minutes) {
  const limit = Number(minutes);
  if (!Number.isFinite(limit) || limit <= 0) return argv;
  // 超时时退出码 124，与 `timeout` 约定一致，便于在日志里辨认。
  return ['timeout', '--kill-after=30s', `${limit}m`, ...argv];
}

/** Docker 说 amd64，仓库和 CI 的约定是 x64。 */
export function dockerPlatform(arch) {
  if (arch === 'x64') return 'linux/amd64';
  if (arch === 'arm64') return 'linux/arm64';
  throw new Error(`[linux-native-step] 不支持的目标架构：${arch}`);
}

/**
 * 镜像里的 `HOME`。runner 的 HOME 下有 pnpm、cargo、node-gyp 的缓存，挂进容器可以复用；
 * 但以非 root 运行时容器里没有该用户，所以用一个属于 runner 的独立目录更稳妥。
 */
export function containerHome(runnerTemp, workspace) {
  return path.join(runnerTemp || path.join(workspace, '.tmp'), 'linux-native-home');
}

/**
 * 组装 `docker run` 的参数。每一条都对应一个实测踩到的坑，见行内注释。
 *
 * @param {object} options
 * @param {string} options.workspace 仓库根目录（runner 上的真实路径）
 * @param {string} options.arch      x64 | arm64
 * @param {number} options.uid       runner 的 uid
 * @param {number} options.gid       runner 的 gid
 * @param {string} options.home      容器内的 HOME
 * @param {Record<string,string>} [options.volumes] 额外挂载：容器路径 → 宿主路径
 */
export function dockerArgs({ workspace, arch, uid, gid, home, volumes = {}, workingDirectory = '' }) {
  if (!workspace) throw new Error('[linux-native-step] 缺少 workspace');
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) throw new Error('[linux-native-step] 缺少 runner 的 uid/gid');
  const args = ['run', '--rm', `--platform=${dockerPlatform(arch)}`];

  // workspace 挂到与 runner 上完全相同的路径。仓库的 capture 脚本会把产物的绝对路径写进
  // package.json，路径一变打包就找不到录屏资源。这是让现有脚本不改一行就能工作的前提。
  args.push('--volume', `${workspace}:${workspace}`);

  // 以 runner 的 uid/gid 运行，产物才不会变成 root 所有、后续步骤写不了。
  args.push('--user', `${uid}:${gid}`);

  args.push('--env', `HOME=${home}`);
  // 镜像的 /opt/cargo 属于 root：以 runner 用户运行时 cargo 写不了它的 registry，
  // 解析依赖时会 "failed to create directory /opt/cargo/registry/cache ... Permission denied"。
  // 工具链本身在 /opt/rustup，只读即可，不用动。
  args.push('--env', `CARGO_HOME=${path.join(home, 'cargo')}`);
  args.push('--env', `TARGET_ARCH=${arch}`);
  args.push('--env', 'CI=true');
  // 容器里不经过登录 shell，PATH 要显式带上镜像里各工具的位置，否则会用回系统的旧版本
  // （例如 /usr/bin/g++ 而不是垫片）。
  args.push('--env', 'PATH=/opt/toolchain/bin:/opt/node/bin:/opt/cargo/bin:/opt/python/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
  // 镜像里的 node-gyp 需要 Python >= 3.8，用独立的 3.12 而不是 buster 自带的 3.7。
  args.push('--env', 'PYTHON=/opt/python/bin/python3.12');
  // corepack 的 pnpm 垫片与下载缓存都落在 HOME 下，重跑时可以复用。
  args.push('--env', 'COREPACK_ENABLE_DOWNLOAD_PROMPT=0');

  for (const [target, source] of Object.entries(volumes)) {
    if (!source) continue;
    args.push('--volume', `${source}:${target}`);
  }

  // 工作目录只有一个：步骤指定了就用它，否则是仓库根。
  args.push('--workdir', path.resolve(workspace, workingDirectory || '.'));
  return args;
}

/**
 * 在镜像里执行命令。命令经 `bash -euo pipefail -c` 运行，与 workflow 的 `shell: bash` 行为一致。
 * @returns {number} 退出码
 */
export function runInImage({ command, workingDirectory, env, workspace, arch, uid, gid, runnerTemp, volumes, timeoutMinutes, ref = imageRef(), spawn = spawnSync, mkdir = fs.mkdirSync }) {
  if (!command || !command.trim()) throw new Error('[linux-native-step] 缺少要执行的命令');
  const home = containerHome(runnerTemp, workspace);
  // 容器的 HOME 必须由当前用户先建好。若留给 docker 在挂载时创建，它会属于 root，
  // 容器里的 runner 用户就写不了（corepack 第一个写 .cache 的动作即 EACCES）。
  mkdir(home, { recursive: true });
  const mounts = { [home]: home, ...(volumes || {}) };
  const args = dockerArgs({ workspace, arch, uid, gid, home, volumes: mounts, workingDirectory });
  // 步骤自己的环境变量：与 dockerArgs 的默认值同名时替换它，而不是追加第二个，
  // 否则同一个变量出现两次，看日志时分不清哪个生效。
  for (const [key, value] of Object.entries(env || {})) {
    if (value === undefined || value === null || value === '') continue;
    const assigned = `${key}=${value}`;
    // dockerArgs 用的是 "--env", "KEY=VALUE" 两个元素的形式。
    const at = args.findIndex((item, index) => item === '--env' && args[index + 1].startsWith(`${key}=`));
    if (at >= 0) args[at + 1] = assigned;
    else args.push('--env', assigned);
  }
  args.push(ref, 'bash', '-euo', 'pipefail', '-c', command);
  // 超时包在 docker 客户端外面：客户端被杀后，前台运行且带 --rm 的容器随之结束。
  // docker 自己的 stderr 另存一份：拉取私有镜像被拒时它只会给一个 `unauthorized`
  // 加退出码 125，值得翻译成能直接照做的提示。
  const dockerError = path.join(home, 'docker-stderr.log');
  const argv = withTimeout(['docker', ...args], timeoutMinutes);
  const result = spawn(argv[0], argv.slice(1), { stdio: ['inherit', 'inherit', 'pipe'], cwd: workspace });
  if (result.stderr?.length) {
    fs.writeFileSync(dockerError, result.stderr);
    process.stderr.write(result.stderr);
  }
  const status = result.status ?? 1;
  if (status === 125 && /unauthorized|denied: requested access/i.test(String(result.stderr))) {
    throw new Error([
      `[linux-native-step] 拉取镜像 ${ref} 被拒（unauthorized）。它在 GHCR 上是私有的，需要：`,
      '  1. 复合 action 把 GITHUB_TOKEN 传给本脚本（action.yml 的 env 里有 github.token）；',
      '  2. 调用方 workflow 在 permissions 里声明 packages: read。',
      '  两样都要有，缺任何一样都是这个错误。',
    ].join('\n'));
  }
  return status;
}

/** 非 Linux 平台：命令原样跑在 runner 上。 */
export function runNatively({ command, workingDirectory, env, workspace, timeoutMinutes, spawn = spawnSync }) {
  const merged = { ...process.env };
  for (const [key, value] of Object.entries(env || {})) {
    if (value === undefined || value === null || value === '') continue;
    merged[key] = value;
  }
  const cwd = workingDirectory ? path.resolve(workspace, workingDirectory) : workspace;
  const argv = withTimeout(['bash', '-euo', 'pipefail', '-c', command], timeoutMinutes);
  const result = spawn(argv[0], argv.slice(1), { stdio: 'inherit', cwd, env: merged });
  return result.status ?? 1;
}

/**
 * 登录镜像仓库。镜像在 GHCR 上是私有的，拉取前要登录。
 *
 * token 由复合 action 的 env 传入 —— 它不是默认就有的环境变量，action 必须自己声明
 * `GITHUB_TOKEN: ${{ github.token }}`；调用方 workflow 还要在 permissions 里写
 * `packages: read`。两样缺任何一样，拉取都会被拒。（v3.3.0-beta.3 的发布就是因此
 * 四个平台构建失败：当时两样都没有。）
 *
 * 没给 token 就不登录：用本地镜像或公开镜像时本来也不需要。登录失败则直接报错 ——
 * 继续往下只会得到一个更难懂的那个错。
 *
 * @returns {boolean} 是否执行了登录
 */
export function loginToRegistry({ token, actor, registry = REGISTRY_HOST, spawn = spawnSync, log = () => {} } = {}) {
  if (!token) {
    log('[linux-native-step] 未提供 GITHUB_TOKEN，跳过 registry 登录（本地镜像或公开镜像不需要）');
    return false;
  }
  const login = spawn('docker', ['login', registry, '-u', actor || 'github-actions', '--password-stdin'], {
    input: token, stdio: ['pipe', 'ignore', 'pipe'],
  });
  if (login.status !== 0) {
    const detail = (login.stderr || '').toString().trim() || '无输出';
    throw new Error(`[linux-native-step] docker login 到 ${registry} 失败（退出码 ${login.status}）：${detail}`);
  }
  return true;
}

/**
 * 复合 action 的入口：按平台决定在镜像里执行还是直接执行。
 * @param {object} [options]
 * @param {string} [options.ref] 要用的镜像地址；默认是当前内容哈希对应的那个。
 *   本地验证时可以指向尚未推送的本地镜像。
 */
export function main(env = process.env, platform = process.platform, { ref = imageRef() } = {}) {
  const command = env.STEP_COMMAND;
  const workingDirectory = env.STEP_WORKDIR || '';
  const stepEnv = parseStepEnv(env.STEP_ENV);
  const arch = env.STEP_ARCH || env.TARGET_ARCH || (process.arch === 'arm64' ? 'arm64' : 'x64');
  const workspace = env.GITHUB_WORKSPACE || root;
  const options = { command, workingDirectory, env: stepEnv, workspace, arch, timeoutMinutes: env.STEP_TIMEOUT_MINUTES };

  if (platform !== 'linux') {
    console.log(`[linux-native-step] ${platform}: 直接在 runner 上执行`);
    return runNatively(options);
  }

  // 容器的 HOME 在 RUNNER_TEMP 下，而 RUNNER_TEMP 会被挂进容器（见 runInImage），
  // 所以 pnpm、cargo、node-gyp 的缓存都落在宿主机上，同一个 job 里后续步骤直接复用。
  console.log(`[linux-native-step] linux/${arch}: 在镜像 ${ref} 里执行`);
  loginToRegistry({ token: env.GITHUB_TOKEN, actor: env.GITHUB_ACTOR, log: (message) => console.log(message) });
  return runInImage({ ...options, uid: Number(process.getuid?.()), gid: Number(process.getgid?.()), runnerTemp: env.RUNNER_TEMP, ref });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
