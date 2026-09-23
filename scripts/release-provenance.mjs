#!/usr/bin/env node
/** Record the exact source tree used by one platform build, then verify all
 * platform records before an update-channel pointer can move. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const platforms = ['macos-arm64', 'macos-x64', 'windows-x64', 'linux-x64', 'linux-arm64'];

function requiredArtifacts(tag, key) {
  const match = /^(?:electron|prerelease)-v(\d+\.\d+\.\d+)$/.exec(tag);
  if (!match) fail(`无效发布 tag: ${tag}`);
  const version = match[1];
  return {
    'macos-arm64': [`Nuwax-${version}-arm64.dmg`, `Nuwax-${version}-arm64-mac.zip`],
    'macos-x64': [`Nuwax-${version}.dmg`, `Nuwax-${version}-mac.zip`],
    'windows-x64': [`Nuwax-Setup-${version}-unsigned.exe`],
    'linux-x64': [`Nuwax-${version}.AppImage`],
    'linux-arm64': [`Nuwax-${version}-arm64.AppImage`],
  }[key];
}

function fail(message) {
  console.error(`[release-provenance] ${message}`);
  process.exit(1);
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function filesIn(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = join(prefix, entry.name);
    return entry.isDirectory() ? filesIn(join(dir, entry.name), relative) : [relative];
  }).sort();
}

function sha256File(path) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(path, 'r');
  try {
    let bytes;
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
  } finally { closeSync(fd); }
  return hash.digest('hex');
}

function sha256Tree(dir) {
  const hash = createHash('sha256');
  for (const file of filesIn(dir)) {
    hash.update(file.replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(sha256File(join(dir, file)));
    hash.update('\n');
  }
  return hash.digest('hex');
}

function record([tag, platform, arch, outDir]) {
  if (!tag || !platform || !arch || !outDir || !platforms.includes(`${platform}-${arch}`)) {
    fail('用法: record <tag> <macos|windows|linux> <arch> <release-output-dir>');
  }
  const output = resolve(outDir);
  const frontend = git('rev-parse', 'HEAD:nuwax');
  const shell = git('rev-parse', 'HEAD:nuwa-electron-shell');
  const stamp = JSON.parse(readFileSync(join(root, 'nuwax/dist/version.json'), 'utf8')).gitHash;
  if (!/^[0-9a-f]{7,40}$/.test(stamp) || !frontend.startsWith(stamp)) {
    fail(`前端 dist stamp ${stamp} 与 gitlink ${frontend} 不符`);
  }
  const manifest = {
    schemaVersion: 1,
    tag,
    source: { client: git('rev-parse', 'HEAD'), shell, frontend },
    frontend: { stamp, distSha256: sha256Tree(join(root, 'nuwax/dist')) },
    platform,
    arch,
    artifacts: Object.fromEntries(filesIn(output)
      .filter((file) => basename(file) === file && /\.(?:dmg|zip|exe|msi|AppImage|deb|rpm)$/.test(file))
      .map((file) => [file.replaceAll('\\', '/'), sha256File(join(output, file))])),
  };
  for (const file of requiredArtifacts(tag, `${platform}-${arch}`)) {
    if (!manifest.artifacts[file]) fail(`${platform}-${arch} 缺少预期安装资产 ${file}`);
  }
  const filename = `build-manifest-${platform}-${arch}.json`;
  writeFileSync(join(output, filename), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[release-provenance] ${filename}: ${manifest.source.client.slice(0, 9)} / ${shell.slice(0, 9)} / ${frontend.slice(0, 9)}`);
}

function verify([tag, assetsDir]) {
  if (!tag || !assetsDir) fail('用法: verify <tag> <downloaded-release-assets-dir>');
  const dir = resolve(assetsDir);
  const manifests = platforms.map((key) => {
    const path = join(dir, `build-manifest-${key}.json`);
    let value;
    try { value = JSON.parse(readFileSync(path, 'utf8')); }
    catch { fail(`缺少或无法解析 ${basename(path)}`); }
    if (value.schemaVersion !== 1 || value.tag !== tag || `${value.platform}-${value.arch}` !== key) {
      fail(`${basename(path)} 的版本或平台不匹配`);
    }
    for (const name of ['client', 'shell', 'frontend']) {
      if (!/^[0-9a-f]{40}$/.test(value.source?.[name] ?? '')) fail(`${basename(path)} 缺少有效的 ${name} SHA`);
    }
    if (!/^[0-9a-f]{7,40}$/.test(value.frontend?.stamp ?? '') ||
        !value.source.frontend.startsWith(value.frontend.stamp) ||
        !/^[0-9a-f]{64}$/.test(value.frontend?.distSha256 ?? '')) {
      fail(`${basename(path)} 的前端构建记录无效`);
    }
    if (!value.artifacts || Object.keys(value.artifacts).length === 0) fail(`${basename(path)} 未记录安装资产`);
    for (const file of requiredArtifacts(tag, key)) {
      if (!value.artifacts[file]) fail(`${basename(path)} 缺少预期安装资产 ${file}`);
    }
    for (const [file, digest] of Object.entries(value.artifacts)) {
      if (basename(file) !== file || !/^[0-9a-f]{64}$/.test(digest)) fail(`${basename(path)} 的资产条目无效`);
      const asset = join(dir, file);
      if (!existsFile(asset) && key === 'windows-x64' && file.endsWith('-unsigned.exe')) continue;
      if (!existsFile(asset) || sha256File(asset) !== digest) fail(`${file} 与平台构建记录不一致`);
    }
    return value;
  });
  const source = manifests[0].source;
  if (source.client !== git('rev-parse', 'HEAD') ||
      source.shell !== git('rev-parse', 'HEAD:nuwa-electron-shell') ||
      source.frontend !== git('rev-parse', 'HEAD:nuwax')) {
    fail('构建来源与当前发布 tag 的 gitlink 不一致');
  }
  for (const manifest of manifests.slice(1)) {
    for (const name of ['client', 'shell', 'frontend']) {
      if (manifest.source[name] !== source[name]) fail(`各平台 ${name} SHA 不一致`);
    }
  }
  const version = tag.replace(/^(electron|prerelease)-v/, '');
  for (const filename of [`Nuwax-${version}-arm64.dmg`, `Nuwax-${version}.dmg`, `Nuwax.Setup.${version}.exe`]) {
    try { if (!statSync(join(dir, filename)).isFile()) fail(`缺少已签名资产 ${filename}`); }
    catch { fail(`缺少已签名资产 ${filename}`); }
  }
  const assets = Object.fromEntries(filesIn(dir)
    .filter((file) => !file.startsWith('build-manifest-') && file !== 'release-provenance.json')
    .map((file) => [file.replaceAll('\\', '/'), sha256File(join(dir, file))]));
  const aggregate = { schemaVersion: 1, tag, source, builds: manifests, assets };
  writeFileSync(join(dir, 'release-provenance.json'), `${JSON.stringify(aggregate, null, 2)}\n`);
  console.log(`[release-provenance] ${tag}: 五个平台来源一致，${Object.keys(assets).length} 个资产已记录 SHA256`);
}

function existsFile(path) {
  try { return statSync(path).isFile(); }
  catch { return false; }
}

const [command, ...args] = process.argv.slice(2);
if (command === 'record') record(args);
else if (command === 'verify') verify(args);
else fail('用法: release-provenance.mjs <record|verify> ...');
