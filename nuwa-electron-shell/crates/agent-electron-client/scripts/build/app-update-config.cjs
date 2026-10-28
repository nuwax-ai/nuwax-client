const fs = require('node:fs');
const path = require('node:path');

const CACHE_NAME = 'nuwax-updater';
const HOOK = 'scripts/build/app-update-config.cjs';

function updateConfig(feedBase) {
  const url = new URL(feedBase);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('[app-update] Expected a public HTTPS update feed');
  }
  return { provider: 'generic', url: url.href.replace(/\/$/, ''), updaterCacheDirName: CACHE_NAME };
}

function configBytes(feedBase) {
  const config = updateConfig(feedBase);
  // FpmTarget rewrites this file after afterPack for deb/rpm. Match the locked
  // builder's serializeToYaml output so equivalent bytes survive that phase.
  // URL() normalizes whitespace; public HTTPS URLs are safe YAML plain scalars.
  return Buffer.from(`provider: generic\nurl: ${config.url}\nupdaterCacheDirName: ${CACHE_NAME}\n`);
}

function configureUpdater(build, { feedBase, hook = HOOK } = {}) {
  if (build.afterPack && build.afterPack !== hook && build.afterPack !== HOOK) throw new Error('[app-update] Compose the existing afterPack hook before replacing it');
  const config = updateConfig(feedBase);
  // Runtime chooses its channel from latest.json and sets updater.channel itself.
  // Builder's prerelease inference would add channel=beta/dev during late FPM
  // rewrites, producing different app-update.yml on different platforms.
  const result = { ...build, detectUpdateChannel: false, publish: [{ provider: config.provider, url: config.url }], afterPack: hook };
  // A platform override must not replace the commercial provider/cache identity.
  for (const platform of ['mac', 'win', 'linux']) {
    if (result[platform]) {
      result[platform] = { ...result[platform], detectUpdateChannel: false };
      delete result[platform].publish;
    }
  }
  return result;
}

function verifyResources(resources, feedBase) {
  const file = path.join(resources, 'app-update.yml');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile() || !fs.readFileSync(file).equals(configBytes(feedBase))) {
    throw new Error(`[app-update] Missing or incorrect update configuration: ${file}`);
  }
  return file;
}

// electron-builder calls the user afterPack handler after its own PublishManager
// and before code signing. Its built-in handler skips macOS --dir entirely.
async function afterPack(context) {
  const { packager, appOutDir } = context;
  const publish = packager.config.publish;
  if (!Array.isArray(publish) || publish.length !== 1 || publish[0].provider !== 'generic'
      || packager.appInfo.updaterCacheDirName !== CACHE_NAME) {
    throw new Error('[app-update] Expected commercial feed and isolated nuwax-updater cache');
  }
  const resources = packager.getResourcesDir(appOutDir);
  fs.writeFileSync(path.join(resources, 'app-update.yml'), configBytes(publish[0].url));
  verifyResources(resources, publish[0].url);
  if (context.electronPlatformName === 'win32') {
    require('./uninstall-payload.cjs').writeUninstallPayload(context);
  }
}

module.exports = afterPack;
Object.assign(module.exports, { CACHE_NAME, HOOK, updateConfig, configBytes, configureUpdater, verifyResources });
