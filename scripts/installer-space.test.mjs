import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const build = path.join(root, 'overlay/crates/agent-electron-client/build');
test('space check is before app shutdown, preservation and the vendor uninstall', () => {
  const source = fs.readFileSync(path.join(build, 'installer.nsh'), 'utf8');
  const macro = source.split('!macro customCheckAppRunning')[1].split('!macroend')[0];
  assert.ok(macro.indexOf('nuwaxRequireInstallSpace') >= 0);
  assert.ok(macro.indexOf('nuwaxRequireInstallSpace') < macro.indexOf('nuwaxFindAppProcess'));
  assert.match(source, /Function nuwaxInstFilesPre[\s\S]*?nuwaxInstallSpacePage/);
  assert.match(source, /UAC_IsInnerInstance[\s\S]*?customCheckAppRunning/);
});

test('real NSIS compiles the 64-bit budget bridge for ZIP and 7z, single and combined architecture', t => {
  const nsis = process.env.NUWAX_TEST_NSIS_ROOT ?? path.join(os.homedir(), 'Library/Caches/electron-builder/nsis/nsis-3.0.4.1');
  const compiler = path.join(nsis, process.platform === 'win32' ? 'Bin/makensis.exe' : 'mac/makensis');
  if (!fs.existsSync(compiler)) return t.skip('Requires actual NSIS SDK');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-space-compile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const plugins = path.join(path.dirname(nsis), 'nsis-resources-3.4.1/plugins/x86-unicode');
  for (const zip of [true, false]) for (const combined of [true, false]) {
    const script = path.join(dir, 'fixture.nsi');
    fs.writeFileSync(script, `Unicode true\nName SpaceQA\nOutFile "${path.join(dir, 'fixture.exe')}"\nRequestExecutionLevel user\n!include LogicLib.nsh\n!include x64.nsh\n!include nsDialogs.nsh\n!addplugindir "${plugins}"\n!define BUILD_RESOURCES_DIR "${build}"\n!define APP_64 fixture\n!define APP_64_UNPACKED_SIZE 9000000\n${combined ? '!define APP_ARM64 fixture\n!define APP_ARM64_UNPACKED_SIZE 8000000\n' : ''}${zip ? '!define ZIP_COMPRESSION\n' : ''}!define APP_INSTALLER_STORE_FILE "SpaceQA-updater/installer.exe"\n!define VERSION "3.0.23"\nVar installMode\n!include "${path.join(build, 'windows-install-space.nsh')}"\nFunction nuwaxInstFilesPre\nFunctionEnd\nPage instfiles\nSection\n!insertmacro nuwaxRequireInstallSpace\nSectionEnd\n`);
    execFileSync(compiler, ['-V2', script], { env: { ...process.env, NSISDIR: nsis }, encoding: 'utf8', stdio: 'pipe' });
    assert.ok(fs.statSync(path.join(dir, 'fixture.exe')).size > 0);
  }
});
