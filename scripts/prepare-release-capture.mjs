#!/usr/bin/env node
/** Release workflows use the same locked resource admission as local pack.
 * The notices under third-party/capture cover capture only, not the whole app. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from './client/core.mjs';
import { assertCaptureWindowsToolchain, inspectCaptureResource, prepareCaptureResources, sha256, writeCaptureNotices } from './client/capture-resources.mjs';
import { CAPTURE_RESOURCE_FILES } from './client/capture-window-resources.mjs';

export const WINDOWS_RUNTIME_VERSION = '13.0.0.r354.g40ab95d18-1';
// Downloaded from the official archive and checked against .PKGINFO. Pacman's
// trusted MSYS2 keyring also verifies their detached signatures before install.
export const WINDOWS_RUNTIME_PACKAGES = [
  { name: 'mingw-w64-x86_64-libwinpthread', sha256: '433ebcc00e0a8cad46eea7ba78096bc19f018b5b887b5fb8b66887965338bef0' },
  { name: 'mingw-w64-x86_64-winpthreads', sha256: '076d92f9320191aa2da5d754f0422ead1fc2851d692d693a0367a225be09843e' },
].map((entry) => ({ ...entry, archive: `${entry.name}-${WINDOWS_RUNTIME_VERSION}-any.pkg.tar.zst` }));

export function releaseCapturePaths(root, platform, arch) {
  return {
    packageFile: path.join(core.paths(root).client, 'package.json'),
    noticesDir: path.join(core.paths(root).cache, 'release-capture-notices', `${platform}-${arch}`),
    signingDir: path.join(core.paths(root).cache, 'release-capture-signed', `${platform}-${arch}`),
  };
}

/** A fresh MSYS2 image may contain a newer runtime than our source declaration.
 * Install both split packages at the audited version, never relabel latest. */
export async function configureWindowsCaptureToolchain(root, { location, arch, tools = core, env = process.env, hash = sha256 } = {}) {
  if (arch !== 'x64' || !location) throw new Error('[release-capture] Windows CI requires an explicit MSYS2 x64 installation');
  const manifest = tools.readJson(path.join(root, 'third-party/manifest.json'));
  const runtime = manifest.resources?.capture?.components?.find((entry) => entry.id === 'winpthreads');
  if (runtime?.toolchainPackageVersion !== WINDOWS_RUNTIME_VERSION) throw new Error('[release-capture] Update the audited Windows package lock together with the source declaration');
  const shell = path.join(location, 'usr/bin/bash.exe');
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = [path.join(location, 'mingw64/bin'), path.join(location, 'usr/bin'), env[pathKey] || ''].join(';');
  env.NUWAX_CAPTURE_BUILD_BASH = shell;
  env.MSYSTEM = 'MINGW64';
  const downloads = path.join(core.paths(root).cache, 'capture/windows-runtime');
  fs.mkdirSync(downloads, { recursive: true });
  const files = [];
  for (const entry of WINDOWS_RUNTIME_PACKAGES) {
    const file = path.join(downloads, entry.archive);
    const url = `https://repo.msys2.org/mingw/mingw64/${entry.archive}`;
    for (const suffix of ['', '.sig']) await tools.run('curl', ['--fail', '--location', '--retry', '4', '--retry-all-errors', `${url}${suffix}`, '--output', `${file}${suffix}`], { env, capture: true });
    if (hash(file) !== entry.sha256) throw new Error(`[release-capture] Windows runtime archive SHA256 mismatch: ${entry.archive}`);
    files.push(file);
  }
  // Use libalpm's transaction signature verification, not pacman-key --verify:
  // recent MSYS2 keyrings omit lock-never but that wrapper still requires it.
  // Local packages default to optional signatures, so explicitly require both
  // valid signatures and trusted keys before the transaction may install either.
  const signatureConfig = path.join(downloads, 'pacman-capture.conf');
  fs.writeFileSync(signatureConfig, '[options]\nArchitecture = auto\nSigLevel = Required TrustedOnly\nLocalFileSigLevel = Required TrustedOnly\n');
  await tools.run(shell, ['-c', 'config=$(cygpath -u "$1"); shift; packages=(); for file in "$@"; do packages+=("$(cygpath -u "$file")"); done; exec pacman --config "$config" -U --noconfirm "${packages[@]}"', 'capture-runtime-install', signatureConfig, ...files], { env, capture: true });
  await assertCaptureWindowsToolchain({ shell, arch, tools, runtimePackageVersion: WINDOWS_RUNTIME_VERSION });
  return shell;
}

