"""Synthetic NSIS removal only: fixed fresh Temp root, fake files, own HKCU key.

From macOS: python3 scripts/acceptance/windows-uninstall-fixture.py
  --ssh-host win-pc --output-dir /absolute/owned/report-directory
On Windows omit --ssh-host. Requires existing NSIS3.0.4.1 and builder25.1.8.

Use the pinned vendor removal block/functions and the canonical overlay hook.
Never execute an installed Nuwax installer/uninstaller or application.
"""
from pathlib import Path
import argparse
import base64
import datetime
import hashlib
import json
import os
import subprocess
import sys
import uuid

CLIENT = Path(__file__).resolve().parents[2]
WORK = VENDOR = COMPILER = BASELINE = SSH_HOST = None


def prepare_source(phase, run_id):
    folder = WORK / ('nsis-' + phase + '-' + run_id)
    folder.mkdir()
    vendor = VENDOR.read_text(encoding='utf-8')
    functions = vendor[vendor.index('Function un.atomicRMDir'):vendor.index('Section "un.install"')]
    removal = vendor[vendor.index('  # delete the installed files'):vendor.index('  ${ifNot} ${isKeepShortcuts}')]
    header = BASELINE.read_text(encoding='utf-8') if phase == 'before' else (CLIENT / 'overlay/crates/agent-electron-client/build/installer.nsh').read_text(encoding='utf-8')
    (folder / 'canonical.nsh').write_text(header,encoding='utf-8')
    # The only registry operations target this random non-Uninstall test key.
    source = f'''Unicode true
Name "NuwaxRemovalFixture-{run_id}"
OutFile "builder.exe"
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!define UNINSTALL_FILENAME "Uninstall Nuwax.exe"
!define isUpdated '"$updateMode" == "1"'
Var updateMode
!include "canonical.nsh"
Function un.onInit
  StrCpy $INSTDIR "$EXEDIR\\fake-install"
  StrCpy $updateMode "0"
  ${{GetParameters}} $R0
  ${{GetOptions}} $R0 "--updated" $R1
  ${{IfNot}} ${{Errors}}
    StrCpy $updateMode "1"
  ${{EndIf}}
  ClearErrors
  SetOutPath "$EXEDIR"
  InitPluginsDir
FunctionEnd
Section
  WriteUninstaller "$EXEDIR\\UninstallFixture.exe"
SectionEnd
{functions}
Section "Uninstall"
{removal}
  ; This trace stands in for vendor shortcuts, associations and registrations.
  FileOpen $R0 "$EXEDIR\\cleanup-trace.txt" w
  FileWrite $R0 "cleanup-reached"
  FileClose $R0
  ClearErrors
  DeleteRegKey HKCU "Software\\NuwaxInstallerFixture\\{run_id}"
  SetErrorLevel 0
SectionEnd
'''
    (folder / 'fixture.nsi').write_text(source,encoding='utf-8')
    compiler_env = os.environ.copy()
    compiler_env['NSISDIR'] = str(COMPILER.parent.parent)
    r = subprocess.run([str(COMPILER), '-V3', 'fixture.nsi'], cwd=folder, env=compiler_env, capture_output=True, timeout=30)
    (folder / 'compile.log').write_bytes(r.stdout + r.stderr)
    if r.returncode:
        print((r.stdout + r.stderr).decode(errors='replace')[-5000:])
        raise RuntimeError('synthetic NSIS compile failed')
    binary = (folder / 'builder.exe').read_bytes()
    return {'runId': run_id, 'phase': phase, 'builderB64': base64.b64encode(binary).decode(),
            'builderSha256': hashlib.sha256(binary).hexdigest(),
            'vendorSha256': hashlib.sha256(VENDOR.read_bytes()).hexdigest(),
            'hookSha256': hashlib.sha256(header.encode()).hexdigest(),
            'compilerSha256': hashlib.sha256(COMPILER.read_bytes()).hexdigest(),
            'sourceSha256': hashlib.sha256(source.encode()).hexdigest()}


