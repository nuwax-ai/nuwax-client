/** Commit update subscriptions only after versioned assets have been verified. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseReleaseTag, parseReleaseVersion, compareReleaseVersions } from './release-version.mjs';

const mirrors = ['s3', 'oss'];
function pointerVersion(bytes, folder) {
  if (bytes === null) return null;
  const version = JSON.parse(Buffer.from(bytes).toString()).version;
  const parsed = parseReleaseVersion(version);
  if (folder === 'latest' && parsed.channel !== 'stable') throw new Error('stable 指针不得包含预发布版本');
  return version;
}

export async function publishPointers(identity, bytes, adapter, finalize = async () => {}) {
  const candidate = JSON.parse(Buffer.from(bytes).toString());
  if (candidate.version !== identity.version) throw new Error('目标元数据版本与 tag 不一致');
  parseReleaseVersion(candidate.version);
  const folders = identity.channel === 'stable' ? ['latest', 'beta'] : ['beta'];
  const previous = new Map(), update = [];
  // Read and validate every intended subscription before making any changes.
  for (const folder of folders) {
    const values = await Promise.all(mirrors.map((mirror) => adapter.read(mirror, folder)));
    if ((values[0] === null) !== (values[1] === null) || values[0] !== null && !Buffer.from(values[0]).equals(Buffer.from(values[1])))
      throw new Error(`${folder}: S3/OSS 通道指针字节不一致`);
    const current = pointerVersion(values[0], folder);
    mirrors.forEach((mirror, index) => previous.set(`${mirror}/${folder}`, values[index]));
    const comparison = current === null ? 1 : compareReleaseVersions(identity.version, current);
    if (comparison < 0) {
      if (identity.channel === 'stable' && folder === 'beta') continue;
      throw new Error(`禁止 ${folder} 通道从 ${current} 降级到 ${identity.version}`);
    }
    if (comparison === 0 && !Buffer.from(values[0]).equals(Buffer.from(bytes)))
      throw new Error(`${folder}: 同版本指针内容不同，禁止替换发布来源`);
    if (comparison > 0) update.push(folder);
  }
  const touched = [];
  try {
    for (const folder of update) {
      for (const mirror of mirrors) {
        // Register before the write: a failed upload may still have changed the object.
        touched.push([mirror, folder]);
        await adapter.write(mirror, folder, bytes);
      }
      for (const mirror of mirrors) {
        const actual = await adapter.read(mirror, folder);
        if (actual === null || !Buffer.from(actual).equals(Buffer.from(bytes))) throw new Error(`${mirror}/${folder}: 指针回读不一致`);
      }
    }
    await finalize();
  } catch (error) {
    const failures = [];
    for (const [mirror, folder] of touched.reverse()) {
      try {
        const old = previous.get(`${mirror}/${folder}`);
        if (old === null) await adapter.remove(mirror, folder);
        else await adapter.write(mirror, folder, old);
        const restored = await adapter.read(mirror, folder);
        if (old === null ? restored !== null : restored === null || !Buffer.from(restored).equals(Buffer.from(old)))
          throw new Error('回滚回读不一致');
      } catch (rollbackError) { failures.push(`${mirror}/${folder}: ${rollbackError.message}`); }
    }
    if (failures.length) throw new AggregateError([error], `${error.message}；回滚失败：${failures.join('; ')}`);
    throw error;
  }
  return { updated: update, retained: folders.filter((folder) => !update.includes(folder)) };
}

function commandAdapter(env, directory) {
  const execute = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const s3Args = ['--endpoint-url', env.S3_ENDPOINT];
  const ossArgs = ['--endpoint', env.OSS_ENDPOINT, '--region', env.OSS_REGION,
    '--access-key-id', env.OSS_ACCESS_KEY_ID, '--access-key-secret', env.OSS_ACCESS_KEY_SECRET];
  const location = (mirror, folder) => `${mirror === 's3' ? `s3://${env.S3_BUCKET}` : env.OSS_BUCKET}/${env.RELEASE_ROOT}/${folder}/latest.json`;
  return {
    async read(mirror, folder) {
      const file = join(directory, `read-${mirror}-${folder}.json`);
      try {
        if (mirror === 's3') execute('aws', ['s3', 'cp', location(mirror, folder), file, ...s3Args, '--no-sign-request']);
        else execute('ossutil', ['cp', '--force', location(mirror, folder), file, ...ossArgs]);
        return readFileSync(file);
      } catch (error) {
        const diagnostic = String(error.stderr ?? '');
        if (/404|NoSuchKey|not found/i.test(diagnostic)) return null;
        // Do not log a child-process error containing credential arguments.
        throw new Error(`${mirror}/${folder}: 指针读取失败（exit ${error.status ?? 'unknown'}）`);
      }
    },
    async write(mirror, folder, bytes) {
      const file = join(directory, `write-${mirror}-${folder}.json`);
      writeFileSync(file, bytes);
      try {
        if (mirror === 's3') execute('aws', ['s3', 'cp', file, location(mirror, folder), ...s3Args]);
        else execute('ossutil', ['cp', '--force', file, location(mirror, folder), ...ossArgs]);
      } catch (error) { throw new Error(`${mirror}/${folder}: 指针写入失败（exit ${error.status ?? 'unknown'}）`); }
    },
    async remove(mirror, folder) {
      try {
        if (mirror === 's3') execute('aws', ['s3', 'rm', location(mirror, folder), ...s3Args]);
        else execute('ossutil', ['rm', '--force', location(mirror, folder), ...ossArgs]);
      } catch (error) { throw new Error(`${mirror}/${folder}: 指针删除失败（exit ${error.status ?? 'unknown'}）`); }
    },
    async finalize(identity) {
      execute('gh', ['release', 'edit', identity.tag, '--draft=false', `--prerelease=${identity.channel === 'beta'}`, '--repo', env.GITHUB_REPOSITORY]);
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = mkdtempSync(join(tmpdir(), 'nuwax-pointers-'));
  try {
    const [tag, metadata, channel] = process.argv.slice(2);
    const identity = parseReleaseTag(tag, { allowLegacy: true });
    if (channel && channel !== identity.channel) throw new Error('tag 与 channel 冲突');
    const adapter = commandAdapter(process.env, directory);
    const result = await publishPointers(identity, readFileSync(metadata), adapter, () => adapter.finalize(identity));
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { rmSync(directory, { recursive: true, force: true }); }
}
