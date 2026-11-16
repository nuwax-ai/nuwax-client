import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import payload from '../nuwa-electron-shell/crates/agent-electron-client/scripts/build/uninstall-payload.cjs';
import updater from '../nuwa-electron-shell/crates/agent-electron-client/scripts/build/app-update-config.cjs';

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-uninstall-payload-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('build-time inventory includes owned files inside resources and stays outside shipped payload', t => {
  const root = temporaryDirectory(t), app = path.join(root, 'application');
  fs.mkdirSync(path.join(app, 'resources', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Nuwax.exe'), 'program');
  fs.writeFileSync(path.join(app, 'resources', 'nested', 'app.asar'), 'payload');
  const manifest = payload.writeUninstallPayload({ appOutDir: app, arch: 1,
    packager: { projectDir: root, appInfo: { name: 'nuwax', productFilename: 'Nuwax' } } });
  assert.equal(manifest, path.join(root, 'dist/installer-uninstall/payload-x64.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(manifest)), {
    schemaVersion: 1, executable: 'Nuwax.exe', files: ['Nuwax.exe', 'resources/nested/app.asar'],
    directories: ['resources', 'resources/nested'], dataDirectoryName: '.nuwax', appDataName: 'Nuwax', updaterCacheName: 'nuwax-updater',
    fileHashes: { 'Nuwax.exe': createHash('sha256').update('program').digest('hex'), 'resources/nested/app.asar': createHash('sha256').update('payload').digest('hex') },
  });
  assert.deepEqual(fs.readdirSync(app), ['Nuwax.exe', 'resources']);
});

test('inventory rejects redirected payload entries and unsupported product identities', t => {
  const root = temporaryDirectory(t), app = path.join(root, 'application');
  fs.mkdirSync(app); fs.writeFileSync(path.join(app, 'Nuwax.exe'), 'program');
  const context = { appOutDir: app, arch: 1, packager: { projectDir: root, appInfo: { name: 'nuwax', productFilename: 'Nuwax' } } };
  fs.symlinkSync(path.join(root, 'outside'), path.join(app, 'redirect'));
  assert.throws(() => payload.writeUninstallPayload(context), /Unsafe payload/);
  context.packager.appInfo.name = '../profile';
  assert.throws(() => payload.writeUninstallPayload(context), /Unsupported commercial/);
});

test('inventory hashes the complete contents of large program files', t => {
  const root = temporaryDirectory(t), app = path.join(root, 'application');
  fs.mkdirSync(app);
  const program = Buffer.alloc(2 * 1024 * 1024 + 17, 0x6e);
  fs.writeFileSync(path.join(app, 'Nuwax.exe'), program);
  const manifest = payload.writeUninstallPayload({ appOutDir: app, arch: 1,
    packager: { projectDir: root, appInfo: { name: 'nuwax', productFilename: 'Nuwax' } } });
  assert.equal(JSON.parse(fs.readFileSync(manifest)).fileHashes['Nuwax.exe'], createHash('sha256').update(program).digest('hex'));
});

test('actual Windows afterPack composes updater metadata and the embedded uninstall inventory', async t => {
  const root = temporaryDirectory(t), app = path.join(root, 'win-unpacked'), resources = path.join(app, 'resources');
  fs.mkdirSync(resources, { recursive: true }); fs.writeFileSync(path.join(app, 'Nuwax.exe'), 'program');
  await updater({ appOutDir: app, arch: 1, electronPlatformName: 'win32', packager: {
    projectDir: root, config: { publish: [{ provider: 'generic', url: 'https://updates.example.com' }] },
    appInfo: { name: 'nuwax', productFilename: 'Nuwax', updaterCacheDirName: 'nuwax-updater' },
    getResourcesDir: () => resources,
  } });
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dist/installer-uninstall/payload-x64.json')));
  assert.ok(manifest.files.includes('resources/app-update.yml'));
  assert.equal(fs.readdirSync(resources).length, 1, 'Inventory must not be a mutable shipped deletion authority');
});

test('NSIS embeds final payload hashes after EXE edits, signing and late helper injection', t => {
  const cache = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA, 'electron-builder/Cache')
    : path.join(os.homedir(), 'Library/Caches/electron-builder');
  const nsis = process.env.NUWAX_TEST_NSIS_ROOT ?? path.join(cache, 'nsis/nsis-3.0.4.1');
  const compiler = path.join(nsis, process.platform === 'win32' ? 'Bin/makensis.exe' : 'mac/makensis');
  if (!fs.existsSync(compiler)) return t.skip('Requires cached NSIS SDK');
  const root = path.join(temporaryDirectory(t), "build's $ payload"), app = path.join(root, 'application');
  fs.mkdirSync(path.join(app, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Nuwax.exe'), 'before rcedit');
  fs.writeFileSync(path.join(app, 'resources', 'node.exe'), 'before signing');
  const manifest = payload.writeUninstallPayload({ appOutDir: app, arch: 1,
    packager: { projectDir: root, appInfo: { name: 'nuwax', productFilename: 'Nuwax' } } });
  fs.writeFileSync(path.join(app, 'Nuwax.exe'), 'final icon, metadata and signature');
  fs.writeFileSync(path.join(app, 'resources', 'node.exe'), 'final signed runtime');
  fs.writeFileSync(path.join(app, 'resources', 'elevate.exe'), 'late NSIS helper');
  const overlay = path.resolve(import.meta.dirname, '../nuwa-electron-shell/crates/agent-electron-client/build/uninstall-options.nsh');
  const script = path.join(root, 'fixture.nsi');
  fs.writeFileSync(script, `Unicode true
Name InventoryQA
OutFile "${path.join(root, 'fixture.exe')}"
RequestExecutionLevel user
SilentInstall silent
!include "${overlay}"
!define NUWAX_UNINSTALL_MANIFEST "${manifest}"
Section
InitPluginsDir
!insertmacro nuwaxExtractUninstallInventory
CopyFiles /SILENT "$PLUGINSDIR\\uninstall-payload.json" "$EXEDIR\\embedded-payload.json"
SectionEnd
`);
  const compile = () => execFileSync(compiler, ['-V2', script], { env: { ...process.env, NSISDIR: nsis }, stdio: 'pipe' });
  compile();
  const inventory = JSON.parse(fs.readFileSync(manifest));
  assert.deepEqual(inventory.files, ['Nuwax.exe', 'resources/elevate.exe', 'resources/node.exe']);
  for (const file of inventory.files) {
    assert.equal(inventory.fileHashes[file], createHash('sha256').update(fs.readFileSync(path.join(app, file))).digest('hex'), file);
  }
  if (process.platform === 'win32') {
    execFileSync(path.join(root, 'fixture.exe'), ['/S'], { stdio: 'pipe' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'embedded-payload.json'))), inventory);
  }
  // A failed final scan must stop compilation rather than embed stale hashes.
  fs.renameSync(path.join(app, 'Nuwax.exe'), path.join(app, 'missing.exe'));
  assert.throws(compile);
});
