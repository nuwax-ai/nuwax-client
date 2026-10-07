'use strict';

const path = require('node:path');

const ENV_KEY = 'NUWAX_WINDOWS_INSTALLER_ARCHIVE';
const SUPPORTED_BUILDER_VERSION = '25.1.8';
const ZIP_OPTIONS = Object.freeze({ differentialPackage: false, useZip: true });

function resolveInstallerArchiveMode({ env = process.env, platform } = {}) {
  const mode = env[ENV_KEY];
  if (mode == null || mode === '') return '';
  if (mode !== 'zip-qa') throw new Error(`[installer-archive] Unknown ${ENV_KEY} mode: ${mode}`);
  if (platform !== 'win32') throw new Error('[installer-archive] zip-qa requires an exclusive Windows build target');
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
  }
}

function applyInstallerArchivePolicy(config, { env = process.env, platform, builderVersions, argv = [] } = {}) {
  if (!resolveInstallerArchiveMode({ env, platform })) return config;
  if (builderVersions?.electronBuilder !== SUPPORTED_BUILDER_VERSION || builderVersions?.appBuilderLib !== SUPPORTED_BUILDER_VERSION) {
    throw new Error(`[installer-archive] zip-qa requires installed electron-builder and app-builder-lib ${SUPPORTED_BUILDER_VERSION}`);
  }
  if (config.nsis != null && (typeof config.nsis !== 'object' || Array.isArray(config.nsis))) {
    throw new Error('[installer-archive] zip-qa requires an object nsis configuration');
  }
  const nsis = config.nsis ?? {};
  for (const [key, expected] of Object.entries(ZIP_OPTIONS)) {
    if (Object.hasOwn(nsis, key) && nsis[key] !== expected) {
      throw new Error(`[installer-archive] Conflicting configured nsis.${key} for zip-qa`);
    }
  }
  checkCliOverrides(argv);
  // 只改变成对的归档选项；资源、目标、版本、签名与发布字段原样保留。
  return { ...config, nsis: { ...nsis, ...ZIP_OPTIONS } };
}

function installerArchiveCliArgs(config, options) {
  if (applyInstallerArchivePolicy(config, options) === config) return [];
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
  return [
    '--config.nsis.differentialPackage=false',
    '--config.nsis.useZip=true',
  ];
}

module.exports = {
  ENV_KEY,
  SUPPORTED_BUILDER_VERSION,
  resolveInstallerArchiveMode,
  resolveBuilderPlatform,
  installedBuilderVersions,
  applyInstallerArchivePolicy,
  installerArchiveCliArgs,
};
