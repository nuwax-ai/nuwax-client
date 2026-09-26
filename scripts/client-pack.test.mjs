import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as core from './client/core.mjs';
import { builderConfig, pack, unsignedEnv, localVersion, validateOutput } from './client/pack.mjs';

test('independent builder config contains commercial identity/payload and leaves package unchanged', () => {
  const pkg = { version: '1.0.0', build: { appId: 'community', productName: 'NuwaClaw', afterSign: 'sign.js', extraResources: [{ from: 'locales', to: 'locales' }, { from: 'stale/dist', to: 'nuwax-dist' }], mac: { extendInfo: { CFBundleIdentifier: 'legacy' } } } };
  const original = structuredClone(pkg);
  const result = builderConfig(pkg, { frontendDist: '/client/nuwax-dist', output: '/client/release/1.2.3', version: '1.2.3', helperDir: '/client/resources/computer-use' });
  assert.deepEqual(pkg, original);
  assert.equal(result.appId, 'com.nuwax-ai.nuwax');
  assert.equal(result.productName, 'Nuwax');
  assert.equal(result.extraMetadata.name, 'nuwax');
  assert.equal(result.extraMetadata.productName, 'Nuwax');
  assert.equal(result.extraMetadata.version, '1.2.3');
  assert.equal(result.mac.extendInfo.CFBundleIdentifier, undefined);
  assert.equal(result.mac.extendInfo.CFBundleDisplayName, '女娲Nuwax');
  assert.equal(result.extraResources.filter((entry) => entry.to === 'nuwax-dist').length, 1);
  assert.equal(result.extraResources.find((entry) => entry.to === 'nuwax-dist').from, '/client/nuwax-dist');
  assert.ok(result.extraResources.some((entry) => entry.to === 'computer-use'));
  assert.equal(result.afterSign, undefined);
  assert.equal(result.publish, null);
  assert.equal(result.deb.packageName, 'nuwax');
  assert.equal(result.win.signAndEditExecutable, true);
  assert.throws(() => builderConfig(pkg, { version: 'bad' }), /semver/);
});

test('local version derives reachable release tags and marks local builds dev', async () => {
  assert.equal(await localVersion('/client', { git: () => 'electron-v1.0.37' }), '1.0.37-dev');
  assert.equal(await localVersion('/client', { git: () => 'prerelease-v1.0.38-beta.1' }), '1.0.38-beta.1-dev');
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
      fs.mkdirSync(generated.directories.output, { recursive: true });
      fs.writeFileSync(path.join(generated.directories.output, 'Nuwax.app'), 'fixture');
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
  });
  assert.deepEqual(events, ['prepare', 'frontend', 'helper', 'build', 'builder']);
  assert.equal(fs.readFileSync(packageFile, 'utf8'), packageText);
});
