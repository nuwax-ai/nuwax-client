import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { dshSourceDigest, DSH_VERSIONS } from './client/dsh-resources.mjs';
const require = createRequire(import.meta.url);
const { nativeTargets } = require('../nuwa-electron-shell/crates/agent-electron-client/scripts/build/dsh-sign-targets.cjs');
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
test('native resource signing finds libraries without execute bits and never follows external links', async t => {
 const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-signing-')); t.after(() => fs.rm(parent, { recursive: true, force: true }));
 const root = path.join(parent, 'payload'); await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });
 const native = path.join(root, 'node_modules', 'extension.so'); await fs.writeFile(native, Buffer.from('cffaedfe00000000', 'hex'), { mode: 0o644 });
 const pe = path.join(root, 'python.pyd'); await fs.writeFile(pe, Buffer.from('4d5a000000000000', 'hex'));
 const external = path.join(parent, 'outside'); await fs.writeFile(external, Buffer.from('feedfacf00000000', 'hex'));
 if (process.platform !== 'win32') { await fs.symlink(external, path.join(root, 'outside-link')); await fs.symlink(native, path.join(root, 'alias')); }
 assert.deepEqual(nativeTargets(root), [await fs.realpath(native)]); assert.deepEqual(nativeTargets(root, 'pe'), [await fs.realpath(pe)]);
});
