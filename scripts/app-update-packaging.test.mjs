import { installedBuilder as installedBuilder, temporaryDirectory as fixture } from './test-support/fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import config from '../client.config.mjs';
import * as core from './client/core.mjs';
import updater from '../overlay/crates/agent-electron-client/scripts/build/app-update-config.cjs';
import { prepareReleaseUpdater, verifyUpdaterApp, verifyUpdaterOutput, packagedResources } from './prepare-release-updater.mjs';

const feed = config.product.feedBase;
function putConfig(resources, bytes = updater.configBytes(feed)) {
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, 'app-update.yml'), bytes);
}

test('all commercial routes configure the same provider, isolate cache, and reject unrelated hooks', t => {
  const client = fixture(t);
  const original = { appId: config.product.appId, extraMetadata: { name: 'nuwax' }, mac: { publish: [{ provider: 'github' }], identity: 'preserved' } };
  const before = structuredClone(original);
  const configured = updater.configureUpdater(original, { feedBase: feed });
  assert.deepEqual(original, before);
  assert.equal(configured.mac.publish, undefined);
  assert.equal(configured.mac.identity, 'preserved');
  assert.deepEqual(configured.publish, [{ provider: 'generic', url: feed }]);
  fs.writeFileSync(path.join(client, 'package.json'), JSON.stringify({ build: original }));
  prepareReleaseUpdater(client);
  const text = fs.readFileSync(path.join(client, 'package.json'), 'utf8');
  prepareReleaseUpdater(client);
  assert.equal(fs.readFileSync(path.join(client, 'package.json'), 'utf8'), text);
  assert.throws(() => updater.configureUpdater({ afterPack: 'unrelated.js' }, { feedBase: feed }), /existing afterPack/);
  for (const feedBase of ['http://example.com', 'https://user:secret@example.com', 'https://example.com/?token=secret']) {
    assert.throws(() => updater.configBytes(feedBase), /public HTTPS/);
  }
  fs.writeFileSync(path.join(client, 'package.json'), JSON.stringify({ build: {} }));
  assert.throws(() => prepareReleaseUpdater(client), /Commercial application identity/);
});

test('installed builder reproduces missing macOS config with --dir followed by --prepackaged', async t => {
  const builderRequire = installedBuilder(t);
  if (!builderRequire) return;
  const { PublishManager } = builderRequire('app-builder-lib/out/publish/PublishManager.js');
  const { Packager } = builderRequire('app-builder-lib/out/packager.js');
  const { MacPackager } = builderRequire('app-builder-lib/out/macPackager.js');
  const { CancellationToken } = builderRequire('builder-util-runtime');
  const { Platform } = builderRequire('app-builder-lib');
  const output = fixture(t);
  const app = path.join(output, 'Nuwax.app');
  const resources = path.join(app, 'Contents/Resources');
  fs.mkdirSync(resources, { recursive: true });
  const file = path.join(resources, 'app-update.yml');
  const build = updater.configureUpdater({}, { feedBase: feed,
    hook: path.resolve(import.meta.dirname, '../overlay/crates/agent-electron-client/scripts/build/app-update-config.cjs') });
  const afterPackHandlers = [];
  // Use the installed PublishManager's real callback, rather than duplicating
  // its target predicate. --publish never alone does not suppress this file.
  new PublishManager({
    addAfterPackHandler: handler => afterPackHandlers.push(handler),
    artifactCreated() {}, cancellationToken: new CancellationToken(),
  }, { publish: 'never' });
  assert.equal(afterPackHandlers.length, 1);
  const packager = { config: build, platform: Platform.MAC,
    appInfo: { updaterCacheDirName: updater.CACHE_NAME, channel: null },
    platformSpecificBuildOptions: {}, info: { config: build, appInfo: { channel: null } },
    expandMacro: value => value, getResourcesDir: () => resources };
  const context = { packager, appOutDir: output, arch: 1, targets: [], electronPlatformName: 'darwin' };
  const original = { appInfo: { type: 'commonjs' }, config: {}, afterPackHandlers };
  await Packager.prototype.afterPack.call(original, context);
  assert.equal(fs.existsSync(file), false, '--dir skips the built-in macOS updater config');
  await Packager.prototype.afterPack.call(original, { ...context, targets: [{ name: 'zip' }] });
  updater.verifyResources(resources, feed);
  fs.rmSync(file);
  let packaged = false;
  await MacPackager.prototype.pack.call({
    packagerOptions: { prepackaged: app },
    doPack() { assert.fail('--prepackaged must bypass doPack and afterPack'); },
    packageInDistributableFormat(appPath) { assert.equal(appPath, app); packaged = true; },
  }, output, 1, [{ name: 'zip' }], {});
  assert.equal(packaged, true);
  assert.equal(fs.existsSync(file), false, '--prepackaged does not repair the missing config');
  await Packager.prototype.afterPack.call({ ...original, config: build }, context);
  updater.verifyResources(resources, feed);
});

