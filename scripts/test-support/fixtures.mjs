import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DSH_VERSIONS } from '../client/dsh-resources.mjs';

export function writeDshResourcesFixture(resources, platform, arch) {
  const write = (relative, content = 'runtime fixture') => {
    const file = path.join(resources, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  write('dsh-runtime/nuwax-runtime.json', JSON.stringify({ platform, arch, ...DSH_VERSIONS }));
  write('dsh-office/primary-runtime/runtime.json', JSON.stringify({ platform, arch }));
  for (const relative of [
    'dsh-runtime/host.mjs', 'dsh-runtime/controller.mjs', 'dsh-runtime/desktop.mjs',
    'dsh-runtime/workbench-host.mjs', 'dsh-runtime/workbench-channel.mjs', 'dsh-runtime/workbench-presets.mjs',
    'dsh-runtime/workbench/host.mjs', 'dsh-runtime/workbench/client.js',
    'dsh-runtime/node_modules/@deepseek-ai/dsh/lib/profile-boot.js',
    'dsh-runtime/node_modules/ds-bot/index.js', 'dsh-runtime/node_modules/ds-bot/client.js',
    'dsh-runtime/node_modules/@deepseek-ai/libreoffice-kit/lib/index.js',
    'dsh-office/LICENSES.txt',
    'dsh-office/primary-runtime/dependencies/node/bin/' + (platform === 'win32' ? 'node.exe' : 'node'),
    'dsh-office/primary-runtime/dependencies/python/' + (platform === 'win32' ? 'python.exe' : 'bin/python3'),
  ]) write(relative);
}

export function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-script-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

export function installedBuilder(t) {
  const override = process.env.NUWAX_TEST_BUILDER_CLIENT_DIR;
  if (override) assert.ok(path.isAbsolute(override), 'Builder override must be an absolute client directory');
  const client = override ?? fileURLToPath(new URL('../../nuwa-electron-shell/crates/agent-electron-client', import.meta.url));
  const require = createRequire(import.meta.url);
  let file;
  try { file = require.resolve('electron-builder/package.json', { paths: [client] }); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND' || override) throw error;
    t.skip('Requires installed electron-builder');
    return null;
  }
  const builder = createRequire(file);
  assert.equal(builder('./package.json').version, '25.1.8');
  builder('app-builder-lib');
  return builder;
}
