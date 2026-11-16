'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

// The NSIS uninstaller embeds this build-time inventory. A mutable installed
// manifest must never authorize deleting arbitrary files during elevation.
function writeUninstallPayload({ packager, appOutDir, arch }, finalize = false) {
  const architecture = { 0: 'ia32', 1: 'x64', 3: 'arm64' }[arch];
  const name = packager.appInfo.name;
  const executable = `${packager.appInfo.productFilename}.exe`;
  if (!architecture || !/^nuwax(?:-[a-z0-9-]+)?$/.test(name)
      || !/^[A-Za-z0-9 _.-]+\.exe$/.test(executable)) {
    throw new Error('[uninstall] Unsupported commercial payload identity');
  }
  const files = [], directories = [], fileHashes = {};
  const hashBuffer = Buffer.allocUnsafe(1024 * 1024);
  function hashFile(file) {
    const descriptor = fs.openSync(file, 'r');
    const hash = createHash('sha256');
    try {
      let length;
      while ((length = fs.readSync(descriptor, hashBuffer, 0, hashBuffer.length, null)) !== 0) {
        hash.update(hashBuffer.subarray(0, length));
      }
      return hash.digest('hex');
    } finally { fs.closeSync(descriptor); }
  }
  function visit(folder, prefix = '') {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const relative = prefix + entry.name;
      if (entry.isSymbolicLink() || /[\\:\x00-\x1f]/.test(entry.name)) throw new Error('[uninstall] Unsafe payload entry');
      if (entry.isDirectory()) {
        directories.push(relative);
        visit(path.join(folder, entry.name), `${relative}/`);
      } else if (entry.isFile()) {
        files.push(relative);
        fileHashes[relative] = hashFile(path.join(folder, entry.name));
      }
      else throw new Error('[uninstall] Unsupported payload entry');
    }
  }
  visit(appOutDir);
  if (!files.includes(executable)) throw new Error('[uninstall] Missing application executable');
  const manifest = { schemaVersion: 1, executable, files, directories, fileHashes,
    dataDirectoryName: `.${name}`, appDataName: packager.appInfo.productFilename,
    updaterCacheName: `${name}-updater` };
  const output = path.join(packager.projectDir, 'dist', 'installer-uninstall', `payload-${architecture}.json`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(manifest)}\n`);
  if (!finalize) {
    // afterPack precedes rcedit/signing, and NSIS adds elevate.exe even later.
    // Rehash at the NSIS File instruction, after the application archive has
    // been built, so recovery ownership describes the bytes actually shipped.
    const source = Buffer.from(JSON.stringify({ appOutDir: path.resolve(appOutDir), arch,
      projectDir: path.resolve(packager.projectDir), name, productFilename: packager.appInfo.productFilename })).toString('base64');
    const quote = process.platform === 'win32'
      ? value => `"${value}"`
      : value => `'${value.replaceAll("'", "'\\''")}'`;
    const command = `${quote(process.execPath)} ${quote(__filename)} --finalize ${source}`;
    const escaped = command.replaceAll('`', '$\\`');
    fs.writeFileSync(`${output}.nsh`, `!system \`${escaped}\` = 0\n`);
  }
  return output;
}

module.exports = { writeUninstallPayload };

if (require.main === module) {
  if (process.argv.length !== 4 || process.argv[2] !== '--finalize') throw new Error('[uninstall] Expected --finalize source');
  const { appOutDir, arch, projectDir, name, productFilename } = JSON.parse(Buffer.from(process.argv[3], 'base64').toString('utf8'));
  writeUninstallPayload({ appOutDir, arch, packager: { projectDir, appInfo: { name, productFilename } } }, true);
}
