import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { release, releaseIdentity, selectRun, verifyManifests, verifyMirrors } from './client/release.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const source = { client: 'a'.repeat(40), shell: 'b'.repeat(40), frontend: 'c'.repeat(40), dist: 'd'.repeat(40) };
const settings = { repo: 'example/client', signHost: 'win-fixture', windowsClientDir: '/c/work/client', signGhPath: '/c/Program Files/GitHub CLI', s3Base: 'https://s3.invalid/client', ossBase: 'https://oss.invalid/client' };

function fixture({ channel = 'stable', signed = true, publicRelease = true } = {}) {
  const identity = releaseIdentity(channel, '1.2.3');
  const calls = [];
  const data = new Map();
  const manifests = {};
  const installers = {
    'macos-arm64': ['Nuwax-1.2.3-arm64.dmg', 'Nuwax-1.2.3-arm64-mac.zip'],
    'macos-x64': ['Nuwax-1.2.3.dmg', 'Nuwax-1.2.3-mac.zip'],
    'windows-x64': ['Nuwax-Setup-1.2.3-unsigned.exe'],
    'linux-x64': ['Nuwax-1.2.3.AppImage'], 'linux-arm64': ['Nuwax-1.2.3-arm64.AppImage'],
  };
  for (const [key, files] of Object.entries(installers)) {
    const [platform, arch] = key.split('-');
    files.forEach((file) => data.set(file, Buffer.from(file)));
    const value = { schemaVersion: 1, tag: identity.tag, platform, arch, source: { client: source.client, shell: source.shell, frontend: source.frontend },
      frontend: { stamp: source.frontend.slice(0, 9), distSha256: 'e'.repeat(64) }, artifacts: Object.fromEntries(files.map((name) => [name, digest(data.get(name))])) };
    if (platform === 'windows') value.windowsSigning = { unsignedSize: 10, signingIdentitySha256: 'f'.repeat(64) };
    manifests[key] = value;
    data.set(`build-manifest-${key}.json`, Buffer.from(JSON.stringify(value)));
  }
  let isSigned = signed || channel === 'beta';
  function sign() {
    if (channel === 'stable') { data.delete('Nuwax-Setup-1.2.3-unsigned.exe'); data.set(identity.windows, Buffer.from('signed exe fixture')); }
    isSigned = true;
  }
  if (isSigned) sign();
  const prefix = channel === 'stable' ? identity.tag : `beta-build/${identity.tag}`;
  const platformNames = {
    'darwin-aarch64': 'Nuwax-1.2.3-arm64.dmg', 'darwin-aarch64-zip': 'Nuwax-1.2.3-arm64-mac.zip',
    'darwin-x86_64': 'Nuwax-1.2.3.dmg', 'darwin-x86_64-zip': 'Nuwax-1.2.3-mac.zip',
    'windows-x86_64': identity.windows, 'linux-x86_64': 'Nuwax-1.2.3.AppImage', 'linux-aarch64': 'Nuwax-1.2.3-arm64.AppImage',
  };
  function publish() {
    const pointer = { version: identity.version, yml: { darwin: `${settings.s3Base}/${prefix}/latest-mac.yml`, linux: `${settings.s3Base}/${prefix}/latest-linux.yml`, win: `${settings.s3Base}/${prefix}/latest.yml` }, platforms: Object.fromEntries(Object.entries(platformNames).map(([key, filename]) => [key,
      { url: `${settings.s3Base}/${prefix}/${filename}`, size: data.get(filename).length, signature: Buffer.alloc(64).toString('base64') }])) };
    data.set('latest.json', Buffer.from(JSON.stringify(pointer)));
    for (const file of ['latest.yml', 'latest-mac.yml', 'latest-linux.yml', 'latest-linux-arm64.yml', 'latest-linux-x64.yml']) data.set(file, Buffer.from(`version: ${identity.version}\n`));
    data.set('release-provenance.json', Buffer.from(JSON.stringify({ schemaVersion: 1, tag: identity.tag, source: { client: source.client, shell: source.shell, frontend: source.frontend },
      builds: Object.values(manifests), assets: Object.fromEntries([...data].filter(([file]) => !file.startsWith('build-manifest-') && file !== 'release-provenance.json').map(([file, bytes]) => [file, digest(bytes)])) })));
    publicRelease = true;
  }
  if (publicRelease && isSigned) publish();
  const view = () => ({ tag_name: identity.tag, draft: !publicRelease, prerelease: channel === 'beta', assets: [...data].map(([name, bytes]) => ({ name, size: bytes.length, digest: `sha256:${digest(bytes)}` })) });
  const build = { databaseId: 10, headBranch: identity.tag, headSha: source.client, event: 'push', status: 'completed', conclusion: 'success' };
  const successfulSync = { databaseId: 20, headBranch: 'release-fixture', headSha: source.client, event: 'workflow_dispatch', displayTitle: `Sync ${channel} ${identity.tag}`, status: 'completed', conclusion: 'success' };
  const state = { remoteTag: source.client, remoteHead: source.client, syncRuns: publicRelease ? [successfulSync] : [], builds: [build], lookup: 0 };
  const adapters = {
    log: (message) => calls.push(['log', message]), sleep: async (ms) => calls.push(['sleep', ms]),
    git: async (args) => {
      calls.push(['git', ...args]);
      if (args[0] === 'rev-parse') {
        if (args[1] === 'HEAD') return source.client;
        if (args[1].startsWith('refs/tags')) { if (state.remoteTag) return state.remoteTag; throw new Error('no tag'); }
        return { 'HEAD:nuwa-electron-shell': source.shell, 'HEAD:nuwax': source.frontend, 'HEAD:nuwax-dist': source.dist }[args[1]];
      }
      if (args[0] === 'branch') return 'release-fixture';
      if (args[0] === 'show') return 'committed release notes';
      if (args[0] === 'status') return state.dirty ?? '';
      if (args[0] === 'config') return args.at(-1).endsWith('.url') ? `https://github.com/example/${args.at(-1).split('.')[1]}.git` : 'main';
      if (args[0] === 'ls-remote') {
        if (args.at(-1).startsWith('refs/heads/')) return `${state.remoteHead}\t${args.at(-1)}`;
        if (args[1] === 'origin') return state.remoteTag ? `${state.remoteTag}\trefs/tags/${identity.tag}` : '';
        return `${source.shell}\trefs/heads/main\n${source.frontend}\trefs/heads/main\n${source.dist}\trefs/heads/main`;
      }
      if (args[0] === 'push' && args[2]?.startsWith('refs/tags')) state.remoteTag = source.client;
      return '';
    },
    gh: async (args) => {
      calls.push(['gh', ...args]);
      if (args[0] === 'api') return view();
      if (args[1] === 'list') {
        const workflow = args[args.indexOf('--workflow') + 1];
        if (workflow === identity.buildWorkflow) { state.lookup++; return state.lookup <= (state.race ?? 0) ? [{ ...build, headSha: '0'.repeat(40) }] : state.builds; }
        return state.syncRuns;
      }
      if (args[1] === 'view') {
        if (args[2] === '10') return state.buildResult ?? build;
        publish();
        return { status: 'completed', conclusion: 'success' };
      }
      throw new Error(`unexpected gh ${args}`);
    },
    exec: async (command, args) => {
      calls.push(['exec', command, ...args]);
      if (command === 'ssh') { if (state.signFailure) throw new Error('authentication unavailable'); sign(); }
      if (command === 'gh' && args[0] === 'workflow') state.syncRuns = [{ ...successfulSync, databaseId: 21, status: 'in_progress', conclusion: null }];
      return { status: 0, stdout: '', stderr: '' };
    },
    assetJson: async (asset) => JSON.parse(data.get(asset.name).toString()),
    assetHash: async (asset) => digest(data.get(asset.name)),
    fetchBytes: async () => data.get('latest.json'),
    hashUrl: async (url) => state.corruptMirror ? '0'.repeat(64) : digest(data.get(decodeURIComponent(new URL(url).pathname.split('/').at(-1)))),
  };
  const run = (options = {}) => release('/nonexistent/nuwax-release-fixture', { channel, version: identity.version, settings, lookupAttempts: 3, pollAttempts: 3, ...options }, adapters);
  return { identity, data, manifests, state, calls, adapters, view, run };
}

