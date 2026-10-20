import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import patches from './source-patches.cjs';

test('source patches affect only disposable copies and accept an already upstreamed fix', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-patch-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'service.js'), 'old\n');
  const patch = path.join(root, 'fix.patch');
  fs.writeFileSync(patch, 'diff --git a/service.js b/service.js\n--- a/service.js\n+++ b/service.js\n@@ -1 +1 @@\n-old\n+new\n');
  const built = patches.createPatchedSource(source, patch);
  try {
    assert.equal(fs.readFileSync(path.join(built.directory, 'service.js'), 'utf8'), 'new\n');
    assert.equal(fs.readFileSync(path.join(source, 'service.js'), 'utf8'), 'old\n');
    const upstream = patches.createPatchedSource(built.directory, patch);
    try { assert.equal(fs.readFileSync(path.join(upstream.directory, 'service.js'), 'utf8'), 'new\n'); }
    finally { upstream.dispose(); }
  } finally { built.dispose(); }
  fs.writeFileSync(path.join(source, 'service.js'), 'incompatible\n');
  assert.throws(() => patches.createPatchedSource(source, patch), /no longer applies/);
  fs.writeFileSync(path.join(source, 'service.js'), 'old\r\n');
  const windows = patches.createPatchedSource(source, patch);
  try {
    assert.match(fs.readFileSync(path.join(windows.directory, 'service.js'), 'utf8'), /^new\r?\n$/);
    assert.equal(fs.readFileSync(path.join(source, 'service.js'), 'utf8'), 'old\r\n');
  } finally { windows.dispose(); }
});
