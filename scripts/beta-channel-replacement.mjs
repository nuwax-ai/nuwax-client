import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseReleaseTag, parseReleaseVersion } from './release-version.mjs';

/** A committed, exact-source exception for a deliberate Beta maintenance-line switch. */
export function readBetaChannelReplacement(identity) {
  if (identity.channel !== 'beta') return null;
  const parsed = parseReleaseTag(identity.tag, { allowLegacy: true });
  if (parsed.version !== identity.version || parsed.channel !== 'beta') throw new Error('Beta 替换目标身份无效');
  try {
    const policy = JSON.parse(readFileSync(new URL(`../release-notes/${identity.tag}.channel.json`, import.meta.url), 'utf8'));
    if (policy.tag !== identity.tag || parseReleaseVersion(policy.fromVersion).channel !== 'beta' ||
        !/^[a-f0-9]{64}$/.test(policy.fromSha256 ?? '') || !policy.reason?.trim())
      throw new Error('Beta 通道替换记录无效');
    return policy;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function allowsBetaChannelReplacement(identity, folder, bytes, policy) {
  if (!policy || identity.channel !== 'beta' || folder !== 'beta' || bytes === null || policy.tag !== identity.tag) return false;
  const parsed = parseReleaseTag(identity.tag, { allowLegacy: true });
  if (parsed.version !== identity.version || parsed.channel !== 'beta' ||
      parseReleaseVersion(policy.fromVersion).channel !== 'beta') return false;
  return JSON.parse(Buffer.from(bytes).toString()).version === policy.fromVersion &&
    createHash('sha256').update(bytes).digest('hex') === policy.fromSha256;
}