test('release version and channel are explicit and strict', () => {
  for (const version of [undefined, '1.2', '01.2.3', '1.2.3;echo', '1.2.3-beta']) assert.throws(() => releaseIdentity('stable', version));
  assert.throws(() => releaseIdentity('nightly', '1.2.3'));
  assert.equal(releaseIdentity('beta', '1.2.3').tag, 'prerelease-v1.2.3');
});

test('workflow selection requires exact tag, SHA and event', () => {
  const runs = [{ databaseId: 1, headBranch: 'electron-v1.2.3', headSha: source.client, event: 'push' }];
  assert.equal(selectRun(runs, { tag: 'electron-v1.2.3', sha: source.client }).databaseId, 1);
  for (const criteria of [{ sha: source.shell }, { event: 'workflow_dispatch' }, { tag: 'electron-v1.2.4' }])
    assert.equal(selectRun(runs, { tag: 'electron-v1.2.3', sha: source.client, ...criteria }), undefined);
});

test('dry-run reports preflight problems without tag, dispatch, signing or downloads', async () => {
  const f = fixture();
  f.state.dirty = ' M tracked.js';
  f.state.remoteTag = 'f'.repeat(40);
  const result = await f.run({ dryRun: true });
  assert.equal(result.ok, false);
  assert.match(result.findings.join('\n'), /未提交/);
  assert.match(result.findings.join('\n'), /禁止改 tag/);
  assert.equal(f.calls.some(([type, command]) => type === 'git' && ['push', 'tag', 'commit', 'add'].includes(command)), false);
  assert.equal(f.calls.some(([type, command, first]) => type === 'exec' && (command === 'ssh' || first === 'workflow')), false);
});

