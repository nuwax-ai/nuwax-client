import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installedBuilder } from './test-support/fixtures.mjs';

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

test('pinned vendor installer and uninstaller compile with the complete commercial overlay', async t => {
  const nsis = process.env.NUWAX_TEST_NSIS_ROOT ?? path.join(os.homedir(), 'Library/Caches/electron-builder/nsis/nsis-3.0.4.1');
  const compiler = path.join(nsis, process.platform === 'win32' ? 'Bin/makensis.exe' : 'mac/makensis');
  if (!fs.existsSync(compiler)) return t.skip('Requires cached NSIS SDK; does not download tools during unit tests');
  const builder = installedBuilder(t);
  if (!builder) return;
  const { build: runBuild, Platform, Arch } = builder('electron-builder');
  const { NsisTarget } = builder('app-builder-lib/out/targets/nsis/NsisTarget.js');
  const { nsisTemplatesDir } = builder('app-builder-lib/out/targets/nsis/nsisUtil.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-space-vendor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = path.join(dir, 'app'), resources = path.join(dir, 'build');
  fs.mkdirSync(app); fs.mkdirSync(path.join(app, 'resources')); fs.mkdirSync(resources);
  fs.writeFileSync(path.join(app, 'Nuwax.exe'), 'Synthetic file, never executed.');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'nuwax-space-qa', version: '3.0.23', main: 'index.js', author: 'Nuwax', description: 'Compile-only space fixture' }));
  for (const file of fs.readdirSync(build)) if (/\.(nsh|ps1)$/.test(file)) fs.copyFileSync(path.join(build, file), path.join(resources, file));
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const manifest = require('../overlay/crates/agent-electron-client/scripts/build/uninstall-payload.cjs').writeUninstallPayload({ appOutDir: app, arch: 1, packager: { projectDir: dir, appInfo: { name: 'nuwax-space-qa', productFilename: 'Nuwax' } } });
  const include = path.join(resources, 'qa-include.nsh');
  fs.writeFileSync(include, `!define NUWAX_UNINSTALL_MANIFEST "${manifest}"\n!include "${path.join(resources, 'installer.nsh')}"\n`);
  const original = NsisTarget.prototype.computeScriptAndSignUninstaller;
  // Compile both vendor phases without executing any generated EXE. A dummy
  // uninstaller is embedded only in this compile-only fixture.
  NsisTarget.prototype.computeScriptAndSignUninstaller = async function(defines, commands, installer, header, archs) {
    const script = fs.readFileSync(path.join(nsisTemplatesDir, 'installer.nsi'), 'utf8');
    const dummy = path.join(dir, 'compile-only-uninstaller.exe');
    await this.executeMakensis({ ...defines, BUILD_UNINSTALLER: null, UNINSTALLER_OUT_FILE: dummy }, commands, header + await this.computeFinalScript(script, false, archs));
    fs.writeFileSync(dummy, 'Compile-only placeholder, never executed.');
    defines.UNINSTALLER_OUT_FILE = dummy;
    return script;
  };
  try {
    await runBuild({ projectDir: dir, prepackaged: app, targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), publish: 'never',
      config: { extends: null, appId: 'com.nuwax-ai.spaceqa.compile', productName: 'Nuwax', electronVersion: '40.8.2', npmRebuild: false,
        directories: { output: path.join(dir, 'out'), buildResources: resources },
        win: { signAndEditExecutable: false },
        nsis: { include, packElevateHelper: false, oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, useZip: true, differentialPackage: false, warningsAsErrors: false }, publish: null } });
    assert.ok(fs.readdirSync(path.join(dir, 'out')).some(file => file.endsWith('.exe')));
  } finally { NsisTarget.prototype.computeScriptAndSignUninstaller = original; }
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
    fs.writeFileSync(script, `Unicode true\nName SpaceQA\nOutFile "${path.join(dir, 'fixture.exe')}"\nRequestExecutionLevel user\n!include MUI2.nsh\n!include x64.nsh\n!include nsDialogs.nsh\n!addplugindir "${plugins}"\n!define BUILD_RESOURCES_DIR "${build}"\n!define APP_64 fixture\n!define APP_64_UNPACKED_SIZE 9000000\n${combined ? '!define APP_ARM64 fixture\n!define APP_ARM64_UNPACKED_SIZE 8000000\n' : ''}${zip ? '!define ZIP_COMPRESSION\n' : ''}!define APP_INSTALLER_STORE_FILE "SpaceQA-updater/installer.exe"\n!define VERSION "3.0.23"\nVar installMode\n!include "${path.join(build, 'windows-install-space.nsh')}"\n!insertmacro nuwaxInstallSpaceFunctions\nFunction nuwaxInstFilesPre\nFunctionEnd\n!insertmacro MUI_PAGE_DIRECTORY\n!insertmacro nuwaxInstallSpacePage\n!insertmacro MUI_PAGE_INSTFILES\n!insertmacro MUI_LANGUAGE "SimpChinese"\nSection\n!insertmacro nuwaxRequireInstallSpace\nSectionEnd\n`);
    execFileSync(compiler, ['-V2', script], { env: { ...process.env, NSISDIR: nsis }, encoding: 'utf8', stdio: 'pipe' });
    assert.ok(fs.statSync(path.join(dir, 'fixture.exe')).size > 0);
  }
});
