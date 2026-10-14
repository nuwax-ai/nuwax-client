import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = (name) => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
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
