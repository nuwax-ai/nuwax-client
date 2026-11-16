import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

test('native NSIS records completion only in its product and transaction key', t => {
  const sdk = process.env.NUWAX_TEST_NSIS_ROOT ?? path.join(os.homedir(), 'Library/Caches/electron-builder/nsis/nsis-3.0.4.1');
  const compiler = path.join(sdk, process.platform === 'win32' ? 'Bin/makensis.exe' : 'mac/makensis');
  if (!fs.existsSync(compiler)) return t.skip('Requires cached NSIS SDK');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-completion-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const identity = 'nuwax-completion-qa-' + randomUUID();
  const id = randomUUID();
  const source = fs.readFileSync('nuwa-electron-shell/crates/agent-electron-client/build/windows-installer-runtime.nsh', 'utf8');
  const production = source.match(/^Function nuwaxRecordInstallCompletion\n[\s\S]*?^FunctionEnd/m)?.[0];
  assert.ok(production);
  const executable = path.join(directory, 'completion.exe');
  const registry = 'Software\\' + identity + '\\InstallerResults\\' + id;
  const input = [
    'Unicode true', 'Name CompletionQA', 'RequestExecutionLevel user', 'SilentInstall silent',
    'OutFile "' + executable + '"', '!include LogicLib.nsh',
    '!define APP_PACKAGE_NAME "' + identity + '"', '!define VERSION "3.2.0"', production,
    'Section',
    'SetRegView 64', 'StrCpy $INSTDIR "C:\\Synthetic Nuwax QA"', 'StrCpy $0 "' + id + '"',
    'Call nuwaxRecordInstallCompletion',
    'ReadRegStr $R0 HKCU "' + registry + '" Status',
    'ReadRegStr $R1 HKCU "' + registry + '" Version',
    'ReadRegStr $R2 HKCU "' + registry + '" InstallPath',
    'StrCpy $3 0',
    'StrCmp $R0 "complete" +2 0', 'StrCpy $3 1',
    'StrCmp $R1 "3.2.0" +2 0', 'StrCpy $3 1',
    'StrCmp $R2 "$INSTDIR" +2 0', 'StrCpy $3 1',
    'DeleteRegKey HKCU "Software\\' + identity + '"',
    'FileOpen $R0 "$EXEDIR\\completion-result.txt" w', 'FileWrite $R0 "$3"', 'FileClose $R0',
    'SetErrorLevel $3', 'SectionEnd', '',
  ].join('\n');
  const file = path.join(directory, 'completion.nsi');
  fs.writeFileSync(file, input);
  execFileSync(compiler, ['-V2', file], { env: { ...process.env, NSISDIR: sdk }, stdio: 'pipe' });
  if (process.env.NUWAX_COMPLETION_FIXTURE) {
    assert.ok(path.isAbsolute(process.env.NUWAX_COMPLETION_FIXTURE));
    fs.copyFileSync(executable, process.env.NUWAX_COMPLETION_FIXTURE, fs.constants.COPYFILE_EXCL);
    t.diagnostic('Exported random-identity Windows completion fixture.');
  }
  if (process.platform === 'win32') {
    execFileSync(executable, ['/S'], { timeout: 30_000 });
    assert.equal(fs.readFileSync(path.join(directory, 'completion-result.txt'), 'utf8'), '0');
  } else t.diagnostic('Compiled production registry writer; runtime requires Windows.');
});
