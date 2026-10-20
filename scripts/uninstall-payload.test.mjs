import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import payload from '../overlay/crates/agent-electron-client/scripts/build/uninstall-payload.cjs';
import updater from '../overlay/crates/agent-electron-client/scripts/build/app-update-config.cjs';

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
