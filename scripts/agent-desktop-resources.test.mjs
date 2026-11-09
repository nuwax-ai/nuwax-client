import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareAgentDesktop, desktopResourceFiles, extractDesktopFiles } from './client/agent-desktop-resources.mjs';

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
