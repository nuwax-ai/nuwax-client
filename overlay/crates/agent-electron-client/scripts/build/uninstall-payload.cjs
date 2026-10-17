'use strict';

const fs = require('node:fs');
const path = require('node:path');

// The NSIS uninstaller embeds this build-time inventory. A mutable installed
// manifest must never authorize deleting arbitrary files during elevation.
function writeUninstallPayload({ packager, appOutDir, arch }) {
  const architecture = { 0: 'ia32', 1: 'x64', 3: 'arm64' }[arch];
  const name = packager.appInfo.name;
  const executable = `${packager.appInfo.productFilename}.exe`;
  if (!architecture || !/^nuwax(?:-[a-z0-9-]+)?$/.test(name)
      || !/^[A-Za-z0-9 _.-]+\.exe$/.test(executable)) {
    throw new Error('[uninstall] Unsupported commercial payload identity');
  }
  const files = [], directories = [];
  function visit(folder, prefix = '') {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const relative = prefix + entry.name;
      if (entry.isSymbolicLink() || /[\\:\x00-\x1f]/.test(entry.name)) throw new Error('[uninstall] Unsafe payload entry');
      if (entry.isDirectory()) {
        directories.push(relative);
        visit(path.join(folder, entry.name), `${relative}/`);
      } else if (entry.isFile()) files.push(relative);
      else throw new Error('[uninstall] Unsupported payload entry');
    }
  }
  visit(appOutDir);
  if (!files.includes(executable)) throw new Error('[uninstall] Missing application executable');
  const manifest = { schemaVersion: 1, executable, files, directories,
    dataDirectoryName: `.${name}`, appDataName: packager.appInfo.productFilename,
    updaterCacheName: `${name}-updater` };
  const output = path.join(packager.projectDir, 'dist', 'installer-uninstall', `payload-${architecture}.json`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(manifest)}\n`);
  return output;
}

module.exports = { writeUninstallPayload };
