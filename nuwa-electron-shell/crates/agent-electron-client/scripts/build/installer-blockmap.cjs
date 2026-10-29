'use strict';

const fs = require('node:fs');
const { createRequire } = require('node:module');
const crypto = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const { installedBuilderVersions, SUPPORTED_BUILDER_VERSION } = require('./installer-archive-policy.cjs');

// ZIP disables builder's differential-aware 7z container, which also suppresses
// its EXE blockmap. The updater accepts an external blockmap for either format.
module.exports = async function installerBlockmaps(context) {
  const options = context.configuration.nsis;
  if (options?.useZip !== true || options.differentialPackage !== false) return [];
  const nsis = [...context.platformToTargets.values()].map(targets => targets.get('nsis')).find(Boolean);
  if (!nsis) return [];
  const project = nsis.packager.projectDir;
  const versions = installedBuilderVersions(project);
  if (Object.values(versions).some(version => version !== SUPPORTED_BUILDER_VERSION)) {
    throw new Error('[installer-archive] Unsupported blockmap SDK version');
  }
  const sdk = createRequire(require.resolve('electron-builder/package.json', { paths: [project] }));
  const { executeAppBuilderAsJson } = sdk('app-builder-lib/out/util/appBuilder.js');
  const files = [];
  for (const file of context.artifactPaths.filter(file => file.toLowerCase().endsWith('.exe'))) {
    const size = fs.statSync(file).size;
    if (!size) throw new Error('[installer-archive] Empty installer');
    const output = `${file}.blockmap`;
    const info = await executeAppBuilderAsJson(['blockmap', '--input', file, '--output', output]);
    const hash = crypto.createHash('sha512');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    if (info.size !== size || info.sha512 !== hash.digest('base64')) throw new Error('[installer-archive] Installer changed during blockmap generation');
    const map = JSON.parse(gunzipSync(fs.readFileSync(output)));
    if (map.version !== '2' || map.files?.length !== 1 || map.files[0].offset !== 0
        || map.files[0].sizes?.reduce((sum, bytes) => sum + bytes, 0) !== size
        || map.files[0].checksums?.length !== map.files[0].sizes.length) {
      throw new Error('[installer-archive] Invalid installer blockmap');
    }
    files.push(output);
  }
  return files;
};
