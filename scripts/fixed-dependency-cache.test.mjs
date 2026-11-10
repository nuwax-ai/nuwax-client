import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { sourceBuildKey, dependencyKey, desktopBuildKey, officeDownloadKey } from './client/fixed-dependency-cache.mjs';
import sourceCache from './client/prepared-source-cache.cjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const client = 'nuwa-electron-shell/crates/agent-electron-client';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-fixed-deps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, bytes) => { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), bytes); };
  for (const name of ['scripts/client/prepared-source-cache.cjs', 'scripts/client/build-resource-artifacts.mjs',
    'scripts/client/core.mjs', 'scripts/client/resource-report.mjs', 'scripts/client/agent-desktop-resources.mjs',
    'scripts/source-patches.cjs', 'resources/source-patches/nuwax-file-server-http-listener.patch',
    client + '/package.json', client + '/scripts/utils/project-paths.js',
    ...Object.values(sourceCache.sources).map(spec => client + '/scripts/prepare/prepare-' + spec.name + '.js')]) {
    write(name, fs.readFileSync(path.join(root, name)));
  }
  write('nuwa-electron-shell/crates/dsh-runtime/vendor/primary-runtime.lock.json', '{"target":"locked"}');
  write('nuwa-electron-shell/crates/dsh-runtime/vendor/prepare-office.mjs', '// fixed extraction recipe');
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q']); git(['add', '.']);
  git(['-c','user.name=Fixture','-c','user.email=fixture@localhost','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-qm','fixture']);
  return { dir, write, git };
}

test('Windows checkout keeps third-party patches byte-identical with autocrlf enabled', t => {
  const f = fixture(t), patch = 'third-party/patches/fixture.patch';
  const bytes = 'diff --git a/file b/file\n--- a/file\n+++ b/file\n';
  f.write('.gitattributes', fs.readFileSync(path.join(root, '.gitattributes')));
  f.write(patch, bytes);
  f.git(['add','.']);
  f.git(['-c','user.name=Fixture','-c','user.email=fixture@localhost','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-qm','patch']);
  f.git(['-c','core.autocrlf=true','checkout-index','--all','--prefix='+path.join(f.dir,'checkout')+path.sep]);
  assert.equal(fs.readFileSync(path.join(f.dir,'checkout',patch),'utf8'),bytes);
});

test('source identity survives application version and unrelated UI changes but invalidates source, patch, runtime and target changes', t => {
  const f = fixture(t);
  let revision = 'a'.repeat(40);
  const resolve = (_url, ref) => revision + '\t' + ref;
  const key = () => sourceBuildKey(f.dir, 'file-server', resolve);
  const original = key();
  const pkg = JSON.parse(fs.readFileSync(path.join(f.dir, client, 'package.json')));
  pkg.version = '99.0.0-alpha.123';
  f.write(client + '/package.json', JSON.stringify(pkg));
  f.write(client + '/src/renderer/unrelated.tsx', '// UI change');
  assert.deepEqual(key(), original);
  revision = 'b'.repeat(40); assert.notEqual(key().key, original.key); revision = 'a'.repeat(40);
  fs.appendFileSync(path.join(f.dir, 'resources/source-patches/nuwax-file-server-http-listener.patch'), '\n# changed');
  assert.notEqual(key().key, original.key);
  assert.notEqual(sourceBuildKey(f.dir, 'file-server', resolve, { node: 'other', abi: 'other' }).key, key().key);
  assert.notEqual(dependencyKey('file-server', {}, { platform: 'linux', arch: 'x64' }), dependencyKey('file-server', {}, { platform: 'linux', arch: 'arm64' }));
  assert.throws(() => sourceBuildKey(f.dir, 'file-server', () => ''), /freeze/);
  assert.throws(() => sourceBuildKey(f.dir, 'file-server', () => revision + '\trefs/heads/other'), /freeze/);
});

test('independent Office and desktop recipes do not depend on application source/version', t => {
  const f = fixture(t);
  const desktop = desktopBuildKey(f.dir), office = officeDownloadKey(f.dir);
  f.write(client + '/src/main/changed.ts', '// product edit');
  assert.equal(desktopBuildKey(f.dir), desktop); assert.equal(officeDownloadKey(f.dir), office);
  f.write('nuwa-electron-shell/crates/dsh-runtime/vendor/primary-runtime.lock.json', '{"target":"new"}');
  assert.notEqual(officeDownloadKey(f.dir), office); assert.equal(desktopBuildKey(f.dir), desktop);
  fs.appendFileSync(path.join(f.dir, 'scripts/client/agent-desktop-resources.mjs'), '\n// new preparation');
  assert.notEqual(desktopBuildKey(f.dir), desktop);
});

test('patched Windows desktop reuse also binds the hosted compiler image, flags and patch bytes', t => {
  const f = fixture(t), env = { ImageOS: 'windows-2025', ImageVersion: '20261103.1' };
  f.write('scripts/client/agent-desktop-windows.mjs', '// locked native build');
  f.write('third-party/patches/agent-desktop-windows-no-focus.patch', 'fixed patch');
  const key = desktopBuildKey(f.dir, env, 'win32', 'x64');
  assert.equal(desktopBuildKey(f.dir, env, 'win32', 'x64'), key);
  assert.notEqual(desktopBuildKey(f.dir, { ...env, ImageVersion: 'new' }, 'win32', 'x64'), key);
  assert.notEqual(desktopBuildKey(f.dir, { ...env, RUSTFLAGS: '-C other' }, 'win32', 'x64'), key);
  assert.throws(() => desktopBuildKey(f.dir, {}, 'win32', 'x64'), /compiler image/);
  f.write('third-party/patches/agent-desktop-windows-no-focus.patch', 'new patch');
  assert.notEqual(desktopBuildKey(f.dir, env, 'win32', 'x64'), key);
});

