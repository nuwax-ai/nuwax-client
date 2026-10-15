import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import config from '../client.config.mjs';
import { configureSystemAppName } from './client/system-app-name.mjs';
import { prepareReleaseSystemName, verifyMacSystemName } from './prepare-release-system-name.mjs';

const strings = path.resolve(import.meta.dirname, '../overlay/crates/agent-electron-client/build/InfoPlist.strings');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-system-name-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function builder(t) {
  const require = createRequire(import.meta.url);
  const client = path.resolve(import.meta.dirname, '../nuwa-electron-shell/crates/agent-electron-client');
  let file;
  try { file = require.resolve('electron-builder/package.json', { paths: [client] }); }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; t.skip('Builder dependencies unavailable'); return; }
  const result = createRequire(file);
  result('app-builder-lib');
  return result;
}
function branded(platform) {
  return configureSystemAppName({ appId: config.product.appId, extraMetadata: { name: 'nuwax' },
    linux: { desktop: { entry: { Name: 'Nuwax' }, Categories: 'Utility;' } } }, { platform, macStringsFile: strings });
}

test('system names are repeatable and preserve executable, cache and installer identities', async t => {
  const require = builder(t);
  const { AppInfo } = require ? require('app-builder-lib/out/appInfo.js') : {};
  const validate = require?.('app-builder-lib/out/util/config/config.js').validateConfiguration;
  for (const platform of ['darwin', 'win32', 'linux']) {
    const build = branded(platform);
    assert.deepEqual(configureSystemAppName(build, { platform, macStringsFile: strings }), build);
    assert.equal(build.nsis.shortcutName, '女娲Nuwax');
    assert.equal(build.msi.shortcutName, '女娲Nuwax');
    assert.equal(build.linux.desktop.Name, '女娲Nuwax');
    assert.equal(build.linux.desktop.entry, undefined);
    if (validate) {
      await validate(build, { isEnabled: false });
      const info = new AppInfo({ config: build, metadata: { name: 'nuwax', version: '3.0.17', productName: 'Nuwax' } });
      assert.equal(info.productFilename, 'Nuwax');
      assert.equal(info.updaterCacheDirName, 'nuwax-updater');
    }
    const dir = fixture(t);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ build }));
    prepareReleaseSystemName(dir, { platform });
    const first = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
    prepareReleaseSystemName(dir, { platform });
    assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), first);
  }
});

test('locked builder emits the real Linux launcher label and both Windows installer shortcut labels', async t => {
  const require = builder(t);
  if (!require) return;
  const { LinuxTargetHelper } = require('app-builder-lib/out/targets/LinuxTargetHelper.js');
  const { getEffectiveOptions } = require('app-builder-lib/out/options/CommonWindowsInstallerConfiguration.js');
  const linux = branded('linux');
  const packager = { appInfo: { productName: 'Nuwax', sanitizedProductName: 'Nuwax' }, executableName: 'nuwax',
    config: linux, platformSpecificBuildOptions: linux.linux, fileAssociations: [] };
  const desktop = await LinuxTargetHelper.prototype.computeDesktopEntry.call({ packager, getDescription: () => '' }, linux.linux);
  assert.match(desktop, /^Name=女娲Nuwax$/m);
  assert.match(desktop, /^StartupWMClass=Nuwax$/m);
  assert.doesNotMatch(desktop, /^entry=/m);
  const win = branded('win32');
  for (const type of ['nsis', 'msi']) {
    const options = getEffectiveOptions(win[type], { appInfo: { sanitizedProductName: 'Nuwax' }, expandMacro: value => value });
    assert.equal(options.shortcutName, '女娲Nuwax');
    assert.equal(options.isCreateStartMenuShortcut, true);
  }
});

test('macOS resolves the real Finder and bundle names through native localization', { skip: process.platform !== 'darwin' }, async t => {
  const dir = fixture(t);
  const app = path.join(dir, 'Nuwax.app');
  const writePlist = (bundle, fields) => {
    const contents = path.join(bundle, 'Contents');
    fs.mkdirSync(contents, { recursive: true });
    const plist = path.join(contents, 'Info.plist');
    const info = { CFBundleIdentifier: 'com.nuwax.name-check', CFBundlePackageType: 'APPL', CFBundleDevelopmentRegion: 'en', ...fields };
    fs.writeFileSync(plist, JSON.stringify(info));
    execFileSync('plutil', ['-convert', 'xml1', plist]);
  };
  const source = `ObjC.import('Foundation');function run(args){const b=$.NSBundle.bundleWithPath(args[0]);return JSON.stringify({fileName:ObjC.unwrap($.NSFileManager.defaultManager.displayNameAtPath(args[0])),bundleName:ObjC.unwrap(b.objectForInfoDictionaryKey('CFBundleName')),displayName:ObjC.unwrap(b.objectForInfoDictionaryKey('CFBundleDisplayName'))});}`;
  const resolve = bundle => JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', '-e', source, bundle], { encoding: 'utf8', timeout: 15000 }));
  writePlist(app, { CFBundleName: 'Nuwax', CFBundleDisplayName: '女娲Nuwax' });
  assert.equal(resolve(app).fileName, 'Nuwax', 'Reproduce the previous raw-plist-only fix');
  await assert.rejects(verifyMacSystemName(app), /Incorrect native macOS/);
  const build = branded('darwin');
  // Resolve a fresh replacement bundle; macOS caches names of existing paths.
  const replacement = path.join(dir, 'replacement/Nuwax.app');
  const contents = path.join(replacement, 'Contents');
  writePlist(replacement, build.mac.extendInfo);
  for (const resource of build.mac.extraResources) {
    const to = path.join(contents, 'Resources', resource.to);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(resource.from, to);
  }
  assert.deepEqual(await verifyMacSystemName(replacement), { fileName: '女娲Nuwax', bundleName: '女娲Nuwax', displayName: '女娲Nuwax' });
});
