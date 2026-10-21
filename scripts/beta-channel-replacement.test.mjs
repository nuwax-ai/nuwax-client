import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { allowsBetaChannelReplacement, readBetaChannelReplacement } from './beta-channel-replacement.mjs';
import { publishPointers } from './publish-release-pointers.mjs';
import { preventPointerDowngrade } from './client/release.mjs';
import { parseReleaseTag } from './release-version.mjs';

const identity = parseReleaseTag('v3.0.20-beta.1');
const old = Buffer.from('{"version":"3.1.0-beta.5","source":"verified-old-release"}');
const candidate = Buffer.from('{"version":"3.0.20-beta.1"}');
const policy = { tag: identity.tag, fromVersion: '3.1.0-beta.5', fromSha256: createHash('sha256').update(old).digest('hex') };

test('replacement requires the exact Beta target, old version and old bytes', () => {
  assert.equal(allowsBetaChannelReplacement(identity, 'beta', old, policy), true);
  for (const [target, folder, bytes, permission] of [
    [identity, 'latest', old, policy], [parseReleaseTag('v3.0.20'), 'beta', old, policy],
    [parseReleaseTag('v3.0.20-beta.2'), 'beta', old, policy], [identity, 'beta', null, policy],
    [identity, 'beta', Buffer.from('{"version":"3.1.0-beta.5","source":"changed"}'), policy],
    [identity, 'beta', old, { ...policy, fromVersion: '3.1.0-beta.4' }], [identity, 'beta', old, null],
  ]) assert.equal(allowsBetaChannelReplacement(target, folder, bytes, permission), false);
  assert.equal(readBetaChannelReplacement(identity).tag, identity.tag);
  for (const tag of ['v3.0.20-beta.2', 'v3.0.20-beta.3']) assert.equal(readBetaChannelReplacement(parseReleaseTag(tag)).tag, tag);
  assert.equal(readBetaChannelReplacement(parseReleaseTag('v0.0.0-beta.1')), null);
  assert.equal(readBetaChannelReplacement(parseReleaseTag('v3.0.20')), null);
});

test('explicit replacement updates only Beta and rolls back any failed write or publication', async () => {
  for (const fault of [null, 's3', 'oss', 'finalize']) {
    const data = new Map([['s3', old], ['oss', old]]), writes = [];
    let injected = false;
    const adapter = {
      read: async (mirror, folder) => { assert.equal(folder, 'beta'); return data.get(mirror); },
      write: async (mirror, folder, bytes) => {
        assert.equal(folder, 'beta'); writes.push(mirror); data.set(mirror, bytes);
        if (fault === mirror && !injected) { injected = true; throw new Error('upload failed'); }
      },
    };
    const finalize = async () => { if (fault === 'finalize') throw new Error('publish failed'); };
    const run = () => publishPointers(identity, candidate, adapter, finalize, undefined, policy);
    if (fault) { await assert.rejects(run()); for (const bytes of data.values()) assert.deepEqual(bytes, old); }
    else {
      assert.deepEqual(await run(), { updated: ['beta'], retained: [] });
      for (const bytes of data.values()) assert.deepEqual(bytes, candidate);
      assert.deepEqual(await run(), { updated: [], retained: ['beta'] });
      assert.deepEqual(writes, ['s3', 'oss']);
    }
  }
});

test('CLI pre-dispatch guard uses the same exact-source exception', async () => {
  const tools = { fetchBytes: async () => old };
  const settings = { s3Base: 'https://s3.invalid', ossBase: 'https://oss.invalid' };
  await preventPointerDowngrade(tools, settings, identity, policy);
  await assert.rejects(preventPointerDowngrade(tools, settings, identity, null), /降级/);
  tools.fetchBytes = async url => url.startsWith(settings.s3Base) ? old : Buffer.from('{"version":"3.1.0-beta.5","source":"changed"}');
  await assert.rejects(preventPointerDowngrade(tools, settings, identity, policy), /降级/);
});
