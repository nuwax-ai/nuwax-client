import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import config from '../client.config.mjs';
import * as core from './client/core.mjs';
import { builderConfig, pack, prepareComputerUse, unsignedEnv, localVersion, validateOutput } from './client/pack.mjs';
import updater from '../overlay/crates/agent-electron-client/scripts/build/app-update-config.cjs';
import { packagedResources } from './prepare-release-updater.mjs';

test('pack resource selection excludes tool download caches without changing their source or runtime payload', async (t) => {
  const client = process.env.NUWAX_TEST_BUILDER_CLIENT_DIR
    ?? fileURLToPath(new URL('../nuwa-electron-shell/crates/agent-electron-client', import.meta.url));
  assert.ok(path.isAbsolute(client), 'Builder fixture override must be an absolute client directory');
  const require = createRequire(import.meta.url);
  const builder = createRequire(require.resolve('electron-builder/package.json', { paths: [client] }));
  assert.equal(builder('./package.json').version, '25.1.8');
  assert.equal(builder('app-builder-lib/package.json').version, '25.1.8');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'client-pack-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, 'out');
  const files = [
    'resources/git/bin/git.exe', 'resources/git/libexec/git-core/git-remote-https.exe',
    'resources/git/LICENSE.txt', 'resources/git/share/archive.zip',
    'resources/git/share/.cache/runtime-index', 'resources/node/node.exe',
    'resources/uv/bin/uv', 'resources/ripgrep/bin/rg', 'frontend/download.zip',
  ];
  const caches = ['git', 'node', 'uv', 'ripgrep'].map(name => `resources/${name}/.cache/download.zip`);
  for (const file of [...files, ...caches]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), file);
  }
  const pkg = { build: {
    extraResources: ['resources/ripgrep', ...['node', 'uv'].map(name => ({ from: `resources/${name}`, to: name }))],
    win: { extraResources: [{ from: 'resources/git', to: 'git', filter: ['**/*'] }] },
  } };
  const build = builderConfig(pkg, {
    frontendDist: path.join(root, 'frontend'), output, platform: 'win32',
    version: '3.0.23-beta.8', builderVersions: { electronBuilder: '25.1.8', appBuilderLib: '25.1.8' },
  });
  const resources = packagedResources(output, 'win32', 'x64');
  const { getFileMatchers, copyFiles } = builder('app-builder-lib/out/fileMatcher');
  const matchers = getFileMatchers(build, 'extraResources', resources, {
    macroExpander: value => value, customBuildOptions: build.win,
    globalOutDir: output, defaultSrc: root,
  });
  await copyFiles(matchers, null, false);
  const expected = ['git/bin/git.exe', 'git/libexec/git-core/git-remote-https.exe', 'git/LICENSE.txt',
    'git/share/archive.zip', 'git/share/.cache/runtime-index', 'node/node.exe', 'uv/bin/uv',
    'resources/ripgrep/bin/rg', 'nuwax-dist/download.zip'];
  for (const file of expected) assert.ok(fs.statSync(path.join(resources, file)).isFile(), file);
  for (const name of ['git', 'node', 'uv', 'resources/ripgrep']) {
    assert.equal(fs.existsSync(path.join(resources, name, '.cache')), false, `${name} download cache leaked into payload`);
  }
  for (const file of caches) assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), file, 'development cache source must remain untouched');
});

