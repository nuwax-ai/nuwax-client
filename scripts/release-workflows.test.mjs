import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = (name) => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
test('stable and beta filter build caches and verify the final payload before upload', () => {
  for (const name of ['release-electron.yml', 'release-electron-dev.yml']) {
    const text = workflow(name);
    const configure = text.indexOf('node scripts/client/package-payload.mjs --package nuwa-electron-shell/crates/agent-electron-client/package.json');
    const verify = text.indexOf('node scripts/client/package-payload.mjs --verify-output "$OUT_DIR" --arch "$TARGET_ARCH"');
    assert.ok(configure > text.indexOf('- name: Inject computer-use extraResources'), `${name} filters the final configured resource list`);
    assert.ok(configure < text.indexOf('- name: Build Electron app'), `${name} filters before packaging`);
    assert.ok(verify > text.indexOf('- name: Verify packaged updater configuration'), `${name} verifies actual output`);
    assert.ok(verify < text.indexOf('- name: Record platform source'), `${name} rejects leaked caches before provenance/upload`);
    if (name === 'release-electron-dev.yml') assert.ok(verify < text.indexOf('- name: Stage isolated QA packages'));
  }
});

test('stable and beta run native Windows installer space checks before building resources', () => {
  for (const name of ['release-electron.yml', 'release-electron-dev.yml']) {
    const text = workflow(name);
    const step = text.split(/(?=^      - name: )/m).find(value => value.includes('-File .\\scripts\\test-installer-space.ps1'));
    assert.ok(step, `${name} must run the shared native space helper fixtures`);
    assert.match(step, /if: runner\.os == 'Windows'/);
    assert.match(step, /shell: (?:powershell|pwsh)/);
    assert.ok(step.includes('$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'));
    assert.match(step, /if \(\$LASTEXITCODE -ne 0\) \{ throw 'Windows installer disk space fixtures failed\.' \}/);
    assert.ok(text.indexOf('-File .\\scripts\\test-installer-space.ps1') < text.indexOf('- name: Prepare bundled resources'));
    assert.ok(text.indexOf('-File .\\scripts\\test-installer-space.ps1') < text.indexOf('- name: Build Electron app'));
  }
});

test('public release routes are exclusive, validated before gates, and beta publication needs the matrix', () => {
  const stable = workflow('release-electron.yml'), beta = workflow('release-electron-dev.yml');
  assert.match(stable, /tags:\n\s+- "v\*"\n\s+- "!v\*-beta\.\*"/);
  assert.match(beta, /tags:\n\s+- "v\*-beta\.\*"/);
  for (const [text, channel] of [[stable, 'stable'], [beta, 'beta']]) {
    assert.ok(text.indexOf('  validate-tag:') < text.indexOf('  verify-source:'));
    assert.match(text, /verify-source:\n(?:[^\n]*\n)*?\s+needs: validate-tag/);
    assert.ok(text.includes(`node scripts/release-version.mjs "$RELEASE_TAG" ${channel}`));
    for (const tag of channel === 'stable' ? ['v3.0.10', 'v3.0.11'] : ['v3.0.11-beta.1', 'v3.0.11-beta.10']) {
      const result = spawnSync(process.execPath, [new URL('./release-version.mjs', import.meta.url).pathname, tag, channel], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`channel=${channel}`));
    }
    for (const tag of ['v03.0.11', 'v3.0.11-beta.0', 'v3.0.11-rc.1', 'v3.0.11-dev', 'v3.0.11+build']) {
      const result = spawnSync(process.execPath, [new URL('./release-version.mjs', import.meta.url).pathname, tag, channel], { encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
    }
  }
  assert.match(beta, /publish-beta:\n(?:[^\n]*\n)*?\s+needs: build-electron/);
  assert.doesNotMatch(stable, /publish-beta:|workflow_dispatch:/);
});

test('all pointer publications share one queue and current tools verify a separately checked out source', () => {
  const sync = workflow('sync-electron-to-oss.yml');
  assert.match(sync, /group: nuwax-update-subscriptions\n\s+cancel-in-progress: false/);
  assert.doesNotMatch(sync, /group:.*inputs\.channel/);
  assert.ok(sync.indexOf('Checkout release automation') < sync.indexOf('Validate release tag and channel'));
  assert.match(sync, /ref: \$\{\{ inputs.tag \}\}\n\s+path: release-source/);
  assert.match(sync, /--source-root release-source/);
  assert.match(sync, /node scripts\/publish-release-pointers.mjs/);
});

test('manual beta sync accepts current and historical runner labels but still requires every platform', () => {
  const text = workflow('sync-electron-to-oss.yml');
  const command = text.match(/gh run view "\$BUILD_RUN_ID"[^\n]*node --input-type=module -e '([^']+)'/s)?.[1];
  assert.ok(command, 'manual sync executes the shared platform guard');
  const jobsFor = intel => ['macos-latest arm64', intel, 'windows-latest x64', 'ubuntu-24.04 x64', 'ubuntu-24.04-arm arm64']
    .map(suffix => ({ name: `Build Electron (${suffix})`, status: 'completed', conclusion: 'success' }));
  const invoke = jobs => spawnSync(process.execPath, ['--input-type=module', '-e', command], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', input: JSON.stringify({ jobs }),
  });
  for (const intel of ['macos-26-intel x64', 'macos-15-intel x64', 'macos-latest x64']) {
    const result = invoke(jobsFor(intel));
    assert.equal(result.status, 0, result.stderr);
  }
  const failedWindows = jobsFor('macos-26-intel x64');
  failedWindows[2].conclusion = 'failure';
  failedWindows.push(...jobsFor('macos-15-intel x64').filter(job => job.name.includes('macos-')));
  for (const jobs of [failedWindows, jobsFor('macos-26-intel x64').slice(1), []]) {
    assert.equal(invoke(jobs).status, 1);
  }
});