function isCaptureEntry(entry) {
  return typeof entry === 'object' && entry !== null && /^(?:capture(?:\/|$)|third-party\/capture(?:\/|$))/.test(entry.to ?? '');
}

export function captureMacSignIgnore(arch) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error('[release-capture] Unsupported macOS signing architecture');
  return `/Contents/Resources/capture/darwin-${arch}/(?:ffmpeg|koffi\\.node)$`;
}

/** Signing changes Mach-O bytes. Sign only an independent copy, then record
 * those final bytes and keep builder's force-sign pass away from this file. */
export async function stageSignedCaptureResource(root, admitted, { arch, identity, keychain, tools = core } = {}) {
  if (!identity) throw new Error('[release-capture] Signed macOS capture requires an explicit signing identity');
  const { signingDir } = releaseCapturePaths(root, 'darwin', arch);
  const sourceRecordFile = path.join(admitted.dir, 'resource.json');
  const sourceHash = sha256(admitted.binary), sourceRecordHash = sha256(sourceRecordFile);
  if (sourceHash !== admitted.record.sha256) throw new Error('[release-capture] Admitted source changed before signing');
  fs.rmSync(signingDir, { recursive: true, force: true });
  fs.mkdirSync(signingDir, { recursive: true });
  const binary = path.join(signingDir, 'ffmpeg');
  fs.copyFileSync(admitted.binary, binary);
  fs.chmodSync(binary, 0o755);
  const args = ['--force', '--sign', identity, '--options', 'runtime', identity === '-' ? '--timestamp=none' : '--timestamp'];
  if (keychain) args.push('--keychain', keychain);
  await tools.run('codesign', [...args, binary], { capture: true });
  await tools.run('codesign', ['--verify', '--strict', '--verbose=2', binary], { capture: true });
  if (sha256(admitted.binary) !== sourceHash || sha256(sourceRecordFile) !== sourceRecordHash) throw new Error('[release-capture] Source cache changed during signing');
  const record = { ...admitted.record, sha256: sha256(binary), signing: { sourceHash, identity } };
  tools.atomicJson(path.join(signingDir, 'resource.json'), record);
  const nativeSource = path.join(admitted.dir, 'koffi.node');
  if (fs.existsSync(nativeSource)) {
    const nativeRecord = tools.readJson(path.join(admitted.dir, 'koffi.json'));
    const sourceHash = sha256(nativeSource);
    if (nativeRecord.schema !== 1 || nativeRecord.sha256 !== sourceHash) throw new Error('[release-capture] Koffi source changed before signing');
    const native = path.join(signingDir, 'koffi.node');
    fs.copyFileSync(nativeSource, native);
    await tools.run('codesign', [...args, native], { capture: true });
    await tools.run('codesign', ['--verify', '--strict', '--verbose=2', native], { capture: true });
    if (sha256(nativeSource) !== sourceHash) throw new Error('[release-capture] Koffi source changed during signing');
    tools.atomicJson(path.join(signingDir, 'koffi.json'), { ...nativeRecord, sha256: sha256(native), signing: { sourceHash, identity } });
  }
  return { dir: signingDir, binary, record };
}