REMOTE = r'''
import base64,ctypes,datetime,hashlib,json,os,pathlib,subprocess,tempfile,winreg
from ctypes import wintypes
payload=PAYLOAD
root=pathlib.Path(tempfile.gettempdir())/('nuwax-nsis-fixture-'+payload['runId'])
if root.exists():raise ValueError('refuse existing root')
for p in (root.parent,*root.parent.parents):
 s=p.lstat()
 if p.is_symlink() or getattr(s,'st_file_attributes',0)&0x400:raise ValueError('reparse ancestor')
root.mkdir();(root/'owner.json').write_text(json.dumps({'runId':payload['runId'],'kind':'synthetic-nsis-uninstall'}))
binary=base64.b64decode(payload['builderB64'])
if hashlib.sha256(binary).hexdigest()!=payload['builderSha256']:raise ValueError('builder hash mismatch')
(root/'builder.exe').write_bytes(binary)
env=os.environ.copy();own_temp=root/'nsis-temp';own_temp.mkdir();env['TEMP']=str(own_temp);env['TMP']=str(own_temp)
reg='Software\\NuwaxInstallerFixture\\'+payload['runId']
def invoke(exe,*args):
 r=subprocess.run([str(exe),*args],cwd=str(root),env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=25)
 return r.returncode
def reg_present():
 try:
  with winreg.OpenKey(winreg.HKEY_CURRENT_USER,reg):return True
 except FileNotFoundError:return False
if invoke(root/'builder.exe','/S')!=0:raise ValueError('fixture bootstrap failed')
if not (root/'UninstallFixture.exe').is_file():raise ValueError('missing test uninstaller')
kernel=ctypes.WinDLL('kernel32',use_last_error=True)
kernel.CreateFileW.argtypes=[wintypes.LPCWSTR,wintypes.DWORD,wintypes.DWORD,wintypes.LPVOID,wintypes.DWORD,wintypes.DWORD,wintypes.HANDLE]
kernel.CreateFileW.restype=wintypes.HANDLE
kernel.CloseHandle.argtypes=[wintypes.HANDLE];kernel.CloseHandle.restype=wintypes.BOOL
rows=[]
for case,updated,locked in [('standalone-locked',False,True),('updated-locked',True,True),('standalone-normal',False,False),('updated-normal',True,False),('standalone-missing-uninstaller',False,False)]:
 install=root/'fake-install'
 if install.exists():raise ValueError('previous fixture residue unexpectedly remains')
 install.mkdir();(install/'Nuwax.exe').write_bytes(b'NOT AN EXECUTABLE: fake payload')
 uninstaller=install/'Uninstall Nuwax.exe';uninstaller.write_bytes(b'NOT AN EXECUTABLE: fake registry target')
 (install/'workspace').mkdir();(install/'workspace/user.txt').write_bytes(b'fake user data U1 must be tracked separately')
 outside=root/'outside-sentinel.txt';outside.write_bytes(b'outside fake install must survive')
 original_hash=hashlib.sha256(uninstaller.read_bytes()).hexdigest()
 if case=='standalone-missing-uninstaller':uninstaller.unlink()
 with winreg.CreateKey(winreg.HKEY_CURRENT_USER,reg) as key:winreg.SetValueEx(key,'FixtureOnly',0,winreg.REG_SZ,'not a real uninstall registration')
 trace=root/'cleanup-trace.txt'
 if trace.exists():trace.unlink()
 handle=None
 if locked:
  handle=kernel.CreateFileW(str(install/'Nuwax.exe'),0x80000000,0,None,3,0,None)
  if handle in (None,ctypes.c_void_p(-1).value):raise OSError('could not acquire own fixture lock')
 try:
  args=['/S']+(['--updated'] if updated else [])
  # Wait for the exact self-contained uninstaller, not the temporary relaunch.
  args.append('_?='+str(install))
  exit_code=invoke(root/'UninstallFixture.exe',*args)
  rows.append({'case':case,'exitCode':exit_code,'registryPreserved':reg_present(),'cleanupReached':trace.exists(),
               'payloadResidual':(install/'Nuwax.exe').exists(),'uninstallerPreserved':uninstaller.is_file(),
               'uninstallerHashPreserved':uninstaller.is_file() and hashlib.sha256(uninstaller.read_bytes()).hexdigest()==original_hash,
               'outsideSentinelUnchanged':outside.read_bytes()==b'outside fake install must survive',
               'installWorkspaceSurvives':(install/'workspace/user.txt').exists(),'actualApplicationInvoked':False})
 finally:
  if handle is not None:kernel.CloseHandle(handle)
 if locked and payload['phase']=='after':
  retry_exit=invoke(root/'UninstallFixture.exe',*args)
  rows.append({'case':case+'-retry','exitCode':retry_exit,'registryPreserved':reg_present(),'cleanupReached':trace.exists(),
               'payloadResidual':(install/'Nuwax.exe').exists(),'outsideSentinelUnchanged':outside.read_bytes()==b'outside fake install must survive',
               'actualApplicationInvoked':False})
 # Only unlink fake case files after its result is recorded, within exclusive root.
 import shutil
 if install.exists():shutil.rmtree(install)
 if reg_present():winreg.DeleteKey(winreg.HKEY_CURRENT_USER,reg)
result={'recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'phase':payload['phase'],'fixtureRoot':str(root),
        'runId':payload['runId'],'cases':rows,'source':{k:payload[k] for k in ['vendorSha256','hookSha256','compilerSha256','sourceSha256','builderSha256']},
        'realRegistryOrInstallationTouched':False,'ownRegistryCleaned':not reg_present(),'onlySyntheticUninstallerExecuted':True,
        'limits':['No real Nuwax uninstall executed','U1 install-directory user-data preservation remains open','ACL and interruption cases not covered']}
print(json.dumps(result))
'''