test('independent builder config contains commercial identity/payload and leaves package unchanged', () => {
  const pkg = { version: '1.0.0', build: { appId: 'community', productName: 'NuwaClaw', afterSign: 'sign.js', extraResources: [{ from: 'locales', to: 'locales' }, { from: 'resources/agent-gui-server', to: 'agent-gui-server' }, { from: 'resources/windows-mcp', to: 'windows-mcp' }, { from: 'stale/dist', to: 'nuwax-dist' }, { from: 'resources/sandbox-runtime', to: 'sandbox-runtime' }, { from: 'resources/sandboxed-bash-mcp', to: 'sandboxed-bash-mcp' }, { from: 'resources/sandboxed-fs-mcp', to: 'sandboxed-fs-mcp' }], win: { extraResources: [{ from: 'resources/sandbox-helper', to: 'sandbox-helper' }, { from: 'resources/windows-mcp', to: 'windows-mcp' }] }, mac: { extendInfo: { CFBundleIdentifier: 'legacy' } } } };
  const original = structuredClone(pkg);
  const result = builderConfig(pkg, { frontendDist: '/client/nuwax-dist', output: '/client/release/1.2.3', version: '1.2.3', helperDir: '/client/resources/computer-use',
    builderVersions: { electronBuilder: '25.1.8', appBuilderLib: '25.1.8' } });
  assert.deepEqual(pkg, original);
  assert.equal(result.appId, 'com.nuwax-ai.nuwax');
  assert.equal(result.productName, 'Nuwax');
  assert.equal(result.extraMetadata.name, 'nuwax');
  assert.equal(result.extraMetadata.productName, 'Nuwax');
  assert.equal(result.extraMetadata.version, '1.2.3');
  assert.equal(result.mac.extendInfo.CFBundleIdentifier, undefined);
  assert.equal(result.mac.extendInfo.CFBundleDisplayName, 'Nuwax');
  assert.equal(result.mac.extendInfo.CFBundleName, 'Nuwax');
  assert.equal(result.nsis.shortcutName, '女娲Nuwax');
  assert.equal(result.msi.shortcutName, '女娲Nuwax');
  assert.equal(result.linux.desktop.Name, '女娲Nuwax');
  if (process.platform === 'darwin') assert.ok(result.mac.extraResources.some(entry => entry.to === 'en.lproj/InfoPlist.strings'));
  assert.equal(result.extraResources.filter((entry) => entry.to === 'nuwax-dist').length, 1);
  assert.equal(result.extraResources.find((entry) => entry.to === 'nuwax-dist').from, '/client/nuwax-dist');
  assert.ok(result.extraResources.some((entry) => entry.to === 'computer-use'));
  assert.ok(result.files.includes('!node_modules/agent-gui-server/**/*'));
  assert.ok(result.files.includes('!node_modules/@nut-tree-fork/**/*'));
  assert.ok(result.extraResources.every((entry) => !['sandbox-runtime', 'sandboxed-bash-mcp', 'sandboxed-fs-mcp', 'agent-gui-server', 'windows-mcp'].includes(entry.to)));
  assert.deepEqual(result.win.extraResources, []);
  assert.equal(result.afterSign, undefined);
  assert.deepEqual(result.publish, [{ provider: 'generic', url: config.product.feedBase }]);
  assert.ok(path.isAbsolute(result.afterPack));
  assert.equal(result.deb.packageName, 'nuwax');
  assert.equal(result.win.signAndEditExecutable, true);
  assert.equal(result.npmRebuild, false);
  assert.ok(result.asarUnpack.includes('dist/main/mac-notification-permission.node'));
  assert.throws(() => builderConfig(pkg, { version: 'bad' }), /semver/);
});

test('local version derives reachable release tags and marks local builds dev', async () => {
  assert.equal(await localVersion('/client', { git: () => 'electron-v1.0.37' }), '1.0.37-dev');
  assert.equal(await localVersion('/client', { git: () => 'v1.0.38-beta.1' }), '1.0.38-beta.1-dev');
  assert.equal(await localVersion('/client', { git: () => '' }), '0.0.0-dev');
});

