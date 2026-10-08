import assert from 'node:assert/strict';
import test from 'node:test';
import { publishPointers } from './publish-release-pointers.mjs';
import { parseReleaseTag } from './release-version.mjs';

const metadata = (version) => Buffer.from(JSON.stringify({ version, yml: { win: `https://example.invalid/v${version}/latest.yml` } }));
function fixture(latest, beta) {
  const data = new Map();
  for (const mirror of ['s3', 'oss']) for (const [folder, version] of [['latest', latest], ['beta', beta]])
    data.set(`${mirror}/${folder}`, version ? metadata(version) : null);
  const original = new Map(data), calls = [], faults = {};
  const adapter = {
    async read(mirror, folder) { if (faults.read === `${mirror}/${folder}`) throw new Error('read failed'); return data.get(`${mirror}/${folder}`); },
    async write(mirror, folder, bytes) {
      const key = `${mirror}/${folder}`; calls.push(['write', key]); data.set(key, bytes);
      if (faults.write === key) { delete faults.write; throw new Error('partial write failed'); }
      if (faults.corrupt === key) { data.set(key, metadata('0.0.0')); delete faults.corrupt; }
    },
    async remove(mirror, folder) { calls.push(['remove', `${mirror}/${folder}`]); data.set(`${mirror}/${folder}`, null); },
  };
  return { data, original, calls, faults, run: (tag, finalize) => publishPointers(parseReleaseTag(tag), metadata(tag.slice(1)), adapter, finalize) };
}

test('stable promotes both subscriptions, beta changes only beta', async () => {
  const stable = fixture('3.0.10', '3.0.11-beta.2');
  assert.deepEqual((await stable.run('v3.0.11')).updated, ['latest', 'beta']);
  for (const bytes of stable.data.values()) assert.deepEqual(bytes, metadata('3.0.11'));
  const beta = fixture('3.0.11', '3.0.11');
  assert.deepEqual((await beta.run('v3.0.12-beta.1')).updated, ['beta']);
  assert.deepEqual(beta.data.get('oss/latest'), metadata('3.0.11'));
});

test('stable retains a newer beta while updating stable', async () => {
  const f = fixture('3.0.10', '3.0.12-beta.1');
  assert.deepEqual(await f.run('v3.0.11'), { updated: ['latest'], retained: ['beta'] });
  assert.deepEqual(f.data.get('s3/beta'), metadata('3.0.12-beta.1'));
});

test('downgrades, inconsistent mirrors and invalid pointers fail before writes', async () => {
  const cases = [fixture('3.0.12', '3.0.12'), fixture('3.0.10', '3.0.11-beta.10')];
  await assert.rejects(cases[0].run('v3.0.11'), /降级/);
  await assert.rejects(cases[1].run('v3.0.11-beta.2'), /降级/);
  const unequal = fixture('3.0.10', '3.0.10'); unequal.data.set('oss/beta', metadata('3.0.11'));
  await assert.rejects(unequal.run('v3.0.11'), /字节不一致/); cases.push(unequal);
  const absent = fixture('3.0.10', null); absent.data.set('oss/beta', metadata('3.0.10'));
  await assert.rejects(absent.run('v3.0.11'), /字节不一致/); cases.push(absent);
  const invalid = fixture('3.0.10-beta.1', '3.0.10');
  await assert.rejects(invalid.run('v3.0.11'), /stable 指针/); cases.push(invalid);
  for (const f of cases) assert.deepEqual(f.calls, []);
});

test('every partial upload, failed readback and finalization failure restores all pointers', async () => {
  for (const key of ['s3/latest', 'oss/latest', 's3/beta', 'oss/beta']) {
    for (const type of ['write', 'corrupt']) {
      const f = fixture('3.0.10', '3.0.10'); f.faults[type] = key;
      await assert.rejects(f.run('v3.0.11'));
      assert.deepEqual(f.data, f.original);
    }
  }
  const f = fixture(null, null);
  await assert.rejects(f.run('v3.0.11', async () => { throw new Error('publish failed'); }));
  assert.deepEqual(f.data, f.original);
});

test('same identity is idempotent but same-version source replacement is refused', async () => {
  const f = fixture('3.0.11', '3.0.11');
  assert.deepEqual((await f.run('v3.0.11')).updated, []);
  assert.deepEqual(f.calls, []);
  for (const mirror of ['s3', 'oss']) f.data.set(`${mirror}/latest`, Buffer.from('{"version":"3.0.11","other":true}'));
  await assert.rejects(f.run('v3.0.11'), /同版本/);
  assert.deepEqual(f.calls, []);
});
