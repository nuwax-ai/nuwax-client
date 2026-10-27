/** Cache identities contain build inputs only; product versions and signatures
 * are deliberately excluded. Cross-ref transport is handled by the trusted
 * artifact producer contract, never by broad restore-key fallbacks. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as core from './core.mjs';

// Recipe membership rule: only files whose bytes influence the PRODUCED
// artifacts may be listed. The transport/reporting layer
// (build-resource-artifacts.mjs, resource-report.mjs) moves and observes
// artifacts but never builds them — keeping it out of the recipes means
// observability/transport tweaks (annotations, log format, upload policy)
// no longer force a five-platform cold rebuild. When the staged file set or
// manifest admission contract changes instead, bump RESOURCE_STAGING_CONTRACT
// in core.mjs (a recipe member) to invalidate deliberately.
const HELPER_RECIPE = [
  'scripts/computer-use/build-helper.sh', 'scripts/client/native-build-cache.mjs', 'scripts/client/core.mjs',
  'docs/computer-use-poc/0001-0003-cua-nuwax-helper-bundle.patch',
];
const CAPTURE_RECIPE = [
  'scripts/client/native-build-cache.mjs', 'scripts/client/core.mjs',
  'scripts/client/capture-resources.mjs', 'scripts/client/capture-window-resources.mjs',
  'scripts/client/third-party-notices.mjs', 'scripts/prepare-release-capture.mjs',
  'third-party/capture-sources.json', 'third-party/capture-window-sources.json', 'third-party/manifest.json',
];

function recipe(root, files) {
  return files.map(file => {
    const digest = core.fileHash(path.join(root, file));
    if (!digest) throw new Error('[native-cache] Missing recipe input: ' + file);
    return [file, digest];
  });
}

function probe(command, args, options = {}) {
  const result = core.run(command, args, { capture: true, allowFailure: true, ...options });
  // rustup may install workspace components on the first successful version
  // probe. Its stderr progress is not compiler identity and disappears before
  // save-helper, which used to make restore/save choose different record names.
  // MSVC's no-argument version banner is the declared stderr/exit-2 exception.
  const output = (options.acceptBanner ? result.stdout + result.stderr : result.stdout).trim();
  if (!output || (result.status !== 0 && !(options.acceptBanner && result.status === 2))) throw new Error('[native-cache] Cannot identify compiler: ' + command);
  return output;
}

function buildEnvironment(env) {
  // Exclude registry/authentication variables; only compilation settings affect
  // these identities. Hash values rather than publishing environment contents.
  const keys = Object.keys(env).filter(key => /^(?:RUSTFLAGS|RUSTDOCFLAGS|RUSTC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|RUSTC_BOOTSTRAP|RUSTUP_TOOLCHAIN|CARGO_INCREMENTAL|CARGO_ENCODED_RUSTFLAGS|CARGO_BUILD_.*|CARGO_TARGET_.*|CARGO_PROFILE_RELEASE_.*|CC|CXX|AR|CFLAGS|CXXFLAGS|LDFLAGS|SDKROOT|MACOSX_DEPLOYMENT_TARGET|CPATH|LIBRARY_PATH|PKG_CONFIG.*|INCLUDE|LIB|VCToolsInstallDir|VCToolsVersion|WindowsSDKVersion|WindowsSdkDir)$/.test(key)).sort();
  return core.fingerprint(keys.map(key => [key, env[key]]));
}

function nativeTools(kind, env = process.env) {
  const targetArch = env.TARGET_ARCH || process.arch;
  if (targetArch !== process.arch) throw new Error('[native-cache] Native resources require a matching runner architecture');
  const common = { platform: process.platform, arch: targetArch, environment: buildEnvironment(env) };
  if (process.platform === 'darwin') {
    const sdk = probe('xcrun', ['--sdk', 'macosx', '--show-sdk-path']);
    return { ...common, sdk, sdkVersion: probe('xcrun', ['--sdk', 'macosx', '--show-sdk-version']),
      compiler: probe('xcrun', ['clang', '--version']), developer: probe('xcode-select', ['-p']),
      ...(kind === 'capture' ? { assembler: probe('nasm', ['-v']), pkgConfig: probe('pkg-config', ['--version']) } : {}) };
  }
  if (process.platform === 'win32' && kind === 'helper') {
    const programFiles = env['ProgramFiles(x86)'] || env.ProgramFiles;
    const locator = path.join(programFiles || '', 'Microsoft Visual Studio/Installer/vswhere.exe');
    const installation = JSON.parse(probe(locator, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-format', 'json']))[0];
    if (!installation?.installationPath) throw new Error('[native-cache] MSVC installation unavailable');
    const versionFile = path.join(installation.installationPath, 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt');
    const msvc = fs.readFileSync(versionFile, 'utf8').trim();
    const compiler = path.join(installation.installationPath, 'VC/Tools/MSVC', msvc, 'bin/Hostx64/x64/cl.exe');
    const includes = path.join(programFiles, 'Windows Kits/10/Include');
    return { ...common, visualStudio: installation.installationVersion, msvc, compiler: probe(compiler, [], { acceptBanner: true }),
      windowsSdks: fs.readdirSync(includes).filter(name => /^\d+\./.test(name)).sort() };
  }
  let environment = env;
  if (process.platform === 'win32') {
    if (!env.MSYS2_LOCATION) throw new Error('[native-cache] Explicit MSYS2 installation required');
    const key = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
    environment = { ...env, [key]: [path.join(env.MSYS2_LOCATION, 'mingw64/bin'), path.join(env.MSYS2_LOCATION, 'usr/bin'), env[key] || ''].join(';') };
  }
  const options = { env: environment };
  return { ...common, compiler: probe('gcc', ['--version'], options), target: probe('gcc', ['-dumpmachine'], options),
    linker: probe('ld', ['--version'], options), pkgConfig: probe('pkg-config', ['--version'], options),
    ...(kind === 'capture' ? { assembler: probe('nasm', ['-v'], options) } : {
      libraries: ['dbus-1', 'xkbcommon', 'x11', 'xi', 'xtst', 'xext'].map(name => [name, probe('pkg-config', ['--modversion', name], options)]),
    }) };
}

function rustTools(cwd) {
  return { rustc: probe('rustc', ['-vV'], { cwd }), cargo: probe('cargo', ['-vV'], { cwd }) };
}

export function nativeHelperResourceKey(root) {
  const helper = core.fingerprint({ schema: 1, recipe: recipe(root, HELPER_RECIPE), tools: nativeTools('helper'), rust: rustTools(root), sourceOverride: process.env.CUA_COMMIT || null });
  const suffix = process.platform + '-' + (process.env.TARGET_ARCH || process.arch);
  return `native-helper-v1-${suffix}-${helper}`;
}

export function nativeCacheKeys(root) {
  const helper = nativeHelperResourceKey(root);
  const capture = core.fingerprint({ schema: 1, recipe: recipe(root, CAPTURE_RECIPE), tools: nativeTools('capture') });
  const suffix = process.platform + '-' + (process.env.TARGET_ARCH || process.arch);
  return { helper, capture: `native-capture-v1-${suffix}-${capture}` };
}

function helperEntry(root, source, target) {
  const workspace = path.join(source, 'libs/cua-driver/rust');
  const lock = core.fileHash(path.join(workspace, 'Cargo.lock'));
  if (!lock) throw new Error('[native-cache] Cargo.lock is required');
  const sourceSha = core.git(source, ['rev-parse', 'HEAD']);
  const key = core.fingerprint({ schema: 1, sourceSha, target, features: ['portal-input'], profile: 'release', lock,
    recipe: recipe(root, HELPER_RECIPE), tools: nativeTools('helper'), rust: rustTools(workspace) });
  const directory = process.env.NUWAX_CUA_CACHE_DIR || path.join(core.paths(root).cache, 'cua-helper');
  return { key, sourceSha, binary: path.join(directory, key + '.bin'), record: path.join(directory, key + '.json') };
}

export function restoreHelper(root, source, target, destination) {
  const entry = helperEntry(root, source, target);
  const miss = reason => {
    console.warn('[native-cache] helper unsigned binary cache miss: ' + reason + '; expected key: ' + entry.key);
    return false;
  };
  let record;
  try {
    record = core.readJson(entry.record);
  } catch (error) {
    return miss(error.code === 'ENOENT' ? 'record_missing' : 'record_unreadable');
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return miss('record_invalid');
  if (record.schema !== 1) return miss('record_schema_mismatch');
  if (record.key !== entry.key) return miss('record_key_mismatch');
  if (record.sourceSha !== entry.sourceSha) return miss('source_revision_mismatch');
  if (!/^[a-f0-9]{64}$/.test(record.sha256 ?? '')) return miss('record_hash_invalid');
  let binaryStat;
  try {
    binaryStat = fs.lstatSync(entry.binary);
  } catch (error) {
    return miss(error.code === 'ENOENT' ? 'binary_missing' : 'binary_unreadable');
  }
  if (!binaryStat.isFile()) return miss('binary_not_regular_file');
  try {
    if (core.fileHash(entry.binary) !== record.sha256) return miss('binary_hash_mismatch');
  } catch {
    return miss('binary_hash_unreadable');
  }
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(entry.binary, destination);
    fs.chmodSync(destination, 0o755);
    console.log('[native-cache] helper unsigned binary hit: ' + entry.key);
    return true;
  } catch {
    return miss('restore_copy_failed');
  }
}

export function saveHelper(root, source, target, binary) {
  const entry = helperEntry(root, source, target);
  if (!fs.lstatSync(binary).isFile() || !fs.statSync(binary).size) throw new Error('[native-cache] Empty helper binary');
  fs.mkdirSync(path.dirname(entry.binary), { recursive: true });
  const partial = entry.binary + '.' + randomUUID() + '.tmp';
  try {
    fs.copyFileSync(binary, partial);
    fs.renameSync(partial, entry.binary);
    core.atomicJson(entry.record, { schema: 1, key: entry.key, sourceSha: entry.sourceSha, target, sha256: core.fileHash(entry.binary) });
  } finally { fs.rmSync(partial, { force: true }); }
  console.log('[native-cache] saved helper unsigned binary: ' + entry.key);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const [command, source, target, binary] = process.argv.slice(2);
  try {
    if (command === 'keys' && process.argv.length === 3) {
      for (const [name, key] of Object.entries(nativeCacheKeys(root))) console.log(name + '=' + key);
    } else if (command === 'helper-resource-key' && process.argv.length === 3) {
      console.log(nativeHelperResourceKey(root));
    } else if (['restore-helper', 'save-helper'].includes(command) && process.argv.length === 6) {
      if (command === 'save-helper') saveHelper(root, source, target, binary);
      else if (!restoreHelper(root, source, target, binary)) process.exitCode = 2;
    } else throw new Error('usage: native-build-cache.mjs keys | helper-resource-key | restore-helper|save-helper SOURCE TARGET BINARY');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
