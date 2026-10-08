/** Canonical release identity. Historical tags are read-only recovery inputs. */
import { pathToFileURL } from 'node:url';

const core = '(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)';
const versionPattern = new RegExp(`^${core}(?:-beta\\.([1-9]\\d*))?$`);

export function parseReleaseVersion(version) {
  const match = versionPattern.exec(version ?? '');
  if (!match || match[0] !== version) throw new Error('版本须为 X.Y.Z 或 X.Y.Z-beta.N（N 从 1 开始，无前导零）');
  return { version, baseVersion: match.slice(1, 4).join('.'), line: `${match[1]}.${match[2]}`,
    beta: match[4] ?? null, channel: match[4] ? 'beta' : 'stable' };
}

export function parseReleaseTag(tag, { allowLegacy = false } = {}) {
  if (typeof tag !== 'string') throw new Error('须指定发布 tag');
  if (tag.startsWith('v')) return { ...parseReleaseVersion(tag.slice(1)), tag, legacy: false };
  const match = /^(electron|prerelease)-v(.+)$/.exec(tag);
  if (!allowLegacy || !match) throw new Error(`无效发布 tag: ${tag}`);
  const parsed = parseReleaseVersion(match[2]);
  if (parsed.beta) throw new Error(`无效历史 tag: ${tag}`);
  return { ...parsed, tag, channel: match[1] === 'prerelease' ? 'beta' : 'stable', legacy: true };
}

export function compareReleaseVersions(a, b) {
  const left = parseReleaseVersion(a), right = parseReleaseVersion(b);
  const lc = left.baseVersion.split('.').map(BigInt), rc = right.baseVersion.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (lc[i] !== rc[i]) return lc[i] > rc[i] ? 1 : -1;
  if (left.beta === right.beta) return 0;
  if (left.beta === null) return 1;
  if (right.beta === null) return -1;
  return BigInt(left.beta) > BigInt(right.beta) ? 1 : -1;
}

export function releaseTagHistory(refs) {
  const tags = new Map();
  for (const line of refs.trim().split('\n')) {
    const match = /^(\S+)\s+refs\/tags\/(.+?)(\^\{\})?$/.exec(line);
    if (!match) continue;
    let identity;
    try { identity = parseReleaseTag(match[2], { allowLegacy: true }); } catch { continue; }
    if (match[3] || !tags.has(identity.tag)) tags.set(identity.tag, { ...identity, sha: match[1] });
  }
  return [...tags.values()];
}

export function releaseSequenceFindings(identity, sha, refs) {
  const tags = releaseTagHistory(refs);
  const own = tags.find((tag) => tag.tag === identity.tag);
  if (own) return own.sha === sha ? [] : [`远端 ${identity.tag} 已指向另一提交 ${own.sha}，禁止改 tag；请使用新版本`];
  if (identity.resumeOnly || identity.legacy) return [`--tag 只能续跑已存在的发布：${identity.tag}`];
  const history = tags.filter((tag) => tag.line === identity.line);
  const collision = history.find((tag) => tag.version === identity.version);
  if (collision) return [`版本 ${identity.version} 已被 ${collision.tag} 占用`];
  const completed = history.filter((tag) => tag.channel === 'stable' || tag.legacy);
  if (completed.some((tag) => compareReleaseVersions(identity.baseVersion, tag.baseVersion) <= 0))
    return [`${identity.baseVersion} 已被正式版或历史版本占用；新版本必须大于已占用版本，同号 beta 已关闭`];
  if (identity.channel === 'beta') {
    const previous = history.filter((tag) => tag.channel === 'beta' && !tag.legacy);
    if (previous.some((tag) => compareReleaseVersions(identity.version, tag.version) <= 0))
      return [`新 beta 版本 ${identity.version} 必须大于已占用的 beta 版本`];
    const serials = previous.filter((tag) => tag.baseVersion === identity.baseVersion).map((tag) => BigInt(tag.beta));
    const next = serials.reduce((max, value) => value > max ? value : max, 0n) + 1n;
    if (BigInt(identity.beta) !== next) return [`${identity.baseVersion} 下一 beta 序号须为 ${next}`];
  }
  return [];
}

// Workflow outputs deliberately contain only canonical, validated identifiers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [tag, channel, legacy] = process.argv.slice(2);
    const identity = parseReleaseTag(tag, { allowLegacy: legacy === '--allow-legacy' });
    if (channel && channel !== identity.channel) throw new Error(`tag ${tag} 属于 ${identity.channel}，与 channel=${channel} 冲突`);
    console.log(`version=${identity.version}\nchannel=${identity.channel}\ntag=${identity.tag}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