test('only the frozen Git revision with a tracked lockfile can mark a prepared source reusable', t => {
  const f = fixture(t), dest = path.join(f.dir, 'payload');
  f.write('package-lock.json', '{"lockfileVersion":3}');
  f.git(['add','package-lock.json']);
  f.git(['-c','user.name=Fixture','-c','user.email=fixture@localhost','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-qm','lock']);
  const revision = f.git(['rev-parse','HEAD']);
  const env = { NUWAX_FILE_SERVER_SOURCE_SHA: revision, NUWAX_FILE_SERVER_CACHE_KEY: 'file-server-v1-fixture' };
  for (const name of ['dist/entry.js','node_modules/dep/index.js','package.json']) f.write('payload/' + name, 'fixture');
  assert.equal(sourceCache.preparedSourceReady('file-server', dest, env), false);
  sourceCache.recordPreparedSource('file-server', f.dir, dest, env);
  assert.equal(sourceCache.preparedSourceReady('file-server', dest, env), true);
  assert.equal(sourceCache.preparedSourceReady('file-server', dest, { ...env, NUWAX_FILE_SERVER_CACHE_KEY:'different' }), false);
  assert.throws(() => sourceCache.recordPreparedSource('file-server', f.dir, dest, { ...env, NUWAX_FILE_SERVER_SOURCE_SHA:'f'.repeat(40) }), /frozen/);
  fs.rmSync(path.join(dest, 'dist'), { recursive:true });
  assert.equal(sourceCache.preparedSourceReady('file-server', dest, env), false);
  assert.throws(() => sourceCache.sourceIdentity('file-server', { NUWAX_FILE_SERVER_SOURCE_SHA:'--injected' }), /Invalid/);
  fs.rmSync(path.join(dest, sourceCache.marker));
  f.git(['rm','--cached','package-lock.json']);
  sourceCache.recordPreparedSource('file-server', f.dir, dest, env);
  assert.equal(fs.existsSync(path.join(dest, sourceCache.marker)), false);
});

test('trusted artifact install verifies all bytes and paths before replacing prepared dependency output', async t => {
  const f = fixture(t);
  const api = await import(pathToFileURL(path.join(f.dir,'scripts/client/build-resource-artifacts.mjs')).href);
  const current = f.git(['rev-parse','HEAD']), key = 'file-server-v1-test';
  const relative = client + '/resources/nuwax-file-server/dist/entry.js';
  const unpacked = path.join(f.dir,'download');
  const data = 'verified compiled dependency', hash = digest(data);
  const run = {id:123,head_sha:current,path:'.github/workflows/release-electron-dev.yml',event:'push',head_branch:'v1.0.0-beta.1',run_attempt:1};
  const record = {schema:1,kind:'file-server',platform:process.platform,arch:process.arch,key,
    producer:{repository:'test/repo',runId:123,source:current,workflow:run.path,event:'push',ref:run.head_branch,attempt:1,jobId:456},
    files:[{path:relative,sha256:hash,bytes:Buffer.byteLength(data),mode:0o644}]};
  f.write('download/blobs/'+hash,data);
  const artifact = {name:'build-resource-v1-file-server-'+key+'-a1'};
  const oldFetch = globalThis.fetch, oldEnv = {...process.env};
  process.env.GH_TOKEN='fixture-only'; process.env.GITHUB_REPOSITORY='test/repo';
  globalThis.fetch=async url => ({ok:true,json:async()=>String(url).includes('actions/jobs/') ?
    {id:456,run_id:123,head_sha:current,status:'completed',conclusion:'success'} : {jobs:[{id:456}]}});
  t.after(()=>{globalThis.fetch=oldFetch; for(const name of Object.keys(process.env))if(!(name in oldEnv))delete process.env[name]; Object.assign(process.env,oldEnv);});
  const manifest = () => f.write('download/manifest.json',JSON.stringify(record));
  f.write(relative,'old payload'); manifest();
  f.write('download/blobs/'+hash,'corrupt');
  await assert.rejects(api.installResource('file-server',key,artifact,run,unpacked),/SHA256|size/);
  assert.equal(fs.readFileSync(path.join(f.dir,relative),'utf8'),'old payload');
  f.write('download/blobs/'+hash,data);
  record.files[0].path='../escape'; manifest();
  await assert.rejects(api.installResource('file-server',key,artifact,run,unpacked),/Unsafe/);
  record.files[0].path=relative; manifest();
  await api.installResource('file-server',key,artifact,run,unpacked);
  assert.equal(fs.readFileSync(path.join(f.dir,relative),'utf8'),data);
  assert.throws(()=>api.resourceOwner('agent-desktop',client+'/resources/agent-desktop/other-platform/binary'),/allowlist/);
  assert.throws(()=>api.resourceOwner('dsh-download','.cache/dsh-office/unaddressed.zip'),/hash-addressed/);
  assert.throws(()=>api.resourceRoots('toString'),/Unknown/);
});
