import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

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
