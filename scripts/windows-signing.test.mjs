import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import signing from '../nuwa-electron-shell/crates/agent-electron-client/scripts/build/windows-signing.cjs';
import signer from '../nuwa-electron-shell/crates/agent-electron-client/scripts/build/sign-windows-release.cjs';

function pe(signed = false) {
  const b = Buffer.alloc(512 + (signed ? 32 : 0)); b.write('MZ'); b.writeUInt32LE(128, 60); b.write('PE\0\0', 128); b.writeUInt16LE(0x20b, 152);
  b[400] = 42;
  if (signed) { b.writeUInt32LE(512, 152 + 112 + 32); b.writeUInt32LE(32, 152 + 112 + 36); }
  return b;
}
function fixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-signing-'));
  const write = (name, bytes) => { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), bytes); };
  try { run(dir, write); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
test('inner signature gate covers main executable and nested native modules', () => fixture((dir, write) => {
  write('Nuwax.exe', pe()); write('resources/node_modules/native/module.node', pe()); write('data.txt', 'unchanged');
  const baseline = signing.inventory(dir);
  assert.throws(() => signing.verifyTree(dir, baseline), /Unsigned packaged PE/);
  write('Nuwax.exe', pe(true));
  assert.throws(() => signing.verifyTree(dir, baseline), /module.node/);
  write('resources/node_modules/native/module.node', pe(true));
  signing.verifyTree(dir, baseline);
  const corrupt = pe(true); corrupt[400] ^= 1; write('Nuwax.exe', corrupt);
  assert.throws(() => signing.verifyTree(dir, baseline), /PE code differs/);
}));
test('SimplySign batch recovery keeps verified progress without accepting an unsigned final package', () => fixture((dir, write) => {
  write('Nuwax.exe', pe()); write('helper.node', pe()); const baseline = signing.inventory(dir);
  write('Nuwax.exe', pe(true)); signing.verifyTree(dir, baseline, { requireSignatures: false });
  assert.throws(() => signing.verifyTree(dir, baseline), /Unsigned packaged PE/);
  const changed = pe(true); changed[400] ^= 1; write('Nuwax.exe', changed);
  assert.throws(() => signing.verifyTree(dir, baseline, { requireSignatures: false }), /PE code differs/);
}));
test('signing accepts certificate changes and rejects modified data, missing files and extras', () => fixture((dir, write) => {
  write('Nuwax.exe', pe(true)); write('data.txt', 'original'); const baseline = signing.inventory(dir);
  const signed = pe(true); signed[signed.length - 1] = 22; write('Nuwax.exe', signed); signing.verifyTree(dir, baseline);
  write('data.txt', 'modified'); assert.throws(() => signing.verifyTree(dir, baseline), /Payload bytes/);
  write('data.txt', 'original'); write('extra.txt', 'extra'); assert.throws(() => signing.verifyTree(dir, baseline), /file set/);
  fs.unlinkSync(path.join(dir, 'extra.txt')); fs.unlinkSync(path.join(dir, 'data.txt')); assert.throws(() => signing.verifyTree(dir, baseline), /file set/);
}));
test('PowerShell bodies must remain identical and every packaged script must be signed', () => fixture((dir, write) => {
  const body = 'Write-Host "hello"\r\n'; write('helper.ps1', body); const baseline = signing.inventory(dir);
  assert.throws(() => signing.verifyTree(dir, baseline), /Unsigned packaged PowerShell/);
  const signature = '# SIG # Begin signature block\r\n# data\r\n# SIG # End signature block\r\n';
  write('helper.ps1', body + signature); signing.verifyTree(dir, baseline);
  write('helper.ps1', 'Write-Host "changed"\r\n' + signature);
  assert.throws(() => signing.verifyTree(dir, baseline), /Script code differs/);
}));
test('a signature marker inside a script string cannot hide later code changes', () => {
  const before = Buffer.from('Write-Host "# SIG # Begin signature block"\nWrite-Host "original"\n');
  const after = Buffer.from('Write-Host "# SIG # Begin signature block"\nWrite-Host "changed"\n');
  assert.equal(signing.scriptBody(before).signed, false);
  assert.notEqual(signing.scriptBody(before).sha256, signing.scriptBody(after).sha256);
});
test('resource hash refresh preserves source identity and rejects unrelated metadata edits', () => fixture((dir, write) => {
  const name = 'resources/capture/win32-x64/resource.json';
  write('resources/capture/win32-x64/ffmpeg.exe', pe()); write(name, JSON.stringify({ source: 'pinned', sha256: 'old' }));
  const baseline = signing.inventory(dir); write('resources/capture/win32-x64/ffmpeg.exe', pe(true));
  signing.refreshResourceDigests(dir, baseline); signing.verifyTree(dir, baseline, { resourceDigests: true });
  const value = JSON.parse(fs.readFileSync(path.join(dir, name))); assert.equal(value.source, 'pinned');
  value.source = 'other'; write(name, JSON.stringify(value));
  assert.throws(() => signing.verifyTree(dir, baseline, { resourceDigests: true }), /Unrelated resource metadata/);
}));
test('uninstaller must use signed payload hashes and retain the product/data boundary', () => {
  const original = { schemaVersion: 1, executable: 'Nuwax.exe', dataDirectoryName: '.nuwax', appDataName: 'Nuwax', updaterCacheName: 'nuwax-updater', directories: ['resources'] };
  const application = { 'Nuwax.exe': { sha256: 'new-main' }, 'resources/elevate.exe': { sha256: 'new-helper' } };
  const inventory = { ...original, files: Object.keys(application), fileHashes: Object.fromEntries(Object.entries(application).map(([k,v]) => [k,v.sha256])) };
  signing.verifyUninstallInventory(inventory, original, application);
  assert.throws(() => signing.verifyUninstallInventory({ ...inventory, dataDirectoryName: '.other' }, original, application), /ownership/);
  assert.throws(() => signing.verifyUninstallInventory({ ...inventory, files: ['Nuwax.exe'] }, original, application), /incomplete/);
  assert.throws(() => signing.verifyUninstallInventory({ ...inventory, fileHashes: { ...inventory.fileHashes, 'Nuwax.exe': 'unsigned-main' } }, original, application), /Stale uninstall hash/);
});
test('installer recipe paths cannot escape the isolated signing project', () => {
  signer.safeRecipePath('build/installer.nsh'); signer.safeRecipePath('scripts/build/uninstall-payload.cjs');
  for (const name of ['../package.json', 'build/../../outside.ps1', '/absolute.ps1', 'build/tool.exe']) assert.throws(() => signer.safeRecipePath(name));
});
test('NSIS signing leaves compiler stubs untouched while signing runtime plugins and tools', () => fixture((dir, write) => {
  write('Stubs/zlib-x86-unicode', pe()); write('Plugins/x86-unicode/installer.dll', pe()); write('Bin/makensis.exe', pe());
  const stub = path.join(dir, 'Stubs/zlib-x86-unicode'), original = fs.readFileSync(stub);
  const selected = signer.nsisSigningFiles(dir);
  assert.deepEqual(selected.map(file => path.relative(dir, file).split(path.sep).join('/')).sort(), ['Bin/makensis.exe', 'Plugins/x86-unicode/installer.dll']);
  for (const file of selected) fs.writeFileSync(file, pe(true));
  assert.deepEqual(fs.readFileSync(stub), original, 'makensis must receive the original unsigned PE template');
}));
test('installer signing preserves the main file hash after inventory generation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-sign-hook-'));
  try {
    const main = path.join(dir, 'Nuwax.exe'); fs.writeFileSync(main, pe(true)); const calls = [];
    const hook = signer.installerSignHook(main, (file, options) => calls.push({ file, ...options }));
    await hook({ path: main }); await hook({ path: path.join(dir, 'Uninstall Nuwax.exe') });
    assert.equal(calls[0].verifyOnly, true); assert.equal(calls[1].verifyOnly, false);
    const changed = pe(true); changed[changed.length - 1] = 10; fs.writeFileSync(main, changed);
    await assert.rejects(hook({ path: main }), /Application changed after uninstall inventory/);
    assert.equal(calls.length, 2, 'a changed application never reaches the signing callback');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('CI input must match its hash, tag and source before any packaged code is trusted', () => fixture((dir, write) => {
  const source = { client: 'a'.repeat(40), shell: 'b'.repeat(40), frontend: 'c'.repeat(40) };
  const input = { schemaVersion: 1, tag: 'v3.1.4', source, builderVersion: signing.BUILDER_VERSION,
    package: { name: 'nuwax' }, config: { productName: 'Nuwax', appId: 'com.nuwax-ai.nuwax' }, application: { 'Nuwax.exe': { pe: {} } },
    compiledPrograms: { installer: {}, uninstaller: {} } };
  write('input.json', JSON.stringify(input)); const file = path.join(dir, 'input.json');
  const expected = { sha256: signing.hashFile(file), tag: input.tag, source }; signing.readInput(file, expected);
  assert.throws(() => signing.readInput(file, { ...expected, tag: 'v3.1.5' }));
  assert.throws(() => signing.readInput(file, { ...expected, source: { ...source, client: 'd'.repeat(40) } }));
  write('input.json', JSON.stringify({ ...input, source: { ...source, client: 'e'.repeat(40) } }));
  assert.throws(() => signing.readInput(file, expected), /does not match CI manifest/);
  const { compiledPrograms, ...legacy } = input; write('input.json', JSON.stringify(legacy));
  assert.throws(() => signing.readInput(file, { ...expected, sha256: signing.hashFile(file) }), /lacks compiled NSIS source proof/);
}));
