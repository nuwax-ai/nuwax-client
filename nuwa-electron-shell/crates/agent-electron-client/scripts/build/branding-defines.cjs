/** Main/preload and renderer must agree on data paths; production never inherits a dev profile. */
function brandingDefines(env, development) {
  return Object.fromEntries(Object.entries({
    NUWAX_APP_IDENTIFIER: env.NUWAX_APP_IDENTIFIER ?? '',
    NUWAX_APP_DISPLAY_NAME: env.NUWAX_APP_DISPLAY_NAME ?? '',
    NUWAX_UPDATE_FEED_BASE: env.NUWAX_UPDATE_FEED_BASE ?? '',
    NUWAX_DOWNLOAD_PAGE_URL: env.NUWAX_DOWNLOAD_PAGE_URL ?? '',
    NUWAX_PORT_OFFSET: env.NUWAX_PORT_OFFSET ?? '0',
    NUWAX_RELEASE_CHANNEL: env.NUWAX_RELEASE_CHANNEL ?? 'stable',
    NUWAX_DEV_PROFILE: development && env.NUWAX_DEV_PROFILE === '1' ? '1' : '',
  }).map(([key, value]) => [`process.env.${key}`, JSON.stringify(value)]));
}

module.exports = { brandingDefines };
