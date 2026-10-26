// Build small random-identity fixtures using the production space check.
// No production app, registry, update cache, or uninstaller is executed.
// node scripts/acceptance/windows-installer-space.cjs <new-output-dir> <nsis-root>
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const [output, nsis] = process.argv.slice(2);
if (!output || !nsis || !path.isAbsolute(output) || !path.isAbsolute(nsis) || fs.existsSync(output)) throw Error('Explicit new output directory and NSIS root required');
fs.mkdirSync(output);
const source = path.resolve(__dirname, '../../overlay/crates/agent-electron-client/build');
const identity = 'NuwaxSpaceQA-' + crypto.randomUUID();
const compiler = path.join(nsis, process.platform === 'win32' ? 'Bin/makensis.exe' : 'mac/makensis');
const plugins = path.join(path.dirname(nsis), 'nsis-resources-3.4.1/plugins/x86-unicode');
const files = {};
for (const [kind, size] of [['good', 1], ['low', 900000000000], ['invalid', 0]]) {
  const name = identity + '-' + kind + '.exe';
  const script = `Unicode true
Name "${identity}"
OutFile "${path.join(output, name)}"
RequestExecutionLevel user
InstallDir "$EXEDIR\\target-${kind}"
!include MUI2.nsh
!include x64.nsh
!include nsDialogs.nsh
!addplugindir "${plugins}"
!define BUILD_RESOURCES_DIR "${source}"
!define APP_64 fixture
!define APP_64_UNPACKED_SIZE ${size}
!define ZIP_COMPRESSION
!define APP_INSTALLER_STORE_FILE "${identity}\\installer.exe"
!define VERSION "3.0.23-space-fixture"
Var installMode
!include "${path.join(source, 'windows-install-space.nsh')}"
!insertmacro nuwaxInstallSpaceFunctions
Function nuwaxInstFilesPre
FunctionEnd
Function .onInit
  StrCpy $installMode "CurrentUser"
FunctionEnd
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro nuwaxInstallSpacePage
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
Section
  !insertmacro nuwaxRequireInstallSpace
  ; These stand in for the actions after the production hook. They must not
  ; execute if space inspection failed, including in silent mode.
  FileOpen $0 "$EXEDIR\\${kind}-shutdown.marker" w
  FileClose $0
  FileOpen $0 "$EXEDIR\\${kind}-prepare.marker" w
  FileClose $0
  FileOpen $0 "$EXEDIR\\${kind}-uninstall.marker" w
  FileClose $0
  SetErrorLevel 0
SectionEnd
`;
  const input = path.join(output, kind + '.nsi');
  fs.writeFileSync(input, script);
  execFileSync(compiler, ['-V2', input], { env: { ...process.env, NSISDIR: nsis }, stdio: 'inherit' });
  files[kind] = { name, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(output, name))).digest('hex') };
}
fs.writeFileSync(path.join(output, 'space-fixture.json'), JSON.stringify({ kind: 'Synthetic Nuwax disk space QA', identity, files }, null, 2));
console.log('SPACE_FIXTURE_READY', output);
