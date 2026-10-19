'use strict';

const path = require('node:path');

const ENV_KEY = 'NUWAX_WINDOWS_INSTALLER_ARCHIVE';
const SUPPORTED_BUILDER_VERSION = '25.1.8';
const ZIP_OPTIONS = Object.freeze({ differentialPackage: false, useZip: true });
const SEVEN_ZIP_OPTIONS = Object.freeze({ differentialPackage: true, useZip: false });
const BLOCKMAP_HOOK = path.join(__dirname, 'installer-blockmap.cjs');
const LEGACY_BLOCKMAP_HOOK = 'scripts/build/installer-blockmap.cjs';

function resolveInstallerArchiveMode({ env = process.env, platform } = {}) {
  const mode = env[ENV_KEY];
  if (mode == null || mode === '') return platform === 'win32' ? 'zip' : '';
  if (!['zip-qa', '7z-qa'].includes(mode)) throw new Error(`[installer-archive] Unknown ${ENV_KEY} mode: ${mode}`);
  if (platform !== 'win32') throw new Error('[installer-archive] QA archive mode requires an exclusive Windows build target');
  return mode;
}

function resolveBuilderPlatform(argv, hostPlatform = process.platform) {
  const targets = new Set();
  for (const arg of argv) {
    if (/^--(?:mac|macos)(?:=|$)/.test(arg)) targets.add('darwin');
    if (/^--linux(?:=|$)/.test(arg)) targets.add('linux');
    if (/^--(?:win|windows)(?:=|$)/.test(arg)) targets.add('win32');
    if (/^-[mowl]+$/.test(arg)) {
      for (const flag of arg.slice(1)) targets.add(flag === 'w' ? 'win32' : flag === 'l' ? 'linux' : 'darwin');
    }
  }
  return targets.size === 0 ? hostPlatform : targets.size === 1 ? [...targets][0] : 'mixed';
}

function installedBuilderVersions(projectRoot) {
  const builderFile = require.resolve('electron-builder/package.json', { paths: [projectRoot] });
  const libraryFile = require.resolve('app-builder-lib/package.json', { paths: [path.dirname(builderFile)] });
  return { electronBuilder: require(builderFile).version, appBuilderLib: require(libraryFile).version };
}

function checkCliOverrides(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') throw new Error('[installer-archive] zip-qa cannot use the CLI terminator');
    // yargs also accepts short aliases with two dashes (e.g. --p=always).
    // QA callers use the documented long name or a supported single-dash form.
    if (/^--(?:[A-Za-z]|no-[A-Za-z])(?:[.=]|$)/.test(arg)) {
      throw new Error('[installer-archive] zip-qa cannot use long spellings of short aliases');
    }
    if (/^-[^-]/.test(arg) && !/^-([mowl]+)$/.test(arg) && !/^-p(?:=|$)/.test(arg) && !/^-c(?:\.|=|$)/.test(arg)) {
      throw new Error('[installer-archive] zip-qa cannot use unsupported short argument groups');
    }
    // 外部配置文件或整个 nsis 对象无法在此确认，不猜测它们是否覆盖归档组合。
    if (/^(?:--config|-c)(?:=|$)/.test(arg) || /^(?:--config|-c)\.nsis(?:=|$)/.test(arg)) {
      throw new Error('[installer-archive] zip-qa cannot combine with an external config or whole nsis override');
    }
    // 重复配置即使值相同，也会被 builder 解析成数组；归档参数只能由策略注入一次。
    if (/^(--(?:no-)?config|-c)\.nsis\.(differentialPackage|useZip)(?:=|$)/.test(arg)) {
      throw new Error('[installer-archive] zip-qa policy owns the archive CLI pair');
    }
    if (/^(--(?:no-)?config|-c)\.afterAllArtifactBuild(?:=|$)/.test(arg)) {
      throw new Error('[installer-archive] policy owns the installer blockmap hook');
    }
  }
}

function applyInstallerArchivePolicy(config, { env = process.env, platform, builderVersions, argv = [], hook = BLOCKMAP_HOOK } = {}) {
  const mode = resolveInstallerArchiveMode({ env, platform });
  if (!mode) return config;
  if (builderVersions?.electronBuilder !== SUPPORTED_BUILDER_VERSION || builderVersions?.appBuilderLib !== SUPPORTED_BUILDER_VERSION) {
    throw new Error(`[installer-archive] Windows archive policy requires installed electron-builder and app-builder-lib ${SUPPORTED_BUILDER_VERSION}`);
  }
  if (config.nsis != null && (typeof config.nsis !== 'object' || Array.isArray(config.nsis))) {
    throw new Error('[installer-archive] zip-qa requires an object nsis configuration');
  }
  const nsis = config.nsis ?? {};
  const options = mode === '7z-qa' ? SEVEN_ZIP_OPTIONS : ZIP_OPTIONS;
  for (const [key, expected] of Object.entries(options)) {
    if (Object.hasOwn(nsis, key) && nsis[key] !== expected) {
      throw new Error(`[installer-archive] Conflicting configured nsis.${key} for zip-qa`);
    }
  }
  if (mode !== '7z-qa' && config.afterAllArtifactBuild && ![hook, BLOCKMAP_HOOK, LEGACY_BLOCKMAP_HOOK].includes(config.afterAllArtifactBuild)) {
    throw new Error('[installer-archive] Compose the existing afterAllArtifactBuild hook before replacing it');
  }
  checkCliOverrides(argv);
  // ZIP 直接解压到目标目录；EXE 的独立 blockmap 保留更新器的差分下载协议。
  return { ...config, nsis: { ...nsis, ...options }, ...(mode === '7z-qa' ? {} : { afterAllArtifactBuild: hook }) };
}

function installerArchiveCliArgs(config, options) {
  const mode = resolveInstallerArchiveMode(options);
  if (applyInstallerArchivePolicy(config, options) === config) return [];
  const archiveArgs = mode === '7z-qa'
    ? ['--config.nsis.differentialPackage=true', '--config.nsis.useZip=false']
    : ['--config.nsis.differentialPackage=false', '--config.nsis.useZip=true', `--config.afterAllArtifactBuild=${LEGACY_BLOCKMAP_HOOK}`];
  if (mode === 'zip') return archiveArgs;
  let publishCount = 0;
  const argv = options.argv ?? [];
  for (let i = 0; i < argv.length; i++) {
    const publish = /^(?:--publish|-p)(?:=(.*))?$/.exec(argv[i]);
    if (!publish) {
      if (/^(?:--no-publish|-p.+)$/.test(argv[i])) throw new Error('[installer-archive] zip-qa requires explicit --publish never');
      continue;
    }
    if (++publishCount > 1) throw new Error('[installer-archive] zip-qa requires exactly one publish argument');
    const value = publish[1] === undefined ? argv[++i] : publish[1];
    if (value !== 'never') throw new Error('[installer-archive] zip-qa requires every publish argument to be never');
  }
  // QA 归档不得依赖 CI/tag 自动发布策略，且不靠追加参数覆盖调用方的冲突。
  if (publishCount !== 1) throw new Error('[installer-archive] zip-qa requires explicit --publish never');
  return archiveArgs;
}

module.exports = {
  ENV_KEY,
  SUPPORTED_BUILDER_VERSION,
  BLOCKMAP_HOOK,
  LEGACY_BLOCKMAP_HOOK,
  resolveInstallerArchiveMode,
  resolveBuilderPlatform,
  installedBuilderVersions,
  applyInstallerArchivePolicy,
  installerArchiveCliArgs,
};
