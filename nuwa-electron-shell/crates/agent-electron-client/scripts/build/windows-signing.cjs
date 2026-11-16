'use strict';

// Shared by CI, the offline signing machine and the publication gate. The CI
// input anchors every payload byte before signing; a repack never replaces it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { nsisIdentity } = require('./nsis-provenance.cjs');
const BUILDER_VERSION = '25.1.8';
const INPUT_NAME = 'windows-signing-input.json';
const REPORT_NAME = 'windows-signing-verification.json';
const RESOURCE_DIGESTS = {
  'resources/capture/win32-x64/resource.json': ['resources/capture/win32-x64/ffmpeg.exe', 'sha256'],
  'resources/capture/win32-x64/koffi.json': ['resources/capture/win32-x64/koffi.node', 'sha256'],
  'resources/agent-desktop/win32-x64/source.json': ['resources/agent-desktop/win32-x64/agent-desktop-win32-x64.exe', 'files', 'agent-desktop-win32-x64.exe'],
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function hashFile(file) {
  const fd = fs.openSync(file, 'r'), buffer = Buffer.allocUnsafe(1024 * 1024), h = createHash('sha256');
  try { let n; while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) h.update(buffer.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return h.digest('hex');
}
function filesIn(root, prefix = '') {
  return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).flatMap(entry => {
    assert(!entry.isSymbolicLink() && !/[\\:\x00-\x1f]/.test(entry.name), 'Unsafe signing input entry');
    const name = prefix + entry.name;
    if (entry.isDirectory()) return filesIn(root, name + '/');
    assert(entry.isFile(), 'Unsupported signing input entry'); return [name];
  });
}
function peIdentity(bytes, expected) {
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') return null;
  const pe = bytes.readUInt32LE(0x3c);
  assert(pe + 24 <= bytes.length && bytes.toString('binary', pe, pe + 4) === 'PE\0\0', 'Invalid PE file');
  const opt = pe + 24, magic = bytes.readUInt16LE(opt);
  assert([0x10b, 0x20b].includes(magic), 'Unsupported PE format');
  const directory = opt + (magic === 0x10b ? 96 : 112) + 32;
  assert(directory + 8 <= bytes.length, 'Truncated PE header');
  const certificateOffset = bytes.readUInt32LE(directory), certificateSize = bytes.readUInt32LE(directory + 4);
  const length = certificateSize ? certificateOffset : bytes.length;
  const normalizedLength = expected?.normalizedLength ?? length;
  assert(normalizedLength >= directory + 8 && length >= normalizedLength && length - normalizedLength <= 7, 'Signing changed PE image size');
  if (certificateSize) assert(certificateOffset + certificateSize === bytes.length, 'Trailing data after PE certificate');
  assert(!bytes.subarray(normalizedLength, length).some(Boolean), 'Nonzero signing alignment padding');
  const h = createHash('sha256');
  h.update(bytes.subarray(0, opt + 64)); h.update(Buffer.alloc(4));
  h.update(bytes.subarray(opt + 68, directory)); h.update(Buffer.alloc(8));
  h.update(bytes.subarray(directory + 8, normalizedLength));
  return { normalizedLength, normalizedSha256: h.digest('hex'), certificateSize };
}
function scriptBody(bytes) {
  const text = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8').replace(/^\uFEFF/, '');
  const marker = text.search(/^# SIG # Begin signature block\r?$/m);
  if (marker >= 0) assert(/\n# SIG # End signature block(?:\r?\n)*$/.test(text.slice(marker)), 'Incomplete PowerShell signature');
  return { sha256: hash(Buffer.from((marker < 0 ? text : text.slice(0, marker)).replace(/\r\n/g, '\n').replace(/\n+$/, ''))), signed: marker >= 0 };
}
function inventory(root, baseline = {}, exclude = []) {
  return Object.fromEntries(filesIn(root).filter(name => !exclude.includes(name)).map(name => {
    const bytes = fs.readFileSync(path.join(root, name));
    const record = { sha256: hash(bytes), size: bytes.length }, pe = peIdentity(bytes, baseline[name]?.pe);
    if (pe) record.pe = pe;
    if (/\.ps1$/i.test(name)) record.script = scriptBody(bytes);
    if (RESOURCE_DIGESTS[name]) record.json = JSON.parse(bytes);
    return [name, record];
  }));
}
function refreshResourceDigests(root, baseline) {
  for (const [name, [binary, ...keys]] of Object.entries(RESOURCE_DIGESTS)) {
    if (!baseline[name]) continue;
    const value = structuredClone(baseline[name].json); let target = value;
    for (const key of keys.slice(0, -1)) target = target[key];
    target[keys.at(-1)] = hashFile(path.join(root, binary));
    fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2) + '\n');
  }
}
function verifyTree(root, baseline, { resourceDigests = false, exclude = [], requireSignatures = true } = {}) {
  const actual = inventory(root, baseline, exclude);
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(baseline).sort(), 'Packaged file set differs from CI');
  for (const [name, before] of Object.entries(baseline)) {
    const after = actual[name];
    if (before.pe) {
      assert(after.pe && (!requireSignatures || after.pe.certificateSize > 0), `Unsigned packaged PE: ${name}`);
      assert.equal(after.pe.normalizedSha256, before.pe.normalizedSha256, `PE code differs from CI: ${name}`);
    } else if (before.script) {
      assert(after.script && (!requireSignatures || after.script.signed), `Unsigned packaged PowerShell: ${name}`);
      assert.equal(after.script.sha256, before.script.sha256, `Script code differs from CI: ${name}`);
    } else if (resourceDigests && RESOURCE_DIGESTS[name]) {
      // A failed signing batch may not have refreshed these hashes yet. This
      // exception is only for resuming; the final package always requires them.
      if (!requireSignatures && after.sha256 === before.sha256) continue;
      const [binary, ...keys] = RESOURCE_DIGESTS[name], expected = structuredClone(before.json); let target = expected;
      for (const key of keys.slice(0, -1)) target = target[key];
      target[keys.at(-1)] = actual[binary].sha256;
      assert.deepEqual(after.json, expected, `Unrelated resource metadata changed: ${name}`);
    } else assert.equal(after.sha256, before.sha256, `Payload bytes differ from CI: ${name}`);
  }
  return actual;
}
function archiveTool() {
  const configured = process.env.SIGN_7ZIP?.replace(/^\/([a-z])\//i, (_, drive) => drive.toUpperCase() + ':/');
  for (const tool of [configured, process.platform === 'win32' && 'C:/Program Files/7-Zip/7z.exe', '7z', '7zz'].filter(Boolean)) {
    try { if (/Nsis/i.test(execFileSync(tool, ['i'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))) return tool; } catch {}
  }
  throw new Error('Full 7-Zip with NSIS support is required; install 7-Zip or set SIGN_7ZIP');
}
function unpack(installer, directory, tool = archiveTool()) {
  const outer = path.join(directory, 'outer'), app = path.join(directory, 'app'), uninstall = path.join(directory, 'uninstall');
  for (const folder of [outer, app, uninstall]) assert(!fs.existsSync(folder), 'Extraction must use a fresh directory');
  const extract = (file, to) => execFileSync(tool, ['x', '-y', '-bd', '-bso0', '-bsp0', '-o' + to, file], { stdio: 'pipe' });
  extract(installer, outer);
  const archives = filesIn(outer).filter(name => /^\$PLUGINSDIR\/app-64\.(zip|7z)$/.test(name));
  assert.equal(archives.length, 1, 'Expected one x64 NSIS application archive');
  extract(path.join(outer, archives[0]), app);
  extract(path.join(outer, 'Uninstall Nuwax.exe'), uninstall);
  const applicationArchiveSha256 = hashFile(path.join(outer, archives[0]));
  fs.unlinkSync(path.join(outer, archives[0]));
  return { outer, app, uninstall, applicationArchiveSha256, useZip: archives[0].endsWith('.zip') };
}
function compiledPrograms(installer, extracted, application, installerFiles, uninstallerFiles) {
  const uninstaller = path.join(extracted.outer, 'Uninstall Nuwax.exe');
  return {
    installer: nsisIdentity(installer, { payloads: installerFiles,
      special: [[extracted.applicationArchiveSha256, 'application-archive'], [hashFile(uninstaller), 'uninstaller']],
      applicationSize: Object.values(application).reduce((total, file) => total + file.size, 0) }),
    uninstaller: nsisIdentity(uninstaller, { payloads: uninstallerFiles,
      special: [[hashFile(path.join(extracted.uninstall, '$PLUGINSDIR/uninstall-payload.json')), 'uninstall-inventory']] }),
  };
}
function recordInput({ installer, project, source, tag, output }) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-signing-record-'));
  try {
    const extracted = unpack(installer, temporary), pkg = JSON.parse(fs.readFileSync(path.join(project, 'package.json')));
    const builderVersion = require(path.join(project, 'node_modules/electron-builder/package.json')).version;
    assert.equal(builderVersion, BUILDER_VERSION, 'Review signing recipe before upgrading electron-builder');
    const recipe = {};
    for (const name of filesIn(path.join(project, 'build')).filter(name => /\.(?:nsh|ps1|ico|bmp)$/i.test(name))) recipe['build/' + name] = fs.readFileSync(path.join(project, 'build', name)).toString('base64');
    for (const name of ['public/icon.ico', 'scripts/build/uninstall-payload.cjs']) recipe[name] = fs.readFileSync(path.join(project, name)).toString('base64');
    const input = { schemaVersion: 1, tag, source, unsignedSha256: hashFile(installer), builderVersion,
      electronVersion: require(path.join(project, 'node_modules/electron/package.json')).version,
      package: { name: 'nuwax', version: pkg.version, description: pkg.description, author: pkg.author },
      config: pkg.build, recipe, useZip: extracted.useZip,
      application: inventory(extracted.app), installer: inventory(extracted.outer, {}, ['Uninstall Nuwax.exe']),
      uninstaller: inventory(extracted.uninstall, {}, ['$PLUGINSDIR/uninstall-payload.json']),
      uninstallOwnership: JSON.parse(fs.readFileSync(path.join(extracted.uninstall, '$PLUGINSDIR/uninstall-payload.json'))) };
    input.compiledPrograms = compiledPrograms(installer, extracted, input.application, input.installer, input.uninstaller);
    fs.writeFileSync(output, JSON.stringify(input) + '\n'); return input;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
function readInput(file, { sha256, tag, source } = {}) {
  assert(/^[a-f0-9]{64}$/.test(sha256 ?? ''), 'CI signing input SHA256 is required');
  assert.equal(hashFile(file), sha256, 'Signing input does not match CI manifest');
  const input = JSON.parse(fs.readFileSync(file));
  assert.equal(input.schemaVersion, 1); assert.equal(input.tag, tag);
  assert.deepEqual(input.source, source); assert.equal(input.builderVersion, BUILDER_VERSION);
  assert.equal(input.package.name, 'nuwax'); assert.equal(input.config.productName, 'Nuwax');
  assert.equal(input.config.appId, 'com.nuwax-ai.nuwax');
  assert(input.application['Nuwax.exe']?.pe, 'CI input lacks the application executable');
  assert(input.compiledPrograms?.installer && input.compiledPrograms?.uninstaller, 'CI input lacks compiled NSIS source proof; rebuild signing inputs');
  return input;
}
function verifyUninstallInventory(actual, original, application) {
  for (const key of ['schemaVersion','executable','dataDirectoryName','appDataName','updaterCacheName','directories']) assert.deepEqual(actual[key], original[key], `Uninstall ownership changed: ${key}`);
  assert.deepEqual([...actual.files].sort(), Object.keys(application).sort(), 'Uninstall file list is incomplete');
  assert.deepEqual(Object.keys(actual.fileHashes).sort(), Object.keys(application).sort(), 'Uninstall hash list is incomplete');
  for (const [name, value] of Object.entries(application)) assert.equal(actual.fileHashes[name], value.sha256, `Stale uninstall hash: ${name}`);
}
function verifyPackage(installer, input, { verifySignatures, directory } = {}) {
  const temporary = directory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-signing-verify-'));
  try {
    const extracted = unpack(installer, temporary);
    const application = verifyTree(extracted.app, input.application, { resourceDigests: true });
    const installerFiles = verifyTree(extracted.outer, input.installer, { exclude: ['Uninstall Nuwax.exe'] });
    const uninstallerFiles = verifyTree(extracted.uninstall, input.uninstaller, { exclude: ['$PLUGINSDIR/uninstall-payload.json'] });
    const inventoryFile = JSON.parse(fs.readFileSync(path.join(extracted.uninstall, '$PLUGINSDIR/uninstall-payload.json')));
    verifyUninstallInventory(inventoryFile, input.uninstallOwnership, application);
    assert(input.compiledPrograms, 'CI input lacks compiled NSIS source proof; rebuild signing inputs');
    assert.deepEqual(compiledPrograms(installer, extracted, application, installerFiles, uninstallerFiles), input.compiledPrograms,
      'Compiled NSIS installer/uninstaller logic differs from CI');
    const own = [installer, path.join(extracted.outer, 'Uninstall Nuwax.exe'), path.join(extracted.app, 'Nuwax.exe')];
    for (const file of own) assert(peIdentity(fs.readFileSync(file))?.certificateSize > 0, 'Missing installer/application signature');
    const code = own.concat(...[extracted.app, extracted.outer, extracted.uninstall].map(folder => filesIn(folder).filter(name => {
      const bytes = fs.readFileSync(path.join(folder, name)); return peIdentity(bytes) || /\.ps1$/i.test(name);
    }).map(name => path.join(folder, name))));
    const changedPEs = own.concat(...[[extracted.app, input.application, application], [extracted.outer, input.installer, installerFiles],
      [extracted.uninstall, input.uninstaller, uninstallerFiles]].map(([folder, before, after]) => Object.keys(before)
      .filter(name => before[name].pe && before[name].sha256 !== after[name].sha256).map(name => path.join(folder, name))));
    if (verifySignatures) verifySignatures([...new Set(code)], { changedPEs: [...new Set(changedPEs)] });
    return { schemaVersion: 1, tag: input.tag, source: input.source, installerSha256: hashFile(installer),
      unsignedSha256: input.unsignedSha256, verifiedCodeFiles: new Set(code).size, applicationCodeUnchanged: true,
      uninstallHashesVerified: Object.keys(application).length, compiledNsisUnchanged: true };
  } finally { if (!directory) fs.rmSync(temporary, { recursive: true, force: true }); }
}
module.exports = { BUILDER_VERSION, INPUT_NAME, REPORT_NAME, RESOURCE_DIGESTS, hash, hashFile, filesIn, peIdentity,
  scriptBody, inventory, verifyTree, refreshResourceDigests, archiveTool, unpack, compiledPrograms, recordInput, readInput, verifyUninstallInventory, verifyPackage };
if (require.main === module) {
  const [command, tag, output] = process.argv.slice(2);
  assert(command === 'record' && /^(?:electron-)?v\d+\.\d+\.\d+$/.test(tag) && output, 'Expected record <stable-tag> <output-dir>');
  const file = path.join(output, 'build-manifest-windows-x64.json'), manifest = JSON.parse(fs.readFileSync(file));
  assert.equal(manifest.tag, tag); assert.equal(manifest.platform, 'windows'); assert.equal(manifest.arch, 'x64');
  const version = tag.replace(/^(?:electron-)?v/, ''), installer = path.join(output, `Nuwax-Setup-${version}-unsigned.exe`);
  assert.equal(hashFile(installer), manifest.artifacts[path.basename(installer)], 'Installer differs from CI build record');
  recordInput({ installer, project: path.resolve(__dirname, '../..'), source: manifest.source, tag, output: path.join(output, INPUT_NAME) });
  const sha256 = hashFile(path.join(output, INPUT_NAME)); manifest.artifacts[INPUT_NAME] = sha256;
  manifest.windowsSigning.input = { name: INPUT_NAME, sha256 };
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
}