test('real builder afterPack runs commercial hook last even when --dir supplies no archive targets', async t => {
  const output = fixture(t);
  const resources = path.join(output, 'Nuwax.app/Contents/Resources');
  fs.mkdirSync(resources, { recursive: true });
  const builderRequire = installedBuilder(t);
  if (!builderRequire) return;
  const { Packager } = builderRequire('app-builder-lib/out/packager.js');
  const build = updater.configureUpdater({}, { feedBase: feed,
    hook: path.resolve(import.meta.dirname, '../overlay/crates/agent-electron-client/scripts/build/app-update-config.cjs') });
  let builtInRan = false;
  const packager = { config: build, appInfo: { updaterCacheDirName: updater.CACHE_NAME }, getResourcesDir: () => resources };
  const context = { packager, appOutDir: output, targets: [], electronPlatformName: 'darwin' };
  await Packager.prototype.afterPack.call({ appInfo: { type: 'commonjs' }, config: build,
    afterPackHandlers: [async () => {
      builtInRan = true;
      fs.writeFileSync(path.join(resources, 'app-update.yml'), 'provider: github\n');
    }] }, context);
  assert.equal(builtInRan, true);
  assert.ok(fs.existsSync(verifyUpdaterApp(path.join(output, 'Nuwax.app'))));
  const yaml = builderRequire('js-yaml').load(fs.readFileSync(path.join(resources, 'app-update.yml'), 'utf8'));
  assert.deepEqual(yaml, updater.updateConfig(feed));
  // FpmTarget.build uses this exact installed builder serializer after the
  // afterPack hook. Validate the late rewrite too, not only the hook's output.
  const { getAppUpdatePublishConfiguration } = builderRequire('app-builder-lib/out/publish/PublishManager.js');
  const { Platform } = builderRequire('app-builder-lib');
  for (const channel of [null, 'beta', 'qa', 'dev']) {
    const linux = { ...packager, platform: Platform.LINUX,
      appInfo: { ...packager.appInfo, channel }, platformSpecificBuildOptions: build.linux ?? {},
      info: { config: build, appInfo: { channel } }, expandMacro: value => value };
    const actual = await getAppUpdatePublishConfiguration(linux, 1, false);
    assert.deepEqual(actual, updater.updateConfig(feed));
    const rewritten = builderRequire('builder-util').serializeToYaml(actual);
    assert.deepEqual(Buffer.from(rewritten), updater.configBytes(feed));
    fs.writeFileSync(path.join(resources, 'app-update.yml'), rewritten);
    updater.verifyResources(resources, feed);
  }
  packager.appInfo.updaterCacheDirName = 'community-updater';
  await assert.rejects(updater(context), /isolated nuwax-updater/);
});

test('unpacked app verification rejects missing, truncated, wrong provider/feed/cache on every platform', async t => {
  const output = fixture(t);
  for (const platform of ['darwin', 'win32', 'linux']) for (const arch of ['x64', 'arm64']) {
    const resources = packagedResources(output, platform, arch);
    await assert.rejects(verifyUpdaterOutput(output, { platform, arch, archives: false }), /Missing or incorrect/);
    for (const bytes of ['', 'provider: github\n', updater.configBytes('https://wrong.example.com'),
      updater.configBytes(feed).toString().replace('nuwax-updater', 'community-updater')]) {
      putConfig(resources, bytes);
      await assert.rejects(verifyUpdaterOutput(output, { platform, arch, archives: false }), /Missing or incorrect/);
    }
    putConfig(resources);
    await verifyUpdaterOutput(output, { platform, arch, archives: false });
  }
});

test('macOS verifies actual ZIP bytes and mounted DMG, detaches on failure, and never repairs signed files', async t => {
  const output = fixture(t);
  const resources = packagedResources(output, 'darwin', 'arm64');
  putConfig(resources);
  const file = path.join(resources, 'app-update.yml');
  const before = fs.statSync(file).mtimeMs;
  await assert.rejects(verifyUpdaterOutput(output, { platform: 'darwin', arch: 'arm64' }), /ZIP and DMG/);
  for (const name of ['Nuwax.zip', 'Nuwax.dmg']) fs.writeFileSync(path.join(output, name), 'fixture');
  for (const failure of [null, 'zip', 'dmg']) {
    const calls = [];
    const tools = { run: async (command, args) => {
      calls.push([command, ...args]);
      if (command === 'unzip') return { stdout: failure === 'zip' ? '' : updater.configBytes(feed).toString() };
      if (args[0] === 'attach') {
        assert.ok(args.includes('-readonly'));
        const mount = args[args.indexOf('-mountpoint') + 1];
        if (failure !== 'dmg') putConfig(path.join(mount, 'Nuwax.app/Contents/Resources'));
      }
      return { stdout: '' };
    } };
    const run = verifyUpdaterOutput(output, { platform: 'darwin', arch: 'arm64', tools });
    if (failure) await assert.rejects(run, /Missing or incorrect/); else await run;
    assert.equal(calls.filter(([command, phase]) => command === 'hdiutil' && phase === 'detach').length, failure === 'zip' ? 0 : 1);
  }
  assert.equal(fs.statSync(file).mtimeMs, before);
});
