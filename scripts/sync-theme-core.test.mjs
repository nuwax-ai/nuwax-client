import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncThemeCore } from './sync-theme-core.mjs';

const temporary = [];
afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-core-'));
  temporary.push(root);
  const source = path.join(root, 'nuwax/src/features/themes/core');
  const target = path.join(root, 'nuwa-electron-shell/crates/agent-electron-client/src/shared/features/themes/core');
  fs.mkdirSync(source, { recursive: true });
  for (const relative of ['nuwax', 'nuwa-electron-shell/crates/agent-electron-client']) {
    const packagePath = path.join(root, relative, 'package.json');
    fs.mkdirSync(path.dirname(packagePath), { recursive: true });
    fs.writeFileSync(packagePath, JSON.stringify({ dependencies: { postcss: '1', 'postcss-selector-parser': '2', 'postcss-value-parser': '3' } }));
  }
  fs.writeFileSync(path.join(source, 'index.mjs'), "export { value } from './tokens.mjs';\n");
  fs.writeFileSync(path.join(source, 'tokens.mjs'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(source, 'index.d.mts'), 'export type ThemeMode = "light" | "dark";\n');
  fs.writeFileSync(path.join(source, '../dom.ts'), "import { value } from './core';\n");
  fs.writeFileSync(path.join(source, '../archive.ts'), "import { value } from './core';\n");
  fs.writeFileSync(path.join(source, 'core.test.mjs'), 'must not copy tests');
  fs.writeFileSync(path.join(source, 'vitest.config.mjs'), 'must not copy tooling');
  return { root, source, target };
}
test('copies the canonical runtime with compile-safe imports, excluding tests', () => {
  const f = fixture();
  assert.deepEqual(syncThemeCore(f.root), { changed: true, files: 5 });
  assert.match(fs.readFileSync(path.join(f.target, 'index.ts'), 'utf8'), /from '\.\/tokens'/);
  assert.deepEqual(fs.readdirSync(f.target).sort(), ['archive.ts', 'dom.ts', 'index.ts', 'tokens.ts', 'types.ts']);
  assert.equal(syncThemeCore(f.root, { check: true }).changed, false);
});
test('detects drift without modifying snapshots and removes stale generated modules only on sync', () => {
  const f = fixture();
  syncThemeCore(f.root);
  const target = path.join(f.target, 'tokens.ts');
  const before = fs.readFileSync(target);
  fs.appendFileSync(path.join(f.source, 'tokens.mjs'), 'export const changed = true;\n');
  assert.throws(() => syncThemeCore(f.root, { check: true }), /snapshot is stale/);
  assert.deepEqual(fs.readFileSync(target), before);
  syncThemeCore(f.root);
  fs.writeFileSync(path.join(f.target, 'obsolete.ts'), 'obsolete');
  assert.throws(() => syncThemeCore(f.root, { check: true }), /Unexpected/);
  syncThemeCore(f.root);
  assert.equal(fs.existsSync(path.join(f.target, 'obsolete.ts')), false);
});
test('rejects parser dependency skew between host and web', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.root, 'nuwax/package.json'), '{"dependencies":{}}');
  assert.throws(() => syncThemeCore(f.root), /versions differ/);
});
