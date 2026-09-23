import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('overlay --check fails on drift and succeeds after files match', () => {
  const root = mkdtempSync(join(tmpdir(), 'overlay-check-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'overlay'));
    mkdirSync(join(root, 'nuwa-electron-shell', '.git'), { recursive: true });
    copyFileSync(new URL('./sync-overlay.js', import.meta.url), join(root, 'scripts', 'sync-overlay.js'));
    writeFileSync(join(root, 'overlay', 'sample.txt'), 'commercial');
    const run = () => spawnSync(process.execPath, [join(root, 'scripts', 'sync-overlay.js'), '--check'], { encoding: 'utf8' });
    assert.equal(run().status, 1);
    writeFileSync(join(root, 'nuwa-electron-shell', 'sample.txt'), 'commercial');
    assert.equal(run().status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
