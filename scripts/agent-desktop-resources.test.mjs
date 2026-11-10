import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareAgentDesktop, desktopResourceFiles, extractDesktopFiles } from './client/agent-desktop-resources.mjs';
import { windowsDesktopRecipe, verifyWindowsDesktopSource } from './client/agent-desktop-windows.mjs';
import { AGENT_DESKTOP_INTEGRITY } from './client/agent-desktop-resources.mjs';
import { createHash } from 'node:crypto';

test('untrusted Agent Desktop archives cannot reach extraction or replace existing resources', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-admission-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const destination = path.join(root, 'nuwa-electron-shell/crates/agent-electron-client/resources/agent-desktop/darwin-arm64');
  fs.mkdirSync(destination, { recursive: true }); fs.writeFileSync(path.join(destination, 'keep'), 'existing');
  await assert.rejects(prepareAgentDesktop(root, { platform: 'darwin', arch: 'arm64', fetcher: async () => new Response('corrupt archive') }), /integrity mismatch/);
  assert.equal(fs.readFileSync(path.join(destination, 'keep'), 'utf8'), 'existing');
});
test('unsupported platforms are rejected before downloading or executing', async () => {
  let fetched = false;
  await assert.rejects(prepareAgentDesktop('/unused', { platform: 'linux', arch: 'ia32', fetcher: async () => { fetched = true; } }), /Unsupported/);
  assert.equal(fetched, false);
  assert.equal(desktopResourceFiles('darwin', 'x64').length, 2);
});

test('native tar extracts only selected desktop payload from a directory with spaces', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop archive '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, 'input/package/bin'), name = 'agent-desktop-win32-x64.exe';
  fs.mkdirSync(input, { recursive: true });
  fs.writeFileSync(path.join(input, name), 'native binary fixture');
  fs.writeFileSync(path.join(input, name + '.sha256'), 'digest fixture');
  fs.writeFileSync(path.join(input, 'unselected'), 'must remain outside payload');
  execFileSync('tar', ['-czf', 'archive.tgz', '-C', 'input', 'package'], { cwd: root });
  await extractDesktopFiles(root, [name]);
  assert.equal(fs.readFileSync(path.join(root, 'package/bin', name), 'utf8'), 'native binary fixture');
  assert.equal(fs.readFileSync(path.join(root, 'package/bin', name + '.sha256'), 'utf8'), 'digest fixture');
  assert.equal(fs.existsSync(path.join(root, 'package/bin/unselected')), false);
});

test('Windows source archive integrity is checked before compilation', () => {
  assert.throws(() => verifyWindowsDesktopSource(Buffer.from('changed source')), /source integrity mismatch/);
});

test('Windows resources require the current patch recipe and intact binary; failed refresh preserves old resources', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-windows-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const patch = path.join(root, 'third-party/patches/agent-desktop-windows-no-focus.patch');
  fs.mkdirSync(path.dirname(patch), { recursive: true }); fs.writeFileSync(patch, 'patch v1');
  const recipe = windowsDesktopRecipe(root, 'x64');
  const destination = path.join(root, 'nuwa-electron-shell/crates/agent-electron-client/resources/agent-desktop/win32-x64');
  fs.mkdirSync(destination, { recursive: true });
  const name = desktopResourceFiles('win32', 'x64')[0], binary = path.join(destination, name);
  fs.writeFileSync(binary, 'built binary fixture');
  const manifest = { integrity: AGENT_DESKTOP_INTEGRITY, nativeBuild: { recipe }, files: { [name]: createHash('sha256').update(fs.readFileSync(binary)).digest('hex') } };
  fs.writeFileSync(path.join(destination, 'source.json'), JSON.stringify(manifest));
  let fetched = false;
  const fetcher = async () => { fetched = true; throw new Error('refresh requested'); };
  assert.equal(await prepareAgentDesktop(root, { platform: 'win32', arch: 'x64', fetcher }), destination);
  assert.equal(fetched, false);
  fs.writeFileSync(patch, 'patch v2');
  await assert.rejects(prepareAgentDesktop(root, { platform: 'win32', arch: 'x64', fetcher }), /refresh requested/);
  assert.equal(fetched, true);
  assert.equal(fs.readFileSync(binary, 'utf8'), 'built binary fixture');
  fs.writeFileSync(patch, 'patch v1');
  fs.writeFileSync(binary, 'tampered'); fetched = false;
  await assert.rejects(prepareAgentDesktop(root, { platform: 'win32', arch: 'x64', fetcher }), /refresh requested/);
  assert.equal(fetched, true);
  fs.writeFileSync(binary, 'built binary fixture');
  delete manifest.nativeBuild; fs.writeFileSync(path.join(destination, 'source.json'), JSON.stringify(manifest));
  fetched = false;
  await assert.rejects(prepareAgentDesktop(root, { platform: 'win32', arch: 'x64', fetcher }), /refresh requested/);
  assert.equal(fetched, true, 'Unpatched npm binary must not satisfy the Windows cache');
});