test('published update notes preserve complete UTF-8 text and old-version recovery instructions', () => {
  const assignment = workflow('sync-electron-to-oss.yml').split('\n').find(line => line.trimStart().startsWith('NOTES='));
  assert.ok(assignment, 'workflow extracts release notes');
  // 将中文与 emoji 放在旧 500 字节边界两侧，直接执行实际发布命令。
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

test('stable and beta prepare locked capture payloads and verify real packaged bytes before any upload', () => {
  for (const name of ['release-electron.yml', 'release-electron-dev.yml']) {
    const text = workflow(name);
    assert.match(text, /platform: macos-26-intel\n\s+arch: x64/);
    assert.match(text, /Setup Windows capture compiler\n\s+if: runner.os == 'Windows'/);
    assert.match(text, /Setup macOS capture compiler\n\s+if: runner.os == 'macOS'/);
    assert.match(text, /MACOSX_DEPLOYMENT_TARGET=12\.0/);
    assert.match(text, /command -v nasm >\/dev\/null \|\| brew install nasm/);
    assert.match(text, /command -v pkg-config >\/dev\/null \|\| brew install pkgconf/);
    assert.ok(text.indexOf('Setup macOS capture compiler') < text.indexOf('Prepare and admit capture release resources'));
    assert.match(text, /Setup Linux capture compiler\n\s+if: runner.os == 'Linux'/);
    assert.match(text, /sudo apt-get install -y build-essential pkg-config nasm/);
    assert.ok(text.indexOf('Setup Linux capture compiler') < text.indexOf('Prepare and admit capture release resources'));
    assert.match(text, /uses: msys2\/setup-msys2@v2/);
    assert.match(text, /mingw-w64-x86_64-nasm\n\s+perl\n/);
    assert.match(text, /MSYS2_LOCATION: \$\{\{ steps.capture-msys2.outputs.msys2-location \}\}/);
    assert.match(text, /node scripts\/prepare-release-capture.mjs --arch "\$TARGET_ARCH"/);
    assert.match(text, /node scripts\/prepare-release-capture.mjs --arch "\$TARGET_ARCH" --verify-output "\$OUT_DIR"/);
    assert.ok(text.indexOf('Prepare and admit capture release resources') < text.indexOf('- name: Build Electron app'));
    assert.ok(text.indexOf('Import Apple certificate (macOS)') < text.indexOf('Prepare and admit capture release resources'));
    assert.match(text, /NUWAX_CAPTURE_MAC_SIGNING: \$\{\{ runner.os == 'macOS' && secrets.APPLE_CERTIFICATE != '' && 'true' \|\| 'false' \}\}/);
    assert.ok(text.indexOf('- name: Build Electron app') < text.indexOf('Verify packaged capture resources'));
    assert.match(text, /APPLE_API_KEY= APPLE_API_KEY_ID= APPLE_ISSUER_ID=/);
    assert.match(text, /--dir --publish never --config.mac.notarize=false/);
    assert.ok(text.indexOf('Notarize signed macOS app with resumable retries') < text.indexOf('Package notarized macOS app'));
    assert.ok(text.indexOf('Package notarized macOS app') < text.indexOf('Verify packaged capture resources'));
    assert.match(text, /--phase notarize/);
    assert.match(text, /--phase package/);
    assert.match(text, /Preserve signed macOS app after failure/);
    assert.match(text, /mac-notary-recovery-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}-\$\{\{ matrix.arch \}\}/);
    assert.ok(text.indexOf('Verify packaged capture resources') < text.indexOf('Upload artifacts to Release'));
    if (name === 'release-electron-dev.yml') assert.ok(text.indexOf('Verify packaged capture resources') < text.indexOf('Stage isolated QA packages'));
    assert.match(text, /OUT_DIR="\$NUWAX_WINDOWS_OUTPUT_DIR"/);
    assert.match(text, /platform: ubuntu-24.04\n\s+arch: x64/);
    assert.match(text, /platform: ubuntu-24.04-arm\n\s+arch: arm64/);
  }
});
