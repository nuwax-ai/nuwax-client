import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = (name) => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
test('public release routes are exclusive, validated before gates, and beta publication needs the matrix', () => {
  const stable = workflow('release-electron.yml'), beta = workflow('release-electron-dev.yml');
  assert.match(stable, /tags:\n\s+- "v\*"\n\s+- "!v\*-beta\.\*"/);
  assert.match(beta, /tags:\n\s+- "v\*-beta\.\*"/);
  for (const [text, channel] of [[stable, 'stable'], [beta, 'beta']]) {
    assert.ok(text.indexOf('  validate-tag:') < text.indexOf('  verify-source:'));
    assert.match(text, /verify-source:\n(?:[^\n]*\n)*?\s+needs: validate-tag/);
    assert.ok(text.includes(`node scripts/release-version.mjs "$RELEASE_TAG" ${channel}`));
    for (const tag of channel === 'stable' ? ['v3.0.10', 'v3.0.11'] : ['v3.0.11-beta.1', 'v3.0.11-beta.10']) {
      const result = spawnSync(process.execPath, [new URL('./release-version.mjs', import.meta.url).pathname, tag, channel], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`channel=${channel}`));
    }
    for (const tag of ['v03.0.11', 'v3.0.11-beta.0', 'v3.0.11-rc.1', 'v3.0.11-dev', 'v3.0.11+build']) {
      const result = spawnSync(process.execPath, [new URL('./release-version.mjs', import.meta.url).pathname, tag, channel], { encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
    }
  }
  assert.match(beta, /publish-beta:\n(?:[^\n]*\n)*?\s+needs: build-electron/);
  assert.doesNotMatch(stable, /publish-beta:|workflow_dispatch:/);
});

test('all pointer publications share one queue and current tools verify a separately checked out source', () => {
  const sync = workflow('sync-electron-to-oss.yml');
  assert.match(sync, /group: nuwax-update-subscriptions\n\s+cancel-in-progress: false/);
  assert.doesNotMatch(sync, /group:.*inputs\.channel/);
  assert.ok(sync.indexOf('Checkout release automation') < sync.indexOf('Validate release tag and channel'));
  assert.match(sync, /ref: \$\{\{ inputs.tag \}\}\n\s+path: release-source/);
  assert.match(sync, /--source-root release-source/);
  assert.match(sync, /node scripts\/publish-release-pointers.mjs/);
});
