import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { dshSourceDigest, DSH_VERSIONS } from './client/dsh-resources.mjs';
const require = createRequire(import.meta.url);
const { nativeTargets } = require('../nuwa-electron-shell/crates/agent-electron-client/scripts/build/dsh-sign-targets.cjs');
const { createMacSigner, withLimitedBinaryProbes } = require('../nuwa-electron-shell/crates/agent-electron-client/scripts/build/dsh-mac-sign.cjs');
const { entitlementsForNative } = require('../nuwa-electron-shell/crates/agent-electron-client/scripts/build/dsh-sign-resources.cjs');
test('Office executable has its limited hardened-runtime permissions; libraries get none', async () => {
 const office = entitlementsForNative('/resources/engine/bin/libreoffice-kit');
 assert.match(office, /entitlements\.office\.plist$/);
 const plist = await fs.readFile(office, 'utf8');
 assert.match(plist, /com\.apple\.security\.cs\.allow-unsigned-executable-memory/);
 assert.doesNotMatch(plist, /disable-library-validation|allow-jit/);
 assert.match(entitlementsForNative('/resources/node'), /entitlements\.child\.plist$/);
 assert.match(entitlementsForNative('/resources/python3.12'), /entitlements\.child\.plist$/);
 assert.equal(entitlementsForNative('/resources/libexample.dylib'), undefined);
});
test('DSH cache includes adapter sources and lock; ignores installed dependencies and acceptance tests', async t => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-inputs-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
 await fs.writeFile(path.join(root, 'host.mjs'), 'one');
 const first = await dshSourceDigest(root);
 for (const directory of ['node_modules', 'test', '.cache']) { await fs.mkdir(path.join(root, directory)); await fs.writeFile(path.join(root, directory, 'artifact'), 'ignored'); }
 assert.equal(await dshSourceDigest(root), first);
 await fs.writeFile(path.join(root, 'package-lock.json'), 'locked'); assert.notEqual(await dshSourceDigest(root), first);
 const pkg = JSON.parse(await fs.readFile(new URL('../nuwa-electron-shell/crates/dsh-runtime/package.json', import.meta.url), 'utf8'));
 assert.equal(pkg.dependencies['@deepseek-ai/dsh'], DSH_VERSIONS.dsh); assert.equal(pkg.dependencies['ds-bot'], DSH_VERSIONS.bot);
});
test('Mac signing bounds file probes, drains failed walks and restores the dependency hook', async () => {
 let active = 0, peak = 0, completed = 0;
 const binary = { isBinaryFile: async value => {
   active++; peak = Math.max(peak, active);
   try { await new Promise(resolve => setImmediate(resolve)); if (value === 5) throw new Error('fixture read failure'); return true; }
   finally { active--; completed++; }
 } };
 const original = binary.isBinaryFile;
 await assert.rejects(withLimitedBinaryProbes(binary, () => Promise.all(Array.from({ length: 200 }, (_, i) => binary.isBinaryFile(i))), 8), /fixture read failure/);
 assert.equal(completed, 200); assert.equal(active, 0); assert.ok(peak <= 8); assert.equal(binary.isBinaryFile, original);
});
test('Mac signer uses the resolved identity and preserves default signing outside owned resources', async () => {
 const calls = [], app = path.join(os.tmpdir(), 'Nuwax.app'), binary = { isBinaryFile: async () => true };
 const signer = createMacSigner({ binary, signResources: async options => calls.push(options), sign: async options => {
   assert.equal(options.ignore(path.join(app, 'Contents/Resources/dsh-runtime/node_modules/native.node')), true);
   assert.equal(options.ignore(path.join(app, 'Contents/Resources/dsh-office/python')), true);
   assert.equal(options.ignore(path.join(app, 'Contents/Resources/presigned-ffmpeg')), true);
   assert.equal(options.ignore(path.join(app, 'Contents/Frameworks/Electron Framework.framework')), false);
   assert.equal(options.ignore(app), false);
   assert.equal(options.entitlements, 'existing-entitlements'); return 'signed';
 } });
 assert.equal(await signer({ app, identity: 'resolved-developer-id', keychain: 'test-keychain', entitlements: 'existing-entitlements', ignore: file => file.endsWith('presigned-ffmpeg') }), 'signed');
 assert.deepEqual(calls, [{ resources: path.join(app, 'Contents/Resources'), identity: 'resolved-developer-id', keychain: 'test-keychain' }]);
});
test('the pinned osx-sign walker uses the bounded dependency probe', async t => {
 const client = createRequire(new URL('../nuwa-electron-shell/crates/agent-electron-client/package.json', import.meta.url));
 const builder = createRequire(client.resolve('electron-builder'));
 const appBuilder = createRequire(builder.resolve('app-builder-lib'));
 const osx = appBuilder('@electron/osx-sign');
 const binary = createRequire(appBuilder.resolve('@electron/osx-sign'))('isbinaryfile');
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-real-sign-walk-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
 for (let i = 0; i < 512; i++) await fs.writeFile(path.join(root, i + '.d.ts.map'), 'fixture text');
 const original = binary.isBinaryFile; let probes = 0, active = 0, peak = 0;
 binary.isBinaryFile = async (...args) => { probes++; active++; peak = Math.max(peak, active); try { return await original(...args); } finally { active--; } };
 try {
   assert.deepEqual(await withLimitedBinaryProbes(binary, () => osx.walkAsync(root), 8), []);
   assert.equal(probes, 512); assert.ok(peak <= 8);
   assert.equal(typeof appBuilder('./codeSign/macCodeSign.js').sign, 'function');
 } finally { binary.isBinaryFile = original; }
});
test('native resource signing finds libraries without execute bits and never follows external links', async t => {
 const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-signing-')); t.after(() => fs.rm(parent, { recursive: true, force: true }));
 const root = path.join(parent, 'payload'); await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });
 const native = path.join(root, 'node_modules', 'extension.so'); await fs.writeFile(native, Buffer.from('cffaedfe00000000', 'hex'), { mode: 0o644 });
 const pe = path.join(root, 'python.pyd'); await fs.writeFile(pe, Buffer.from('4d5a000000000000', 'hex'));
 const external = path.join(parent, 'outside'); await fs.writeFile(external, Buffer.from('feedfacf00000000', 'hex'));
 if (process.platform !== 'win32') { await fs.symlink(external, path.join(root, 'outside-link')); await fs.symlink(native, path.join(root, 'alias')); }
 assert.deepEqual(nativeTargets(root), [await fs.realpath(native)]); assert.deepEqual(nativeTargets(root, 'pe'), [await fs.realpath(pe)]);
});