export function injectReleaseCapture(builder, { captureDir, noticesDir, platform, arch, macPreSigned = false }) {
  const result = structuredClone(builder ?? {});
  // Remove stale platform-specific entries too; leave all other notices intact.
  for (const config of [result, result.mac, result.win, result.linux]) {
    if (config?.extraResources) config.extraResources = config.extraResources.filter((entry) => !isCaptureEntry(entry));
  }
  if (result.mac?.signIgnore) {
    const previous = Array.isArray(result.mac.signIgnore) ? result.mac.signIgnore : [result.mac.signIgnore];
    result.mac.signIgnore = previous.filter((pattern) => !['arm64', 'x64'].some((target) => pattern === captureMacSignIgnore(target)));
  }
  if (platform === 'darwin' && macPreSigned) {
    result.mac ??= {};
    result.mac.signIgnore = [...(result.mac.signIgnore ?? []), captureMacSignIgnore(arch)];
  }
  result.extraResources ??= [];
  result.extraResources.push(
    { from: captureDir, to: `capture/${platform}-${arch}`, filter: CAPTURE_RESOURCE_FILES },
    { from: noticesDir, to: 'third-party/capture', filter: ['third-party-notices.json', 'licenses/**', 'sources/**'] },
  );
  return result;
}

export async function prepareReleaseCapture(root, {
  platform = process.platform, arch = process.arch, nativePlatform = process.platform, nativeArch = process.arch,
  msys2Location = process.env.MSYS2_LOCATION, tools = core, prepare = prepareCaptureResources,
  inspect = inspectCaptureResource, notices = writeCaptureNotices, configureWindows = configureWindowsCaptureToolchain,
  macSigning = process.env.NUWAX_CAPTURE_MAC_SIGNING === 'true', signIdentity = process.env.APPLE_SIGNING_IDENTITY,
  signKeychain = process.env.CSC_KEYCHAIN, stageSigned = stageSignedCaptureResource,
} = {}) {
  if (!['darwin', 'win32', 'linux'].includes(platform)) throw new Error('[release-capture] Unsupported platform');
  if (platform !== nativePlatform || arch !== nativeArch) throw new Error('[release-capture] Capture resources must build on a matching native runner');
  const files = releaseCapturePaths(root, platform, arch);
  const pkg = tools.readJson(files.packageFile);
  if (platform === 'win32') await configureWindows(root, { location: msys2Location, arch, tools });
  await prepare(root, { platform, arch });
  const admitted = await inspect(root, { platform, arch });
  if (!admitted) throw new Error('[release-capture] Missing or unverified encoding resource; refusing to package');
  const captureDir = platform === 'darwin' && macSigning
    ? (await stageSigned(root, admitted, { arch, identity: signIdentity, keychain: signKeychain, tools })).dir
    : admitted.dir;
  // Fresh output prevents stale licenses/sources from an earlier target.
  fs.rmSync(files.noticesDir, { recursive: true, force: true });
  await notices(root, { platform, arch, outDir: files.noticesDir });
  if (!fs.existsSync(path.join(files.noticesDir, 'third-party-notices.json'))) throw new Error('[release-capture] Capture notices were not generated');
  pkg.build = injectReleaseCapture(pkg.build, { captureDir, noticesDir: files.noticesDir, platform, arch, macPreSigned: platform === 'darwin' && macSigning });
  tools.atomicJson(files.packageFile, pkg);
  return { ...files, captureDir };
}

function resourceRoots(output) {
  const found = [];
  const visit = (dir, depth) => {
    if (fs.existsSync(path.join(dir, 'app.asar'))) { found.push(dir); return; }
    if (depth === 0) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(path.join(dir, entry.name), depth - 1);
    }
  };
  visit(path.resolve(output), 6);
  if (!found.length) throw new Error('[release-capture] Packaged app resources were not found in build output');
  return found;
}

function verifyCopy(source, target, { executable = false } = {}) {
  if (!fs.existsSync(target) || !fs.statSync(target).isFile() || sha256(source) !== sha256(target)) throw new Error(`[release-capture] Packaged resource missing or changed: ${target}`);
  if (executable && process.platform !== 'win32' && !(fs.statSync(target).mode & 0o111)) throw new Error(`[release-capture] Packaged encoder is not executable: ${target}`);
}

