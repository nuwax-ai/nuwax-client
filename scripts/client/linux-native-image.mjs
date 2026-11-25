#!/usr/bin/env node
/**
 * Linux 原生件构建镜像的标识与调用参数。
 *
 * 镜像把 Linux 原生件（better-sqlite3、capture ffmpeg、cua-driver）放在 glibc 2.28 的
 * Debian 10 环境里编译，产物才能在 UOS 20 Pro 1050 这类系统上加载。打包仍在 runner 上做，
 * 只有编译进镜像。
 *
 * 镜像 tag 由 docker/linux-native/ 目录的内容哈希决定：任何文件一改，tag 就变，
 * 不存在被 "latest" 悄悄换掉的可能。版本与校验和的单一事实源是 docker/linux-native/versions.env。
 *
 * 用法：
 *   node scripts/client/linux-native-image.mjs tag                 输出镜像 tag
 *   node scripts/client/linux-native-image.mjs ref                 输出完整镜像地址（含 registry）
 *   node scripts/client/linux-native-image.mjs verify              校验本地镜像与目录内容一致（不连 registry）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const imageDir = path.join(root, 'docker/linux-native');
/** 镜像内容哈希的输入：这些文件任何一个变化都必须产生新的 tag。 */
const RECIPE_FILES = ['Dockerfile', 'versions.env', 'gxx-shim.sh'];
/** 镜像所在的 registry 主机。`docker login` 要的是主机名，不带镜像名。 */
export const REGISTRY_HOST = 'ghcr.io';
/** 镜像名（不含 tag）。 */
export const IMAGE_NAME = 'nuwax-ai/nuwax-linux-native';
/**
 * 镜像的完整路径（不含 tag）。
 * 镜像在 GHCR 上是**私有**的：拉取前要先 `docker login`，用 GITHUB_TOKEN，
 * 调用方 workflow 需要 packages: read。（仓库是 public 的，但包的可见性是单独设置的。）
 */
export const REGISTRY = `${REGISTRY_HOST}/${IMAGE_NAME}`;

/** 镜像内容哈希：Dockerfile、版本清单与垫片的 SHA256，取前 12 位。 */
export function imageHash(directory = imageDir) {
  const hash = createHash('sha256');
  for (const name of RECIPE_FILES) {
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) throw new Error(`[linux-native-image] 缺少镜像定义文件：${name}`);
    hash.update(name).update('\0').update(fs.readFileSync(file)).update('\0');
  }
  return hash.digest('hex').slice(0, 12);
}

/** 镜像 tag：内容哈希本身。不带日期，同一个内容永远是同一个 tag，重复构建是幂等的。 */
export function imageTag(directory = imageDir) {
  return imageHash(directory);
}

/** 完整镜像地址。 */
export function imageRef(directory = imageDir) {
  return `${REGISTRY}:${imageTag(directory)}`;
}

/** 解析 `docker/linux-native/versions.env`，注释与空行忽略。 */
export function readVersions(file = path.join(imageDir, 'versions.env')) {
  const versions = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) versions[match[1]] = match[2].trim();
  }
  return versions;
}

/** 生成 `docker build` 的 --build-arg 列表。 */
export function buildArgs(versions = readVersions()) {
  return Object.entries(versions).flatMap(([key, value]) => ['--build-arg', `${key}=${value}`]);
}

/**
 * 校验本地镜像的 ID 与由内容哈希算出的一致，并且镜像里的 glibc 确实是 versions.env 声明的上限。
 * 只读、不连 registry；镜像不存在时直接报错。
 */
export function verifyLocalImage(ref = imageRef(), floor = readVersions().GLIBC_FLOOR) {
  const inspect = spawnSync('docker', ['image', 'inspect', ref, '--format', '{{.Id}}'], { encoding: 'utf8' });
  if (inspect.status !== 0) throw new Error(`[linux-native-image] 本地没有镜像 ${ref}：${(inspect.stderr || '').trim()}`);
  const ldd = spawnSync('docker', ['run', '--rm', ref, 'sh', '-c', 'ldd --version | head -n 1'], { encoding: 'utf8' });
  if (ldd.status !== 0) throw new Error(`[linux-native-image] 无法运行镜像 ${ref}：${(ldd.stderr || '').trim()}`);
  const version = /(\d+\.\d+)\s*$/.exec(ldd.stdout.trim())?.[1];
  if (version !== floor) throw new Error(`[linux-native-image] 镜像内 glibc 是 ${version}，与声明的上限 ${floor} 不一致`);
  return { ref, id: inspect.stdout.trim(), glibc: version };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command] = process.argv.slice(2);
    const output = {
      tag: () => imageTag(),
      ref: () => imageRef(),
      // One KEY=value per line: the format docker/build-push-action's `build-args` input takes.
      // (The `docker build` command line wants `--build-arg KEY=value` pairs; that is buildArgs().)
      'build-args': () => Object.entries(readVersions()).map(([name, value]) => `${name}=${value}`).join('\n'),
      verify: () => { const result = verifyLocalImage(); return `${result.ref} glibc ${result.glibc}`; },
    }[command];
    if (!output) throw new Error('用法: linux-native-image.mjs tag | ref | build-args | verify');
    const value = output();
    if (value !== null && value !== undefined) console.log(value);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
