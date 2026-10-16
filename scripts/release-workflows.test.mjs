import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parse } from 'yaml';

const workflow = name => parse(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'));
const list = value => Array.isArray(value) ? value : [value];
const commands = job => job.steps.map(step => step.run ?? '').join('\n');
const commandIndex = (job, part) => {
  const index = job.steps.findIndex(step => step.run?.includes(part));
  assert.ok(index >= 0, `Missing release action: ${part}`);
  return index;
};

test('public releases validate exclusive tag routes, require full source gates and await the platform matrix', () => {
  const stable = workflow('release-electron.yml'), beta = workflow('release-electron-dev.yml');
  assert.deepEqual(stable.on.push.tags, ['v*', '!v*-beta.*']);
  assert.deepEqual(beta.on.push.tags, ['v*-beta.*']);
  assert.equal(stable.on.workflow_dispatch, undefined);
  assert.equal(workflow('ci.yml').on.workflow_call.inputs.full.default, true);
  for (const [value, channel] of [[stable, 'stable'], [beta, 'beta']]) {
    assert.ok(list(value.jobs['verify-source'].needs).includes('validate-tag'));
    assert.equal(value.jobs['verify-source'].uses, './.github/workflows/ci.yml');
    assert.ok(commands(value.jobs['validate-tag']).includes(`scripts/release-version.mjs "$RELEASE_TAG" ${channel}`));
    assert.ok(list(value.jobs.prepare.needs).includes('verify-source'));
    assert.ok(list(value.jobs['build-electron'].needs).includes('prepare'));
  }
  assert.ok(list(beta.jobs['publish-beta'].needs).includes('build-electron'));
  assert.equal(stable.jobs['publish-beta'], undefined);
});

test('pointer publication is serialized and verifies the immutable release source', () => {
  const sync = workflow('sync-electron-to-oss.yml');
  assert.equal(sync.concurrency['cancel-in-progress'], false);
  assert.ok(!sync.concurrency.group.includes('${{'), 'all channels use the same publication queue');
  const job = sync.jobs['sync-to-minio'];
  assert.ok(job.steps.some(step => step.uses?.startsWith('actions/checkout@') && step.with?.ref === '${{ inputs.tag }}' && step.with?.path === 'release-source'));
  assert.ok(commands(job).includes('--source-root release-source'));
  assert.ok(commandIndex(job, 'release-provenance.mjs verify') < commandIndex(job, 'publish-release-pointers.mjs'));
  assert.ok(commandIndex(job, 'release-storage-integrity.mjs verify') < commandIndex(job, 'publish-release-pointers.mjs'));
});

test('published update notes preserve complete UTF-8 text and old-version recovery instructions', () => {
  const job = workflow('sync-electron-to-oss.yml').jobs['sync-to-minio'];
  const assignment = commands(job).split('\n').find(line => line.trimStart().startsWith('NOTES='));
  assert.ok(assignment);
  const body = `${'修复客户端更新与中文显示。'.repeat(30)}🚀\n已安装且缺升级文件的 macOS 旧版，请下载完整 DMG 覆盖安装本版。`;
  assert.ok(Buffer.byteLength(body) > 500);
  for (const [release, expected] of [
    [{ body }, body],
    [{ body: null }, '女娲Nuwax 功能优化和问题修复。建议更新到最新版本以获得更好的体验。'],
    [{ body: '' }, ''],
  ]) {
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', `${assignment}\nprintf '%s' "$NOTES"`], {
      encoding: 'utf8', env: { ...process.env, RELEASE_JSON: JSON.stringify(release) },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected);
    assert.ok(!result.stdout.includes('\uFFFD'));
  }
});

test('all platform packages verify capture and updater payloads before uploading', () => {
  for (const name of ['release-electron.yml', 'release-electron-dev.yml']) {
    const job = workflow(name).jobs['build-electron'];
    assert.deepEqual(job.strategy.matrix.include.map(m => `${m.platform.split('-')[0]}:${m.arch}`).sort(),
      ['macos:arm64', 'macos:x64', 'ubuntu:arm64', 'ubuntu:x64', 'windows:x64']);
    const prepare = commandIndex(job, 'node scripts/prepare-release-capture.mjs --arch');
    const build = commandIndex(job, '--dir --publish never');
    const configureUpdater = job.steps.findIndex(step => step.run?.trim() === 'node scripts/prepare-release-updater.mjs');
    const capture = commandIndex(job, 'node scripts/prepare-release-capture.mjs --arch "$TARGET_ARCH" --verify-output');
    const updater = commandIndex(job, 'node scripts/prepare-release-updater.mjs --arch "$TARGET_ARCH" --verify-output');
    const upload = commandIndex(job, 'gh release upload');
    assert.ok(configureUpdater >= 0 && configureUpdater < build);
    assert.ok(prepare < build && build < capture && capture < upload && build < updater && updater < upload);
    const updaterStep = job.steps[updater];
    assert.equal(updaterStep.env.OUT_DIR, '${{ steps.packaged_resources.outputs.output_dir }}');
    const stage = job.steps.findIndex(step => step.run?.includes('qa-build-context.json'));
    if (stage >= 0) assert.ok(updater < stage);
    const notarize = commandIndex(job, '--phase notarize');
    const pack = commandIndex(job, '--phase package');
    assert.ok(build < notarize && notarize < pack && pack < capture);
  }
});