test('same-name remote tag with another SHA is immutable', async () => {
  const f = fixture(); f.state.remoteTag = source.shell;
  await assert.rejects(f.run(), /禁止改 tag/);
  assert.equal(f.calls.some(([type, cmd]) => type === 'git' && ['push', 'tag'].includes(cmd)), false);
});

test('run discovery polls the eventual tag/SHA event instead of selecting another build', async () => {
  const f = fixture(); f.state.race = 2;
  const result = await f.run();
  assert.equal(result.tag, f.identity.tag);
  assert.equal(f.calls.filter(([type]) => type === 'sleep').length, 2);
});

test('completed remote release resumes without tag, signing or workflow dispatch', async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.version, '1.2.3');
  assert.equal(result.assetsVerified, f.data.size);
  assert.equal(f.calls.some(([type, command, first]) => type === 'exec' && (command === 'ssh' || first === 'workflow')), false);
});

test('stable signs with exact tagged isolated worktree and then publishes', async () => {
  const f = fixture({ signed: false, publicRelease: false });
  const result = await f.run();
  assert.equal(result.version, '1.2.3');
  const ssh = f.calls.find(([type, command]) => type === 'exec' && command === 'ssh');
  assert.match(ssh.at(-1), /worktree add --detach/);
  assert.match(ssh.at(-1), /SIGN_RELEASE_REPO/);
  assert.match(ssh.at(-1), /aaaaaaaaaaaa/);
  assert.match(ssh.at(-1), /SIGN_SKIP_BLOCKMAP=true/);
  assert.equal(f.calls.filter(([type, command, first]) => type === 'exec' && command === 'gh' && first === 'workflow').length, 1);
});

test('SimplySign failure is actionable and leaves remote release resumable', async () => {
  const f = fixture({ signed: false, publicRelease: false }); f.state.signFailure = true;
  await assert.rejects(f.run(), /SimplySign 手机认证.*重跑同版本可续接/);
  assert.equal(f.calls.some(([type, command, first]) => type === 'exec' && command === 'gh' && first === 'workflow'), false);
});

test('a pushed tag is checked against actual remote SHA', async () => {
  const f = fixture(); f.state.remoteTag = null;
  await f.run();
  assert.equal(f.state.remoteTag, source.client);
  assert.equal(f.calls.filter(([type, command]) => type === 'git' && command === 'push').length, 1);
});

test('failed build never enters signing or sync', async () => {
  const f = fixture({ publicRelease: false }); f.state.builds[0].conclusion = 'failure';
  await assert.rejects(f.run(), /workflow 10 未成功/);
  assert.equal(f.calls.some(([type, command]) => type === 'exec' && command === 'ssh'), false);
});

