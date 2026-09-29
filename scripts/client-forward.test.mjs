import test from 'node:test';
import assert from 'node:assert/strict';
import { forwardEnv } from './client/forward.mjs';
import config from '../client.config.mjs';

test('forward injects commercial release defaults and branch ref for base scripts', () => {
  const env = forwardEnv({}, 'release/v1.0.x');
  assert.equal(env.SIGN_RELEASE_REPO, config.release.repo);
  assert.equal(env.SYNC_OSS_REPO, config.release.repo);
  assert.equal(env.SIGN_WIN_ARTIFACT_PREFIX, config.product.name);
  assert.equal(env.SYNC_OSS_REF, 'release/v1.0.x');
});
test('forward keeps caller-provided values and skips ref when detached', () => {
  const env = forwardEnv({ SIGN_RELEASE_REPO: 'other/repo', SYNC_OSS_REF: 'main' }, '');
  assert.equal(env.SIGN_RELEASE_REPO, 'other/repo');
  assert.equal(env.SYNC_OSS_REF, undefined);
});
