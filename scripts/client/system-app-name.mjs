import config from '../../client.config.mjs';

/** Keep installer/cache identities stable while configuring actual system labels. */
export function configureSystemAppName(build, { platform = process.platform, arch = process.arch, product = config.product, macStringsFile = 'build/InfoPlist.strings' } = {}) {
  if (!['darwin', 'win32', 'linux'].includes(platform) || !['arm64', 'x64'].includes(arch)) {
    throw new Error('[branding] Unsupported platform or architecture');
  }
  // Builder 25 spreads linux.desktop directly; nested entry is not a name field.
  const { entry = {}, ...desktop } = build.linux?.desktop ?? {};
  const result = {
    ...build,
    productName: product.name,
    extraMetadata: { ...build.extraMetadata, productName: product.name },
    mac: { ...build.mac, extendInfo: { ...build.mac?.extendInfo,
      CFBundleName: product.name, CFBundleDisplayName: product.name } },
    nsis: { ...build.nsis, shortcutName: product.displayName },
    msi: { ...build.msi, shortcutName: product.displayName },
    linux: { ...build.linux, desktop: { ...entry, ...desktop, Name: product.displayName } },
  };
  delete result.mac.extendInfo.CFBundleIdentifier;
  if (platform === 'darwin') {
    // Finder localizes only when the base CFBundleDisplayName matches Nuwax.app.
    // The localized keys provide the real system label; helpers retain their
    // matching ASCII CFBundleName and existing update/install paths.
    // Electron also creates zh_CN/zh_TW. Finder may prefer those directories
    // over zh-Hans/zh-Hant and ignores the fallback name when they are empty.
    const locales = new Set(['Base', 'en', 'zh-Hans', 'zh-Hant', 'zh_CN', 'zh_TW', ...(build.electronLanguages ?? [])]);
    const targets = [...locales].map(locale => `${locale}.lproj/InfoPlist.strings`);
    const existing = build.mac?.extraResources ?? [];
    result.mac.extraResources = [...(Array.isArray(existing) ? existing : [existing])
      .filter(entry => typeof entry === 'string' || !targets.includes(entry.to)),
      ...targets.map(to => ({ from: macStringsFile, to }))];
  }
  return result;
}
