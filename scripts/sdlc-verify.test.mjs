import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inputFiles, runVerification } from './sdlc-verify.mjs';

test('verification rejects recipe and input paths escaping through parent symlinks', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-verify-paths-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repo');
  const outside = path.join(temp, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'valid.txt'), 'inside');
  fs.writeFileSync(path.join(outside, 'input.txt'), 'outside');
  fs.writeFileSync(path.join(outside, 'recipe.json'), '{}');
  try {
    fs.symlinkSync(outside, path.join(root, 'alias'), 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('directory symlinks unavailable');
    throw error;
  }

  assert.equal(inputFiles(root, ['valid.txt'])[0].path, 'valid.txt');
  assert.throws(() => inputFiles(root, ['alias/input.txt']), /input escapes repository/);
  await assert.rejects(runVerification({ root, recipePath: 'alias/recipe.json', output: path.join(temp, 'output') }),
    /recipe escapes repository/);
  assert.equal(fs.existsSync(path.join(temp, 'output')), false);
});
