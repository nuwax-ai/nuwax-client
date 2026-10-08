import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReleaseVersion, parseReleaseTag, compareReleaseVersions, releaseSequenceFindings, releaseTagHistory } from './release-version.mjs';

const sha = 'a'.repeat(40), other = 'b'.repeat(40);
const refs = (...tags) => tags.map((tag) => `${sha}\trefs/tags/${tag}`).join('\n');
const findings = (tag, history) => releaseSequenceFindings(parseReleaseTag(tag), sha, refs(...history));

test('canonical versions reject every unsupported suffix and noncanonical number', () => {
  for (const value of ['', '1.2', '01.2.3', '1.2.03', '1.2.3-beta', '1.2.3-beta.0', '1.2.3-beta.01', '1.2.3-alpha.1', '1.2.3-rc.1', '1.2.3-dev', '1.2.3+build', 'v1.2.3', '1.2.3\n'])
    assert.throws(() => parseReleaseVersion(value));
  assert.equal(parseReleaseTag('v3.0.11-beta.1').channel, 'beta');
  assert.equal(parseReleaseTag('v3.0.11').channel, 'stable');
  assert.throws(() => parseReleaseTag('electron-v3.0.9'));
  assert.equal(parseReleaseTag('prerelease-v3.0.8', { allowLegacy: true }).channel, 'beta');
});

test('SemVer compares numeric beta identifiers and promotion', () => {
  for (const [left, right] of [['3.0.11-beta.2', '3.0.11-beta.10'], ['3.0.11-beta.10', '3.0.11'], ['3.0.11', '3.0.12-beta.1'], ['3.0.9', '3.0.10']]) {
    assert.equal(compareReleaseVersions(left, right), -1);
    assert.equal(compareReleaseVersions(right, left), 1);
  }
  assert.equal(compareReleaseVersions('3.0.11-beta.1', '3.0.11-beta.1'), 0);
});

test('multiple betas, promotion, direct and consecutive stable releases', () => {
  assert.deepEqual(findings('v3.0.11-beta.1', ['v3.0.10']), []);
  assert.deepEqual(findings('v3.0.11-beta.2', ['v3.0.11-beta.1']), []);
  assert.deepEqual(findings('v3.0.11', ['v3.0.11-beta.1', 'v3.0.11-beta.2']), []);
  assert.deepEqual(findings('v3.0.12', ['v3.0.11']), []);
  assert.deepEqual(findings('v3.0.10', ['electron-v3.0.9', 'prerelease-v3.0.8']), []);
  assert.match(findings('v3.0.11-beta.3', ['v3.0.11'])[0], /关闭/);
  assert.match(findings('v3.0.11-beta.2', [])[0], /序号须为 1/);
  assert.match(findings('v3.0.11-beta.3', ['v3.0.11-beta.1'])[0], /序号须为 2/);
  assert.match(findings('v3.0.9', ['electron-v3.0.9'])[0], /占用/);
  assert.match(findings('v3.0.8-beta.1', ['prerelease-v3.0.8'])[0], /占用/);
});

test('annotated tags use peeled SHA and immutable recovery bypasses newer history', () => {
  const history = `${other}\trefs/tags/v3.0.11\n${sha}\trefs/tags/v3.0.11^{}\n${refs('v3.0.12')}`;
  assert.equal(releaseTagHistory(history)[0].sha, sha);
  assert.deepEqual(releaseSequenceFindings(parseReleaseTag('v3.0.11'), sha, history), []);
  assert.match(releaseSequenceFindings(parseReleaseTag('v3.0.11'), other, history)[0], /禁止改 tag/);
  assert.match(releaseSequenceFindings(parseReleaseTag('electron-v3.0.9', { allowLegacy: true }), sha, '')[0], /只能续跑/);
});
