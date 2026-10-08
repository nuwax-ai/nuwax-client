import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { configureWindowsOutput } from './configure-windows-output.mjs';

function fixture(t, version = '3.0.11-beta.4') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-windows-output-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packagePath = path.join(root, 'package.json'), environmentFile = path.join(root, 'github-env');
  const pkg = { name: 'fixture-client', version, build: { buildVersion: '3.0.11',
    artifactName: '${productName}-${version}.${ext}', directories: { buildResources: 'build', output: 'release/${version}' },
    extraResources: [{ from: 'complete-resource', to: 'claude-code-acp-ts' }], nsis: { useZip: false },
    win: { target: ['msi', 'nsis', 'zip'] } } };
  fs.writeFileSync(packagePath, JSON.stringify(pkg)); fs.writeFileSync(environmentFile, '');
  return { root, pkg, packagePath, environmentFile, env: { RUNNER_TEMP: 'D:\\a\\_temp',
    GITHUB_RUN_ID: '37752266150', GITHUB_RUN_ATTEMPT: '1', TARGET_ARCH: 'x64', GITHUB_ENV: environmentFile } };
}

test('short output avoids the actual 260-character WiX input without changing versions, resources or archive policy', (t) => {
  const tail = '/win-unpacked/resources/claude-code-acp-ts/node_modules/@typescript-eslint/eslint-plugin/dist/rules/prefer-optional-chain-utils/PreferOptionalChainOptions.d.ts';
  const old = 'D:/a/nuwax-client/nuwax-client/nuwa-electron-shell/crates/agent-electron-client/release/3.0.11-beta.3';
  assert.equal((old + tail).length, 260);
  for (const version of ['3.0.12', '3.0.11-beta.4', '3.0.11-beta.10', '3.0.9-qa.20261008.2']) {
    const f = fixture(t, version), output = configureWindowsOutput(f);
    assert.equal((output + tail).length, 190);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.packagePath)), { ...f.pkg,
      build: { ...f.pkg.build, directories: { ...f.pkg.build.directories, output } } });
    assert.equal(fs.readFileSync(f.environmentFile, 'utf8'), `NUWAX_WINDOWS_OUTPUT_DIR=${output}\n`);
  }
});

test('attempt and architecture isolate retry output; invalid inputs fail before writing configuration or environment', (t) => {
  const f = fixture(t), first = configureWindowsOutput(f);
  assert.notEqual(configureWindowsOutput({ ...f, env: { ...f.env, GITHUB_RUN_ATTEMPT: '2' } }), first);
  assert.notEqual(configureWindowsOutput({ ...f, env: { ...f.env, TARGET_ARCH: 'arm64' } }), first);
  for (const invalid of [{ RUNNER_TEMP: 'relative' }, { RUNNER_TEMP: 'D:\\temp\nINJECTED=1' },
    { RUNNER_TEMP: `D:\\${'long'.repeat(22)}` }, { GITHUB_RUN_ID: '../escape' },
    { GITHUB_RUN_ATTEMPT: '0' }, { TARGET_ARCH: 'ia32' }, { GITHUB_ENV: '' }]) {
    const pkg = fs.readFileSync(f.packagePath), environment = fs.readFileSync(f.environmentFile);
    assert.throws(() => configureWindowsOutput({ ...f, env: { ...f.env, ...invalid } }), /Invalid|path budget/);
    assert.deepEqual(fs.readFileSync(f.packagePath), pkg);
    assert.deepEqual(fs.readFileSync(f.environmentFile), environment);
  }
});

function workflowScript(workflow, name) {
  const lines = workflow.split('\n'), start = lines.indexOf(`      - name: ${name}`);
  assert.ok(start >= 0, name);
  let end = start + 1;
  while (end < lines.length && !/^      - name:|^  [a-z][a-z-]+:/.test(lines[end])) end++;
  const block = lines.slice(start, end), run = block.indexOf('        run: |');
  assert.ok(run >= 0, name);
  return block.slice(run + 1).map(line => line.slice(10)).join('\n');
}

for (const file of ['release-electron.yml', 'release-electron-dev.yml']) {
  test(`${file}: Windows provenance and Release upload consume the configured output and reject missing output`, (t) => {
    const workflow = fs.readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');
    assert.match(workflowScript(workflow, 'Configure short output directory for Windows'), /node scripts\/configure-windows-output\.mjs/);
    const f = fixture(t), short = path.join(f.root, 'short-output'), legacy = path.join(f.root, 'nuwa-electron-shell/crates/agent-electron-client/release', f.pkg.version);
    fs.mkdirSync(short); fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(short, 'installer.exe'), 'new fixture');
    fs.writeFileSync(path.join(short, 'build-manifest-windows-x64.json'), '{}');
    fs.writeFileSync(path.join(legacy, 'stale.exe'), 'must not upload');
    const bin = path.join(f.root, 'bin'), calls = path.join(f.root, 'calls'); fs.mkdirSync(bin);
    for (const tool of ['node', 'gh']) fs.writeFileSync(path.join(bin, tool), '#!/bin/bash\nprintf "%s\\n" "$@" >> "$OUTPUT_CALLS"\n', { mode: 0o755 });
    const rewrite = script => script.replaceAll('${{ runner.os }}', 'Windows')
      .replaceAll('${{ needs.prepare.outputs.version }}', f.pkg.version)
      .replaceAll('${{ needs.prepare.outputs.tag }}', `v${f.pkg.version}`)
      .replaceAll('${{ github.ref_name }}', `v${f.pkg.version}`).replaceAll('${{ matrix.arch }}', 'x64');
    for (const name of ['Record platform source and verify macOS signature', 'Upload artifacts to Release']) {
      const script = rewrite(workflowScript(workflow, name));
      for (const output of [short, '']) {
        fs.writeFileSync(calls, '');
        const result = spawnSync('bash', ['-e', '-u', '-o', 'pipefail', '-c', script], { cwd: f.root, encoding: 'utf8', env: { ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH}`, NUWAX_WINDOWS_OUTPUT_DIR: output, OUTPUT_CALLS: calls,
          QA_BUILD: 'false', BUILD_VERSION: f.pkg.version, BUILD_IDENTITY: `v${f.pkg.version}`, TARGET_ARCH: 'x64', GITHUB_REPOSITORY: 'fixture/offline' } });
        const recorded = fs.readFileSync(calls, 'utf8');
        if (!output) { assert.notEqual(result.status, 0); assert.equal(recorded, ''); continue; }
        assert.equal(result.status, 0, result.stderr);
        assert.ok(recorded.includes(short)); assert.ok(!recorded.includes(legacy)); assert.ok(!recorded.includes('stale.exe'));
        if (name === 'Upload artifacts to Release') {
          assert.ok(recorded.includes(path.join(short, 'installer.exe')));
          assert.ok(recorded.includes(path.join(short, 'build-manifest-windows-x64.json')));
        }
      }
    }
  });
}