function verifyTree(source, target) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(target, entry.name);
    if (entry.isDirectory()) verifyTree(from, to);
    else if (entry.isFile()) verifyCopy(from, to);
    else throw new Error(`[release-capture] Unexpected notice symlink: ${from}`);
  }
}

/** Check the real default runtime resource path after builder, before upload. */
export async function verifyReleaseCaptureOutput(root, output, { platform = process.platform, arch = process.arch, inspect = inspectCaptureResource, tools = core } = {}) {
  const roots = resourceRoots(output);
  const admitted = await inspect(root, { platform, arch });
  if (!admitted) throw new Error('[release-capture] Source encoding resource is no longer verified');
  const { noticesDir, signingDir, packageFile } = releaseCapturePaths(root, platform, arch);
  let expected = admitted;
  if (platform === 'darwin') {
    const builder = tools.readJson(packageFile).build;
    const entry = builder?.extraResources?.find((resource) => resource.to === `capture/darwin-${arch}`);
    if (entry && path.resolve(core.paths(root).client, entry.from) === signingDir) {
      const record = tools.readJson(path.join(signingDir, 'resource.json'));
      const binary = path.join(signingDir, 'ffmpeg');
      const unsigned = { ...record, sha256: record.signing?.sourceHash };
      delete unsigned.signing;
      if (JSON.stringify(unsigned) !== JSON.stringify(admitted.record) || sha256(binary) !== record.sha256 || !record.signing?.identity) throw new Error('[release-capture] Signed capture staging no longer matches the admitted source');
      const ignores = Array.isArray(builder.mac?.signIgnore) ? builder.mac.signIgnore : [builder.mac?.signIgnore];
      if (!ignores.includes(captureMacSignIgnore(arch))) throw new Error('[release-capture] Signed capture is not protected from builder re-signing');
      await tools.run('codesign', ['--verify', '--strict', '--verbose=2', binary], { capture: true });
      expected = { dir: signingDir, binary, record };
    }
  }
  const noticeFile = path.join(noticesDir, 'third-party-notices.json');
  if (!fs.existsSync(noticeFile)) throw new Error('[release-capture] Expected capture notices are missing');
  for (const resources of roots) {
    const capture = path.join(resources, 'capture', `${platform}-${arch}`);
    verifyCopy(expected.binary, path.join(capture, platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'), { executable: platform !== 'win32' });
    verifyCopy(path.join(expected.dir, 'resource.json'), path.join(capture, 'resource.json'));
    if (fs.existsSync(path.join(admitted.dir, 'koffi.node'))) {
      const record = tools.readJson(path.join(expected.dir, 'koffi.json'));
      const native = path.join(expected.dir, 'koffi.node');
      const source = tools.readJson(path.join(admitted.dir, 'koffi.json'));
      if (sha256(native) !== record.sha256 || record.version !== source.version || record.platform !== platform || record.arch !== arch
        || (expected.dir !== admitted.dir && record.signing?.sourceHash !== source.sha256)) throw new Error('[release-capture] Koffi staging no longer matches admitted source');
      verifyCopy(native, path.join(capture, 'koffi.node'));
      verifyCopy(path.join(expected.dir, 'koffi.json'), path.join(capture, 'koffi.json'));
    }
    verifyTree(noticesDir, path.join(resources, 'third-party/capture'));
  }
  return { roots, capture: true };
}

async function main() {
  const argv = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = argv.indexOf(name);
    if (index < 0) return fallback;
    if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
    return argv[index + 1];
  };
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const options = { arch: option('--arch', process.arch) };
  const output = option('--verify-output', null);
  const result = output ? await verifyReleaseCaptureOutput(root, output, options) : await prepareReleaseCapture(root, options);
  console.log(`[release-capture] ${output ? 'Verified packaged resources' : 'Prepared locked encoding resource and capture-only notices'}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
