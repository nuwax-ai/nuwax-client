#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resources = path.join(root, 'nuwa-electron-shell/crates/agent-electron-client/resources');
const runtime = path.join(resources, 'dsh-runtime');
const read = async name => JSON.parse(await readFile(path.join(runtime, name), 'utf8'));
const marker = await read('nuwax-runtime.json');
assert.equal(marker.platform, process.platform); assert.equal(marker.arch, process.arch);
for (const [name, version] of [['@deepseek-ai/dsh', '0.2.1-rc.5'], ['ds-bot', '0.2.7'], ['@deepseek-ai/libreoffice-kit', '0.1.5']]) {
  assert.equal((await read('node_modules/' + name + '/package.json')).version, version);
}
const require = createRequire(path.join(runtime, 'package.json'));
assert.ok(require('sherpa-onnx-node'), 'Native SenseVoice runtime did not load');
const { resolvePrimaryRuntime } = await import(pathToFileURL(path.join(runtime, 'node_modules/@deepseek-ai/dsh-tool-workspace-dependencies/lib/index.js')).href);
const office = path.join(resources, 'dsh-office');
const entries = await resolvePrimaryRuntime(path.join(office, 'primary-runtime'));
await access(entries.node); await access(entries.python); await access(path.join(office, 'LICENSES.txt'));
const { discoverRuntime } = await import(pathToFileURL(path.join(runtime, 'node_modules/@deepseek-ai/libreoffice-kit/lib/index.js')).href);
const engine = await discoverRuntime();
assert.ok(engine, 'Office engine is unavailable');
console.log(JSON.stringify({ level: 'native-resource-admission', platform: process.platform, arch: process.arch, dsh: marker.dsh, bot: marker.bot, speechNative: true, office: true }));
