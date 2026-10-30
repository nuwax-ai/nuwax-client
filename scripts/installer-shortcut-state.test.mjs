import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = fs.readFileSync(path.join(root, 'nuwa-electron-shell/crates/agent-electron-client/build/installer.nsh'), 'utf8');
function productionMacro(name) {
  const match = source.match(new RegExp(`^!macro ${name}(?: [^\\n]*)?\\n[\\s\\S]*?^!macroend`, 'm'));
  assert.ok(match, `Missing production macro ${name}`);
  return match[0];
}

test('real NSIS runs the production shortcut policy across preservation and repair boundaries', t => {
  const nsis = process.env.NUWAX_TEST_NSIS_ROOT ?? path.join(os.homedir(), 'Library/Caches/electron-builder/nsis/nsis-3.0.4.1');
  const compiler = path.join(nsis, process.platform === 'win32' ? 'Bin/makensis.exe' : 'mac/makensis');
  if (!fs.existsSync(compiler)) return t.skip('Requires cached NSIS SDK; never downloads tools');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-shortcut-state-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'shortcut-policy.exe');
  const identity = crypto.randomUUID();
  const script = `Unicode true
Name "Nuwax shortcut policy QA"
OutFile "${executable}"
RequestExecutionLevel user
SilentInstall silent
!include LogicLib.nsh
!define APP_EXECUTABLE_FILENAME "Nuwax.exe"
!define INSTALL_REGISTRY_KEY "Software\\NuwaxShortcutPolicyQA-${identity}"
Var nuwaxShortcutStatePath
Var nuwaxKeepShortcutsBeforePrepare
Var isTryToKeepShortcuts
Var keepShortcuts
Var fixtureRoot
Var failures
Var report
${productionMacro('nuwaxCaptureShortcutState')}
${productionMacro('nuwaxApplyPreparedShortcutState')}
!macro expect VALUE LABEL
  \${if} $keepShortcuts != "\${VALUE}"
    IntOp $failures $failures + 1
    FileWrite $report "FAIL \${LABEL}: $keepShortcuts$\\r$\\n"
  \${else}
    FileWrite $report "PASS \${LABEL}$\\r$\\n"
  \${endif}
!macroend
Section
  StrCpy $fixtureRoot "$TEMP\\NuwaxShortcutPolicyQA-${identity}"
  StrCpy $INSTDIR "$fixtureRoot\\selected"
  CreateDirectory "$INSTDIR"
  StrCpy $failures 0
  FileOpen $report "$EXEDIR\\shortcut-policy.log" w
  FileOpen $0 "$INSTDIR\\Nuwax.exe" w
  FileWrite $0 "Synthetic fixture, never executed."
  FileClose $0
  WriteRegStr HKCU "\${INSTALL_REGISTRY_KEY}" KeepShortcuts "true"
  StrCpy $R8 "preserved-register"
  !insertmacro nuwaxCaptureShortcutState HKCU $INSTDIR
  Rename "$INSTDIR\\Nuwax.exe" "$INSTDIR\\saved.exe"
  StrCpy $isTryToKeepShortcuts "true"
  StrCpy $keepShortcuts "false"
  !insertmacro nuwaxApplyPreparedShortcutState
  !insertmacro expect true prepared-update-preserves-deletion
  \${if} $R8 != "preserved-register"
    IntOp $failures $failures + 1
    FileWrite $report "FAIL working-register-preserved$\\r$\\n"
  \${else}
    FileWrite $report "PASS working-register-preserved$\\r$\\n"
  \${endif}
  !insertmacro nuwaxCaptureShortcutState HKCU $INSTDIR
  StrCpy $keepShortcuts "false"
  !insertmacro nuwaxApplyPreparedShortcutState
  !insertmacro expect true retry-keeps-original-observation
  StrCpy $isTryToKeepShortcuts "false"
  StrCpy $keepShortcuts "false"
  !insertmacro nuwaxApplyPreparedShortcutState
  !insertmacro expect false manual-repair-retains-default-policy
  StrCpy $isTryToKeepShortcuts "true"
  StrCpy $INSTDIR "$fixtureRoot\\other"
  StrCpy $keepShortcuts "false"
  !insertmacro nuwaxApplyPreparedShortcutState
  !insertmacro expect false other-directory-cannot-inherit-snapshot
  StrCpy $INSTDIR "$fixtureRoot\\selected"
  Rename "$INSTDIR\\saved.exe" "$INSTDIR\\Nuwax.exe"
  WriteRegStr HKCU "\${INSTALL_REGISTRY_KEY}" KeepShortcuts "false"
  StrCpy $nuwaxShortcutStatePath ""
  !insertmacro nuwaxCaptureShortcutState HKCU $INSTDIR
  StrCpy $keepShortcuts "false"
  !insertmacro nuwaxApplyPreparedShortcutState
  !insertmacro expect false registry-opt-out-is-not-promoted
  WriteRegStr HKCU "\${INSTALL_REGISTRY_KEY}" KeepShortcuts "true"
  Delete "$INSTDIR\\Nuwax.exe"
  StrCpy $nuwaxShortcutStatePath ""
  !insertmacro nuwaxCaptureShortcutState HKCU $INSTDIR
  StrCpy $keepShortcuts "false"
  !insertmacro nuwaxApplyPreparedShortcutState
  !insertmacro expect false originally-missing-executable-is-not-promoted
  DeleteRegKey HKCU "\${INSTALL_REGISTRY_KEY}"
  StrCpy $nuwaxShortcutStatePath ""
  !insertmacro nuwaxCaptureShortcutState HKCU $INSTDIR
  StrCpy $keepShortcuts "false"
  !insertmacro nuwaxApplyPreparedShortcutState
  !insertmacro expect false missing-registration-is-not-promoted
  StrCpy $nuwaxShortcutStatePath ""
  StrCpy $nuwaxKeepShortcutsBeforePrepare ""
  StrCpy $keepShortcuts "false"
  !insertmacro nuwaxApplyPreparedShortcutState
  !insertmacro expect false fresh-install-retains-default-policy
  FileClose $report
  RMDir /r "$fixtureRoot"
  FileOpen $0 "$EXEDIR\\shortcut-policy-result.json" w
  FileWrite $0 '{"cases":9,"failed":$failures}$\\r$\\n'
  FileClose $0
  SetErrorLevel $failures
SectionEnd
`;
  const input = path.join(directory, 'fixture.nsi');
  fs.writeFileSync(input, script);
  execFileSync(compiler, ['-V2', input], { env: { ...process.env, NSISDIR: nsis }, stdio: 'pipe' });
  assert.ok(fs.statSync(executable).size > 0);
  if (process.env.NUWAX_SHORTCUT_POLICY_FIXTURE) {
    const exported = process.env.NUWAX_SHORTCUT_POLICY_FIXTURE;
    assert.ok(path.isAbsolute(exported), 'Fixture export must be absolute');
    fs.copyFileSync(executable, exported, fs.constants.COPYFILE_EXCL);
    t.diagnostic(`Windows runtime fixture exported to ${exported}`);
  }
  if (process.platform === 'win32') {
    execFileSync(executable, ['/S'], { timeout: 30000, stdio: 'pipe' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'shortcut-policy-result.json'))), { cases: 9, failed: 0 });
  } else {
    t.diagnostic('Compiled actual production macros; runtime behavior requires Windows.');
  }
});