test('beta reuses successful automatic publishing and never signs', async () => {
  const f = fixture({ channel: 'beta' }); f.state.syncRuns = [];
  const result = await f.run();
  assert.equal(result.tag, 'prerelease-v1.2.3');
  assert.equal(f.calls.some(([type, command, first]) => type === 'exec' && (command === 'ssh' || first === 'workflow')), false);
});

test('beta automatic sync failure resumes only after all five build jobs passed', async () => {
  const f = fixture({ channel: 'beta', publicRelease: false });
  f.state.builds[0].conclusion = 'failure';
  f.state.buildResult = { jobs: ['macos-latest arm64', 'macos-latest x64', 'windows-latest x64', 'ubuntu-24.04 x64', 'ubuntu-24.04-arm arm64']
    .map((suffix) => ({ name: `Build Electron (${suffix})`, status: 'completed', conclusion: 'success' })) };
  const result = await f.run();
  assert.equal(result.tag, f.identity.tag);
  assert.equal(f.calls.some(([type, cmd]) => type === 'exec' && cmd === 'ssh'), false);
  assert.equal(f.calls.filter(([type, command, first]) => type === 'exec' && command === 'gh' && first === 'workflow').length, 1);
});

test('a failed beta platform does not publish existing assets', async () => {
  const f = fixture({ channel: 'beta', publicRelease: false });
  f.state.builds[0].conclusion = 'failure';
  f.state.buildResult = { jobs: [] };
  await assert.rejects(f.run(), /五平台构建未全部成功/);
  assert.equal(f.calls.some(([type, command, first]) => type === 'exec' && command === 'gh' && first === 'workflow'), false);
});

test('an in-flight sync is monitored without another dispatch', async () => {
  const f = fixture({ publicRelease: false });
  f.state.syncRuns = [{ databaseId: 20, headBranch: 'release-fixture', headSha: source.client,
    event: 'workflow_dispatch', displayTitle: `Sync stable ${f.identity.tag}`, status: 'in_progress', conclusion: null }];
  await f.run();
  assert.equal(f.calls.some(([type, command, first]) => type === 'exec' && command === 'gh' && first === 'workflow'), false);
});

test('a moved branch between preflight and sync dispatch is refused', async () => {
  const f = fixture({ publicRelease: false });
  const readAsset = f.adapters.assetJson;
  f.adapters.assetJson = async (...args) => { f.state.remoteHead = source.shell; return readAsset(...args); };
  await assert.rejects(f.run(), /已被推进/);
  assert.equal(f.calls.some(([type, command, first]) => type === 'exec' && command === 'gh' && first === 'workflow'), false);
});

test('a public stable Release does not bypass the signature verification workflow', async () => {
  const f = fixture(); f.state.syncRuns = [];
  await f.run();
  assert.equal(f.calls.filter(([type, command, first]) => type === 'exec' && command === 'gh' && first === 'workflow').length, 1);
});

test('manifest source must agree on all five platforms', () => {
  const f = fixture();
  f.manifests['linux-arm64'].source = { ...f.manifests['linux-arm64'].source, frontend: source.shell };
  assert.throws(() => verifyManifests(f.manifests, f.view().assets, f.identity, source), /frontend 来源/);
});

test('platform-local frontend builds may have different resource tree hashes', () => {
  const f = fixture();
  f.manifests['linux-arm64'].frontend = { ...f.manifests['linux-arm64'].frontend, distSha256: '1'.repeat(64) };
  assert.doesNotThrow(() => verifyManifests(f.manifests, f.view().assets, f.identity, source));
});

test('mirror verification compares actual SHA256 and rejects same-size replacement', async () => {
  const f = fixture(); f.state.corruptMirror = true;
  await assert.rejects(verifyMirrors(f.adapters, settings, f.identity, f.view(), source), /S3 资产 SHA256 不一致/);
});

test('mirror verification requires a public Release and committed source identity', async () => {
  const f = fixture();
  await assert.rejects(verifyMirrors(f.adapters, settings, f.identity, { ...f.view(), draft: true }, source), /尚未公开/);
  await assert.rejects(verifyMirrors(f.adapters, settings, f.identity, f.view(), { ...source, frontend: source.shell }), /来源清单/);
});
