import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { validationIdentity, assertValidationBudget, checkValidationBudget, buildValidation, stageValidation } from './package-validation.mjs';

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-validation-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},nuwa-electron-shell`);
  git('update-index', '--add', '--cacheinfo', `160000,${'2'.repeat(40)},nuwax`);
  git('update-index', '--add', '--cacheinfo', `160000,${'3'.repeat(40)},nuwax-dist`);
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'frozen source');
  git('tag', 'v3.0.23-beta.3'); git('tag', 'v3.0.22');
  const env = { VALIDATION_SERIES: 'pr-66', VALIDATION_BASELINE_TAG: 'v3.0.23-beta.3',
    VALIDATION_PLATFORMS: 'both', GITHUB_REF: 'refs/heads/codex/cua-repairs', GITHUB_SHA: git('rev-parse', 'HEAD'),
    GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' };
  const prepared = { frontend: { sourceSha: '2'.repeat(40), distSha: '3'.repeat(40), stamp: '2222222' } };
  return { cwd, git, env, prepared, identity: validationIdentity(cwd, env) };
}
const run = (id, attempts, series = 'pr-66', extra = {}) => ({ id, run_attempt: attempts, display_title: `Package validation / ${series}`, ...extra });

test('Intel validation uses a native Intel runner and keeps its architecture for upgrade pairs', t => {
  const f = fixture(t);
  f.git('tag', 'v3.0.23-beta.2');
  const identity = validationIdentity(f.cwd, { ...f.env, VALIDATION_PLATFORMS: 'mac-x64', VALIDATION_UPGRADE_FROM_TAG: 'v3.0.23-beta.2' });
  assert.deepEqual(identity.matrix, [
    { runner: 'macos-26-intel', platform: 'darwin', arch: 'x64', baselineTag: 'v3.0.23-beta.3' },
    { runner: 'macos-26-intel', platform: 'darwin', arch: 'x64', baselineTag: 'v3.0.23-beta.2' },
  ]);
});

test('uses only an existing Beta/Stable baseline without creating a version or changing git', t => {
  const f = fixture(t), before = f.git('show-ref', '--tags'), status = f.git('status', '--porcelain');
  assert.equal(f.identity.packageVersion, '3.0.23-beta.3');
  assert.equal(f.identity.source.frontendDist, '3'.repeat(40));
  assert.equal(f.identity.buildId, `${f.env.GITHUB_SHA.slice(0, 12)}-123-1`);
  assert.equal(validationIdentity(f.cwd, { ...f.env, VALIDATION_BASELINE_TAG: 'v3.0.22' }).packageVersion, '3.0.22');
  assert.equal(f.git('show-ref', '--tags'), before);
  assert.equal(f.git('status', '--porcelain'), status);
  for (const changes of [
    { VALIDATION_BASELINE_TAG: 'v3.0.23-beta.4' }, { VALIDATION_BASELINE_TAG: 'v3.0.23-qa.20261025.1' },
    { VALIDATION_BASELINE_TAG: 'v3.0.23-beta.3\nversion=9.9.9' }, { VALIDATION_SERIES: 'pr-66$(touch nope)' },
    { GITHUB_REF: 'refs/heads/release/v3.0.23' }, { GITHUB_REF: 'refs/heads/main' },
    { GITHUB_REF: 'refs/tags/v3.0.23-beta.3' }, { GITHUB_SHA: '0'.repeat(40) },
    { GITHUB_RUN_ATTEMPT: '0' }, { VALIDATION_PLATFORMS: 'linux' },
  ]) assert.throws(() => validationIdentity(f.cwd, { ...f.env, ...changes }));
});

test('four-start ceiling includes reruns, cancellations, new commits and new dispatches', t => {
  const { identity } = fixture(t);
  assert.equal(assertValidationBudget([run(123, 1), run(122, 3, 'another-task')], identity), 1);
  assert.equal(assertValidationBudget([run(123, 1), run(122, 3, 'pr-66', { conclusion: 'cancelled', head_sha: 'changed' })], identity), 4);
  assert.throws(() => assertValidationBudget([run(123, 1), run(122, 4, 'pr-66', { conclusion: 'failure' })], identity), /停止条件/);
  assert.throws(() => assertValidationBudget([run(123, 5)], { ...identity, runAttempt: 5 }), /停止条件/);
  assert.throws(() => assertValidationBudget([run(122, 1)], identity), /无法确认/);
  assert.throws(() => assertValidationBudget([run(123, undefined)], identity));
});

test('reads all Actions history pages and stops closed on unavailable history', async t => {
  const { identity } = fixture(t); let calls = 0;
  const env = { GITHUB_REPOSITORY: 'nuwax-ai/nuwax-client', GH_TOKEN: 'fixture-read-only-token' };
  const fetcher = async (url, options) => {
    calls++; assert.match(url, /package-validation\.yml\/runs/); assert.equal(options.headers.Authorization, 'Bearer fixture-read-only-token');
    const rows = calls === 1 ? Array.from({ length: 100 }, (_, i) => run(1000 + i, 1, 'other-task')) : [run(123, 1)];
    return { ok: true, json: async () => ({ workflow_runs: rows }) };
  };
  assert.equal(await checkValidationBudget(identity, env, fetcher), 1); assert.equal(calls, 2);
  await assert.rejects(checkValidationBudget(identity, env, async () => ({ ok: false })), /停止构建/);
  await assert.rejects(checkValidationBudget(identity, env, async () => ({ ok: true, json: async () => ({}) })), /停止构建/);
});

test('Windows uses NSIS only, keeps baseline app version, stages no updater files and restores package metadata', async t => {
  const f = fixture(t), temp = path.join(f.cwd, 'runner-temp'); fs.mkdirSync(temp);
  const pkgFile = path.join(f.cwd, 'nuwa-electron-shell/crates/agent-electron-client/package.json');
  fs.mkdirSync(path.dirname(pkgFile), { recursive: true });
  const original = JSON.stringify({ version: '0.0.0', build: { win: { target: ['nsis', 'msi'] } } }); fs.writeFileSync(pkgFile, original);
  let built = false;
  const stage = await buildValidation(f.cwd, f.identity, { platform: 'win32', arch: 'x64', temp,
    prepareFn: async (_cwd, options) => { assert.equal(options.frontend, 'dist'); return f.prepared; },
    packFn: async (_cwd, options) => {
      built = true; assert.equal(options.version, '3.0.23-beta.3');
      assert.equal(options.frontend, 'dist');
      assert.equal(await options.prepare(), f.prepared);
      assert.deepEqual(JSON.parse(fs.readFileSync(pkgFile)).build.win.target, ['nsis']);
      assert.equal(JSON.parse(fs.readFileSync(pkgFile)).build.buildVersion, '3.0.23');
      fs.mkdirSync(options.output, { recursive: true }); fs.writeFileSync(path.join(options.output, 'Nuwax.exe'), 'complete-exe');
      fs.writeFileSync(path.join(options.output, 'latest.yml'), 'must-not-ship');
      fs.writeFileSync(path.join(options.output, 'Nuwax.exe.blockmap'), 'must-not-ship');
      fs.writeFileSync(path.join(options.output, 'release-provenance.json'), 'must-not-ship');
    } });
  assert.equal(built, true); assert.equal(fs.readFileSync(pkgFile, 'utf8'), original);
  const files = fs.readdirSync(stage); assert.equal(files.length, 2); assert.ok(files.some(file => file.endsWith('.exe')));
  const receipt = JSON.parse(fs.readFileSync(path.join(stage, 'validation-context.json')));
  assert.equal(receipt.baselineTag, 'v3.0.23-beta.3');
  assert.deepEqual(receipt.frontend, { mode: 'dist', ...f.prepared.frontend });
  for (const key of ['signed', 'published', 'tagCreated', 'versionSequenceAdvanced', 'updatePointersChanged']) assert.equal(receipt[key], false);
  assert.match(receipt.acceptance, /Unsigned Windows EXE validation/);
  assert.equal(Object.keys(receipt.artifacts).length, 1);
  assert.equal(f.git('show-ref', '--tags').split('\n').length, 2);
});

test('a failed pack restores metadata, MSI and empty output are refused before artifact upload', async t => {
  const f = fixture(t), temp = path.join(f.cwd, 'temp'); fs.mkdirSync(temp);
  const pkgFile = path.join(f.cwd, 'nuwa-electron-shell/crates/agent-electron-client/package.json');
  fs.mkdirSync(path.dirname(pkgFile), { recursive: true }); fs.writeFileSync(pkgFile, '{"version":"0.0.0"}');
  await assert.rejects(buildValidation(f.cwd, f.identity, { platform: 'win32', arch: 'x64', temp,
    prepareFn: async () => f.prepared, packFn: async () => { throw new Error('fixture build failed'); } }), /fixture build failed/);
  assert.equal(fs.readFileSync(pkgFile, 'utf8'), '{"version":"0.0.0"}');
  const output = path.join(temp, 'output'); fs.mkdirSync(output);
  await assert.rejects(stageValidation(f.cwd, output, path.join(temp, 'stage'), f.identity, 'win32'), /没有完整/);
  fs.writeFileSync(path.join(output, 'unexpected.msi'), 'do-not-ship');
  await assert.rejects(stageValidation(f.cwd, output, path.join(temp, 'stage'), f.identity, 'win32'), /MSI/);
});

test('refuses a prepared frontend that differs from the frozen source/artifact pair before packing', async t => {
  const f = fixture(t); let packed = false;
  for (const frontend of [undefined, { ...f.prepared.frontend, sourceSha: '4'.repeat(40) },
    { ...f.prepared.frontend, distSha: '4'.repeat(40) }, { ...f.prepared.frontend, stamp: '4444444' },
    { ...f.prepared.frontend, stamp: '' }]) {
    await assert.rejects(buildValidation(f.cwd, f.identity, { platform: 'win32', arch: 'x64', temp: f.cwd,
      prepareFn: async () => ({ frontend }), packFn: async () => { packed = true; } }), /冻结的前端双 pin/);
  }
  assert.equal(packed, false);
});

test('validation has explicit isolated launch, private Mac signing, and no publishing; release accepts Beta tags only', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/package-validation.yml', import.meta.url), 'utf8');
  const triggers = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\npermissions:'));
  assert.match(triggers, /workflow_dispatch:/); assert.match(triggers, /push:/);
  assert.match(triggers, /\.github\/package-validation-request\.json/);
  assert.doesNotMatch(triggers, /tags:|workflow_call:/);
  assert.match(workflow, /contents: read/); assert.match(workflow, /actions: read/);
  assert.match(workflow, /group: package-validation-/); assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /APPLE_CERTIFICATE/);
  assert.doesNotMatch(workflow, /contents: write|secrets: inherit|GH_PAT|SimplySign|sync-electron-to-oss|gh release|git push|release-electron/);
  assert.match(workflow, /Recheck stop condition before build setup/);
  const beta = fs.readFileSync(new URL('../.github/workflows/release-electron-dev.yml', import.meta.url), 'utf8');
  const betaTriggers = beta.slice(beta.indexOf('\non:'), beta.indexOf('\npermissions:'));
  assert.match(betaTriggers, /"v\*-beta\.\*"/); assert.doesNotMatch(betaTriggers, /workflow_dispatch:|branches:|qa\//);
});

test('history counts explicit push starts as well as dispatches', async t => {
  const { identity } = fixture(t);
  await checkValidationBudget(identity, { GITHUB_REPOSITORY: 'nuwax-ai/nuwax-client', GH_TOKEN: 'fixture' }, async url => {
    assert.doesNotMatch(url, /event=workflow_dispatch/);
    return { ok: true, json: async () => ({ workflow_runs: [run(123, 1)] }) };
  });
});

test('explicit push request matches its fixed series and selects only an existing baseline and admitted platform', t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.cwd, '.github'));
  const file = path.join(f.cwd, '.github/package-validation-request.json');
  const request = { series: 'pr-66', baselineTag: 'v3.0.23-beta.3', platforms: 'both' };
  fs.writeFileSync(file, JSON.stringify(request));
  assert.equal(validationIdentity(f.cwd, { ...f.env, GITHUB_EVENT_NAME: 'push' }).series, 'pr-66');
  f.git('tag', 'v3.0.23-beta.2');
  fs.writeFileSync(file, JSON.stringify({ ...request, baselineTag: 'v3.0.23-beta.2', platforms: 'mac-arm64' }));
  const lower = validationIdentity(f.cwd, { ...f.env, GITHUB_EVENT_NAME: 'push' });
  assert.equal(lower.packageVersion, '3.0.23-beta.2');
  assert.deepEqual(lower.matrix.map(item => item.platform), ['darwin']);
  for (const invalid of [{ baselineTag: 'v3.0.23-beta.4' }, { platforms: 'linux' }]) {
    fs.writeFileSync(file, JSON.stringify({ ...request, ...invalid }));
    assert.throws(() => validationIdentity(f.cwd, { ...f.env, GITHUB_EVENT_NAME: 'push' }));
  }
  fs.writeFileSync(file, JSON.stringify({ ...request, series: 'wrong-series' }));
  assert.throws(() => validationIdentity(f.cwd, { ...f.env, GITHUB_EVENT_NAME: 'push' }), /请求与启动身份不符/);
});

test('Mac staging refuses unsigned artifacts and records private verified identity', async t => {
  const f = fixture(t), output = path.join(f.cwd, 'output'); fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, 'Nuwax.zip'), 'private-archive');
  await assert.rejects(stageValidation(f.cwd, output, path.join(f.cwd, 'unsigned'), f.identity, 'darwin'), /Developer ID/);
  const receipt = await stageValidation(f.cwd, output, path.join(f.cwd, 'signed'), f.identity, 'darwin', { signed: true, notarized: true, team: 'TEAM123' });
  assert.equal(receipt.signed, true); assert.equal(receipt.published, false); assert.equal(receipt.signing.notarized, true);
});

test('one frozen matrix contains both existing Mac versions and only the target Windows EXE', async t => {
  const f = fixture(t); f.git('tag', 'v3.0.23-beta.2');
  const env = { ...f.env, VALIDATION_UPGRADE_FROM_TAG: 'v3.0.23-beta.2' };
  const identity = validationIdentity(f.cwd, env);
  assert.deepEqual(identity.matrix.map(item => [item.platform, item.baselineTag]),
    [['darwin', 'v3.0.23-beta.3'], ['win32', 'v3.0.23-beta.3'], ['darwin', 'v3.0.23-beta.2']]);
  const from = validationIdentity(f.cwd, { ...env, VALIDATION_PACKAGE_BASELINE_TAG: 'v3.0.23-beta.2' });
  assert.equal(from.packageVersion, '3.0.23-beta.2');
  assert.deepEqual(from.source, identity.source); assert.equal(from.buildId, identity.buildId);
  await assert.rejects(buildValidation(f.cwd, from, { platform: 'win32', arch: 'x64', temp: f.cwd }), /未被本次验证选择/);
  for (const invalid of [
    { VALIDATION_UPGRADE_FROM_TAG: 'v3.0.23-beta.4' },
    { VALIDATION_UPGRADE_FROM_TAG: 'v3.0.23-beta.3' },
    { VALIDATION_UPGRADE_FROM_TAG: 'v3.0.22' },
    { VALIDATION_PLATFORMS: 'windows-x64' },
    { VALIDATION_PACKAGE_BASELINE_TAG: 'v3.0.22' },
  ]) assert.throws(() => validationIdentity(f.cwd, { ...env, ...invalid }));
});
