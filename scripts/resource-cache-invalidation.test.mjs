import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as core from './client/core.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifactScript = path.join(root, 'scripts/client/build-resource-artifacts.mjs');

test('a rejected helper compiler cache clears the artifact hit before cache staging', t => {
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-cache-invalidation-'));
  t.after(() => fs.rmSync(runnerTemp, { recursive: true, force: true }));

  const key = 'native-helper-v1-darwin-x64-test-key';
  const stateFile = path.join(runnerTemp, `nuwax-resource-helper-${core.fingerprint(key)}.json`);
  fs.writeFileSync(stateFile, JSON.stringify({ hit: true, producerRun: 123, artifact: 456 }));

  const output = execFileSync(process.execPath, [artifactScript, 'invalidate', 'helper', key, 'inner-cache-miss'], {
    cwd: root,
    env: { ...process.env, RUNNER_TEMP: runnerTemp },
    encoding: 'utf8',
  });

  assert.match(output, /helper: invalidated/);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.hit, false);
  assert.equal(state.invalidated, true);
  assert.equal(state.reason, 'inner-cache-miss');
  assert.equal(state.previousProducerRun, 123);
  assert.equal(state.previousArtifact, 456);
});

test('cache invalidation rejects unknown resource kinds', t => {
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-cache-invalidation-'));
  t.after(() => fs.rmSync(runnerTemp, { recursive: true, force: true }));

  assert.throws(() => execFileSync(process.execPath, [artifactScript, 'invalidate', 'other', 'arbitrary-key'], {
    cwd: root,
    env: { ...process.env, RUNNER_TEMP: runnerTemp },
    encoding: 'utf8',
    stdio: 'pipe',
  }));
  assert.deepEqual(fs.readdirSync(runnerTemp), []);
});
