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

// Authenticode adds a certificate table and may update only the PE checksum and
// certificate-directory fields. Hash the original PE bytes with those fields
// masked so the signed installer can be tied to the exact CI-built unsigned EXE
// even after the signer removes the unsigned Release asset.
function peSigningIdentity(path, unsignedSize = undefined) {
  const size = statSync(path).size;
  const fd = openSync(path, 'r');
  try {
    const readAt = (offset, length) => {
      if (offset < 0 || length < 0 || offset + length > size) fail(`${basename(path)} 的 PE 头越界`);
      const bytes = Buffer.alloc(length);
      if (readSync(fd, bytes, 0, length, offset) !== length) fail(`${basename(path)} 的 PE 头读取失败`);
      return bytes;
    };
    const dos = readAt(0, 64);
    if (dos.toString('ascii', 0, 2) !== 'MZ') fail(`${basename(path)} 不是 PE 可执行文件`);
    const peOffset = dos.readUInt32LE(0x3c);
    const coff = readAt(peOffset, 24);
    if (coff.toString('ascii', 0, 4) !== 'PE\0\0') fail(`${basename(path)} 的 PE 签名无效`);
    const optionalOffset = peOffset + 24;
    const optionalSize = coff.readUInt16LE(20);
    const optional = readAt(optionalOffset, optionalSize);
    const magic = optional.readUInt16LE(0);
    const directoryOffset = magic === 0x20b ? 112 : magic === 0x10b ? 96 : -1;
    if (directoryOffset < 0 || optionalSize < directoryOffset + 40 ||
        optional.readUInt32LE(directoryOffset - 4) < 5) {
      fail(`${basename(path)} 缺少 PE 证书目录`);
    }
    const checksumOffset = optionalOffset + 64;
    const certificateDirectoryOffset = optionalOffset + directoryOffset + 32;
    const certificateOffset = optional.readUInt32LE(directoryOffset + 32);
    const certificateSize = optional.readUInt32LE(directoryOffset + 36);
    const signed = unsignedSize !== undefined;
    if (signed) {
      if (!Number.isSafeInteger(unsignedSize) || unsignedSize < optionalOffset + optionalSize ||
          certificateOffset < unsignedSize || certificateOffset - unsignedSize > 7 ||
          certificateOffset % 8 !== 0 || certificateSize < 8 ||
          certificateOffset + certificateSize !== size) {
        fail(`${basename(path)} 的签名证书不是追加在已验未签名文件之后`);
      }
      const padding = readAt(unsignedSize, certificateOffset - unsignedSize);
      if (padding.some((byte) => byte !== 0)) fail(`${basename(path)} 的签名填充含非零字节`);
    } else if (certificateOffset !== 0 || certificateSize !== 0) {
      fail(`${basename(path)} 的 CI 原始文件已有签名证书`);
    }
    const length = unsignedSize ?? size;
    const ignored = [[checksumOffset, 4], [certificateDirectoryOffset, 8]];
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (let offset = 0; offset < length;) {
      const count = Math.min(buffer.length, length - offset);
      if (readSync(fd, buffer, 0, count, offset) !== count) fail(`${basename(path)} 读取失败`);
      for (const [start, width] of ignored) {
        const from = Math.max(start, offset);
        const to = Math.min(start + width, offset + count);
        if (from < to) buffer.fill(0, from - offset, to - offset);
      }
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    return { unsignedSize: length, signingIdentitySha256: hash.digest('hex') };
  } finally { closeSync(fd); }
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
  if (platform === 'windows') {
    manifest.windowsSigning = peSigningIdentity(join(output, requiredArtifacts(tag, 'windows-x64')[0]));
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
  const windowsSigning = manifests.find((value) => value.platform === 'windows').windowsSigning;
  if (!Number.isSafeInteger(windowsSigning?.unsignedSize) || windowsSigning.unsignedSize <= 0 ||
      !/^[0-9a-f]{64}$/.test(windowsSigning?.signingIdentitySha256 ?? '')) {
    fail('Windows 构建记录缺少未签名 EXE 的签名不变来源证明');
  }
  const unsignedExe = join(dir, `Nuwax-Setup-${version}-unsigned.exe`);
  if (existsFile(unsignedExe)) {
    const actualUnsigned = peSigningIdentity(unsignedExe);
    if (actualUnsigned.unsignedSize !== windowsSigning.unsignedSize ||
        actualUnsigned.signingIdentitySha256 !== windowsSigning.signingIdentitySha256) {
      fail('Release 未签名 EXE 与 Windows 构建记录不一致');
    }
  }
  const signedExe = join(dir, `Nuwax.Setup.${version}.exe`);
  if (peSigningIdentity(signedExe, windowsSigning.unsignedSize).signingIdentitySha256 !==
      windowsSigning.signingIdentitySha256) {
    fail('签名版 EXE 的原始 PE 字节与 CI 未签名构建不一致');
  }
  for (const filename of ['latest.json', 'latest.yml', 'latest-mac.yml',
    'latest-linux.yml', 'latest-linux-arm64.yml', 'latest-linux-x64.yml']) {
    if (!existsFile(join(dir, filename))) fail(`缺少最终更新元数据 ${filename}`);
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