test('unsigned environment suppresses signing and automatic prepare', () => {
  const env = unsignedEnv('/client');
  assert.equal(env.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
  assert.equal(env.SKIP_WINDOWS_AFTER_SIGN, '1');
  assert.equal(env.WINDOWS_CERTIFICATE_PASSWORD, '');
  assert.equal(env.APPLE_API_KEY, '');
  assert.equal(env.NUWAX_APP_IDENTIFIER, 'nuwax');
});

test('helper cache rebuilds when a shared upstream registry changes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'client-cua-cache-'));
  const previousSource = process.env.NUWAX_CUA_SOURCE_DIR;
  t.after(() => {
    if (previousSource === undefined) delete process.env.NUWAX_CUA_SOURCE_DIR;
    else process.env.NUWAX_CUA_SOURCE_DIR = previousSource;
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.NUWAX_CUA_SOURCE_DIR = path.join(root, 'upstream');
  const registry = path.join(process.env.NUWAX_CUA_SOURCE_DIR, 'libs/images/sandbox-images.json');
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(registry, '{"revision":1}');
  const p = core.paths(root);
  const helperDir = path.join(p.client, 'resources/computer-use');
  fs.mkdirSync(path.join(p.client, 'resources/git/bin'), { recursive: true });
  fs.writeFileSync(path.join(p.client, 'resources/git/bin/bash.exe'), 'test runner');
  let builds = 0;
  const tools = { ...core, run: async (command) => {
    if (command.endsWith('bash.exe')) {
      builds++;
      fs.mkdirSync(helperDir, { recursive: true });
      fs.writeFileSync(path.join(helperDir, 'NuwaxComputerUse.exe'), `build ${builds}`);
    }
    return { stdout: '', stderr: '' };
  } };
  const options = { tools, platform: 'win32', arch: 'x64' };
  await prepareComputerUse(root, options);
  await prepareComputerUse(root, options);
  assert.equal(builds, 1, 'unchanged inputs reuse the verified helper');
  fs.writeFileSync(registry, '{"revision":2}');
  await prepareComputerUse(root, options);
  assert.equal(builds, 2, 'the shared registry is compiled into the helper');
});

test('pack output protects source/module/cache paths and resolves symlink aliases', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'client-output-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const p = core.paths(root);
  for (const output of [root, path.dirname(root), p.base, path.join(p.frontend, 'dist'), p.dist, p.cache, path.join(root, 'scripts/generated')]) {
    assert.throws(() => validateOutput(root, output), /输出目录不能/);
  }
  assert.equal(validateOutput(root, path.join(root, 'release/test')), path.join(root, 'release/test'));
  assert.equal(validateOutput(root, path.join(root, 'custom-output')), path.join(root, 'custom-output'));
  fs.mkdirSync(p.base, { recursive: true });
  fs.symlinkSync(p.base, path.join(root, 'alias-output'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => validateOutput(root, path.join(root, 'alias-output/test')), /源码、子模块/);
  let prepared = false;
  await assert.rejects(pack(root, { output: root, version: '1.0.0', prepare: async () => { prepared = true; } }), /仓库根/);
  assert.equal(prepared, false, 'bad output is rejected before preparation');
});

test('source pack builds fresh frontend before builder and does not edit base package', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'client-pack-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const p = core.paths(root);
  fs.mkdirSync(p.client, { recursive: true });
  const packageFile = path.join(p.client, 'package.json');
  const packageText = JSON.stringify({ version: '1.0.0', build: { extraResources: [] } });
  fs.writeFileSync(packageFile, packageText);
  const events = [];
  const tools = { ...core,
    npmRun: (dir, script) => { events.push(script); return { status: 0, stdout: '', stderr: '' }; },
    pnpmRun: (dir, args, options) => {
      events.push('builder');
      assert.ok(args.includes('--mac'));
      assert.ok(args.includes('--arm64'));
      assert.ok(args.includes('never'));
      assert.ok(args.includes('--dir'));
      assert.equal(options.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
      const generated = core.readJson(args[args.indexOf('--config') + 1]);
      assert.equal(generated.extraResources.find((entry) => entry.to === 'nuwax-dist').from, path.join(p.frontend, 'dist'));
      const resources = packagedResources(generated.directories.output, 'darwin', 'arm64');
      fs.mkdirSync(resources, { recursive: true });
      fs.writeFileSync(path.join(resources, 'app-update.yml'), updater.configBytes(config.product.feedBase));
      return { status: 0, stdout: '', stderr: '' };
    },
  };
  await pack(root, { tools, platform: 'darwin', arch: 'arm64', frontend: 'source', dir: true,
    prepare: async () => { events.push('prepare'); return p; },
    buildFrontend: async () => {
      events.push('frontend');
      const distDir = path.join(p.frontend, 'dist');
      fs.mkdirSync(distDir, { recursive: true }); fs.writeFileSync(path.join(distDir, 'index.html'), 'frontend');
      return { distDir, sourceSha: 'abcdefg' };
    },
    prepareComputerUse: async () => { events.push('helper'); return path.join(p.client, 'resources/computer-use'); },
    generateNotices: async (_root, options) => { assert.equal(options.strict, true); assert.ok(options.resourcePaths['computer-use']); events.push('notices'); },
  });
  assert.deepEqual(events, ['prepare', 'frontend', 'helper', 'notices', 'build', 'builder']);
  assert.equal(fs.readFileSync(packageFile, 'utf8'), packageText);
});

test('default pack consumes configured frontend pin and creates complete packages in the configured directory', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'client-pack-default-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const p = core.paths(root);
  fs.mkdirSync(p.client, { recursive: true });
  fs.writeFileSync(path.join(p.client, 'package.json'), JSON.stringify({ build: {} }));
  fs.mkdirSync(p.dist, { recursive: true });
  fs.writeFileSync(path.join(p.dist, 'index.html'), 'pinned frontend');
  const tools = { ...core,
    npmRun: async () => ({ status: 0 }),
    pnpmRun: async (dir, args) => {
      assert.equal(args.includes('--dir'), config.pack.dir);
      const generated = core.readJson(args[args.indexOf('--config') + 1]);
      assert.equal(generated.directories.output, path.join(root, config.pack.outputDir, '1.2.3'));
      assert.equal(generated.extraResources.find((entry) => entry.to === 'nuwax-dist').from, p.dist);
      fs.mkdirSync(generated.directories.output, { recursive: true });
      fs.writeFileSync(path.join(generated.directories.output, 'Nuwax.dmg'), 'fixture complete package');
      return { status: 0 };
    },
  };
  const result = await pack(root, { tools, platform: 'darwin', version: '1.2.3',
    prepare: async (dir, options) => {
      assert.equal(options.frontend, config.frontend.mode);
      return { frontend: { distDir: p.dist, stamp: 'abcdefghi' } };
    },
    buildFrontend: async () => { assert.fail('default pack must consume its prepared pin'); },
    prepareComputerUse: async () => path.join(p.client, 'resources/computer-use'),
    generateNotices: async (_root, options) => { assert.equal(options.strict, true); },
    verifyPackagePayload: async (output, options) => {
      assert.equal(output, path.join(root, config.pack.outputDir, '1.2.3'));
      assert.equal(options.platform, 'darwin');
    },
    verifyUpdaterOutput: async (output, options) => {
      assert.equal(output, path.join(root, config.pack.outputDir, '1.2.3'));
      assert.equal(options.archives, true);
      assert.equal(options.platform, 'darwin');
    },
  });
  assert.equal(result.output, path.join(root, config.pack.outputDir, '1.2.3'));
});

test('capture and notices use independent commercial resource paths and include source archives', () => {
  const pkg = { build: { extraResources: [{ from: 'stale', to: 'capture' }, { from: 'stale-notices', to: 'third-party' }] } };
  const result = builderConfig(pkg, { captureDir: '/commercial/resources/capture/darwin-arm64', noticesDir: '/commercial/.cache/notices', frontendDist: '/frontend', output: '/output',
    builderVersions: { electronBuilder: '25.1.8', appBuilderLib: '25.1.8' } });
  assert.equal(result.extraResources.filter((entry) => entry.to.startsWith('capture')).length, 1);
  assert.deepEqual(result.extraResources.find((entry) => entry.to.startsWith('capture')), { from: '/commercial/resources/capture/darwin-arm64', to: 'capture/darwin-arm64', filter: ['ffmpeg', 'ffmpeg.exe', 'resource.json', 'koffi.node', 'koffi.json'] });
  assert.deepEqual(result.extraResources.find((entry) => entry.to === 'third-party').filter, ['third-party-notices.json', 'licenses/**', 'sources/**']);
});