def main():
    global WORK, VENDOR, COMPILER, BASELINE, SSH_HOST
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ssh-host', help='Explicit Windows SSH host; omit only when running on Windows locally')
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--nsis-root', type=Path, help='Pinned nsis-3.0.4.1 cache directory')
    parser.add_argument('--baseline-header', type=Path, help='Optional pre-fix canonical installer.nsh for before/after proof')
    args = parser.parse_args()
    if os.name != 'nt' and not args.ssh_host:
        parser.error('An explicit Windows SSH host is required from another platform')
    SSH_HOST, BASELINE = args.ssh_host, args.baseline_header
    phase = 'before' if BASELINE else 'after'
    vendors = list((CLIENT / 'nuwa-electron-shell/node_modules/.pnpm').glob('app-builder-lib@25.1.8*/node_modules/app-builder-lib/templates/nsis/uninstaller.nsh'))
    if len(vendors) != 1:
        raise ValueError('Exactly one pinned app-builder-lib 25.1.8 is required')
    VENDOR = vendors[0]
    default_nsis = (Path(os.environ['LOCALAPPDATA']) / 'electron-builder/Cache/nsis/nsis-3.0.4.1' if os.name == 'nt'
                    else Path.home() / 'Library/Caches/electron-builder/nsis/nsis-3.0.4.1')
    nsis_root = args.nsis_root or default_nsis
    COMPILER = nsis_root / ('Bin/makensis.exe' if os.name == 'nt' else 'mac/makensis')
    if not COMPILER.is_file():
        raise ValueError('Pinned NSIS compiler is unavailable; no compiler is downloaded automatically')
    args.output_dir.mkdir(parents=True, exist_ok=True)
    WORK = args.output_dir.resolve() / ('nuwax-uninstall-report-' + str(uuid.uuid4()))
    WORK.mkdir()
    payload = prepare_source(phase, str(uuid.uuid4()))
    (WORK / ('uninstall-u2-' + phase + '-input.json')).write_text(json.dumps({k:v for k,v in payload.items() if k!='builderB64'},indent=2)+'\n')
    code = REMOTE.replace('payload=PAYLOAD', 'payload=json.loads(base64.b64decode('+repr(base64.b64encode(json.dumps(payload).encode()).decode())+'))')
    command = (['ssh','-o','BatchMode=yes','-o','ConnectTimeout=8',SSH_HOST,'python','-'] if SSH_HOST else [sys.executable,'-'])
    r = subprocess.run(command,input=code.encode('utf-8'),capture_output=True,timeout=145)
    if r.returncode:
        print(r.stderr.decode(errors='replace')[-1600:])
        raise RuntimeError('synthetic fixture failed')
    result = json.loads(r.stdout)
    output = WORK / ('uninstall-u2-' + phase + '-actual.json')
    output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    cases = {r['case']: r for r in result['cases']}
    if phase == 'before':
        row = cases['standalone-locked']
        if not (row['exitCode'] != 0 and row['registryPreserved'] and not row['cleanupReached'] and row['uninstallerHashPreserved']):
            result['assertionsPassed'] = False
            output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
            raise RuntimeError('Regression reproduced: locked standalone deletion reported success and removed its retry entry; actual report: ' + str(output))
    if phase == 'after':
        for case in ['standalone-locked', 'updated-locked']:
            row = cases[case]
            if not (row['exitCode'] != 0 and row['registryPreserved'] and not row['cleanupReached'] and row['uninstallerHashPreserved']):
                raise RuntimeError('locked removal did not preserve retry entry')
            row = cases[case+'-retry']
            if not (row['exitCode'] == 0 and not row['registryPreserved'] and row['cleanupReached'] and not row['payloadResidual']):
                raise RuntimeError('unlocked retry failed')
        for case in ['standalone-normal', 'updated-normal']:
            row = cases[case]
            if not (row['exitCode'] == 0 and not row['registryPreserved'] and row['cleanupReached'] and not row['payloadResidual']):
                raise RuntimeError('normal removal failed')
        row = cases['standalone-missing-uninstaller']
        if not (row['exitCode'] != 0 and row['registryPreserved'] and not row['cleanupReached'] and row['payloadResidual'] and row['installWorkspaceSurvives']):
            raise RuntimeError('backup preflight failure did not preserve data')
    if not all(r['outsideSentinelUnchanged'] for r in result['cases']):
        raise RuntimeError('fixture crossed its directory boundary')
    result['assertionsPassed'] = True
    output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'reportPath':str(output),**result},ensure_ascii=True))


if __name__ == '__main__':
    main()
