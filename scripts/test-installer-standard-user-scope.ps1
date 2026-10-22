# Run in a standard Windows account against an admin-staged random synthetic
# product. The caller installs the matching machine copy in MachineInstallDir.
param([Parameter(Mandatory=$true)][string]$PackageRoot,
 [Parameter(Mandatory=$true)][string]$MachineInstallDir,
 [Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$m=Get-Content -LiteralPath (Join-Path $PackageRoot 'qa-meta.json') -Raw|ConvertFrom-Json
if($m.kind -ne 'Synthetic Nuwax installer recovery QA' -or -not $m.syntheticPayload -or -not $m.nativeWindows -or $m.guid -notmatch '^[0-9a-f-]{36}$' -or $m.identity -notmatch '^NuwaxRecoveryQA[0-9a-f]{8}$'){throw 'Not a random synthetic product'}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent();$principal=[Security.Principal.WindowsPrincipal]::new($identity)
if($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'This fixture requires a standard token'}
$profile=[Environment]::GetFolderPath('UserProfile')
$env:USERPROFILE=$profile;$env:APPDATA=[Environment]::GetFolderPath('ApplicationData');$env:LOCALAPPDATA=[Environment]::GetFolderPath('LocalApplicationData');$env:USERNAME=$identity.Name.Split('\')[-1];$env:TEMP=Join-Path $env:LOCALAPPDATA 'Temp';$env:TMP=$env:TEMP
[IO.Directory]::CreateDirectory($env:TEMP)|Out-Null
$installer=Join-Path $PackageRoot 'installers\RecoveryQA-Setup.exe'
if((Get-FileHash -LiteralPath $installer).Hash -ine $m.installerSha256){throw 'Wrong synthetic package bytes'}
$root=Join-Path $env:TEMP ('nuwax-standard-scope-'+[guid]::NewGuid().ToString('N'));[IO.Directory]::CreateDirectory($root)|Out-Null
[IO.File]::WriteAllText((Join-Path $root 'owner.txt'),$m.guid)
$install=Join-Path (Join-Path $env:LOCALAPPDATA 'Programs') $m.identity
$exe=Join-Path $install ($m.identity+'.exe');$uninstaller=Join-Path $install ('Uninstall '+$m.identity+'.exe')
$private='Software\'+$m.guid;$uninstallKey='Software\Microsoft\Windows\CurrentVersion\Uninstall\'+$m.guid
$machine=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryView]::Registry64)
$user=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64)
$cases=@();$pages=@()
function Check($ok,[string]$message){if(-not $ok){throw $message}}
function Machine-Path {$k=$machine.OpenSubKey($private);try{if($k){return [string]$k.GetValue('InstallLocation')};return ''}finally{if($k){$k.Dispose()}}}
Check ((Machine-Path) -ieq $MachineInstallDir) 'Matching machine fixture must already be installed'
$machineExe=Join-Path $MachineInstallDir ($m.identity+'.exe');$machineUninstaller=Join-Path $MachineInstallDir ('Uninstall '+$m.identity+'.exe')
$machineExeHash=(Get-FileHash -LiteralPath $machineExe).Hash;$machineUninstallerHash=(Get-FileHash -LiteralPath $machineUninstaller).Hash
function Check-Machine {
 Check ((Machine-Path) -ieq $MachineInstallDir) 'Selected per-user operation changed machine registration'
 Check ((Get-FileHash -LiteralPath $machineExe).Hash -eq $machineExeHash) 'Selected per-user operation changed machine payload'
 Check ((Get-FileHash -LiteralPath $machineUninstaller).Hash -eq $machineUninstallerHash) 'Selected per-user operation changed machine uninstaller'
}
function Check-Installed {
 Check ((Get-FileHash -LiteralPath $exe).Hash -ieq $m.executableSha256) 'Wrong per-user payload'
 Check ([IO.File]::Exists($uninstaller)) 'Missing per-user uninstaller'
 $k=$user.OpenSubKey($private);try{Check ($k -and $k.GetValue('InstallLocation') -ieq $install) 'Wrong selected per-user registration'}finally{if($k){$k.Dispose()}}
 Check-Machine
}
Add-Type -ReferencedAssemblies @([Uri].Assembly.Location,[Collections.Generic.HashSet[string]].Assembly.Location) -TypeDefinition @'
using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public class NuwaxStandardScopeUI {
 public delegate bool Walk(IntPtr h,IntPtr l);
 [DllImport("user32.dll")]static extern bool EnumWindows(Walk cb,IntPtr l);
 [DllImport("user32.dll")]static extern bool EnumChildWindows(IntPtr h,Walk cb,IntPtr l);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr h,StringBuilder b,int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr h,StringBuilder b,int n);
 [DllImport("user32.dll")]static extern int GetDlgCtrlID(IntPtr h);
 [DllImport("user32.dll")]static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 [DllImport("user32.dll")]static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 [DllImport("user32.dll")]static extern bool IsWindowEnabled(IntPtr h);
 [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr h);
 public class Item {public long Handle;public int Id;public string Text,Class;public long Checked;public bool Enabled,Visible;}
 public static Item[] Read(int target) {
  var list=new List<Item>();Walk capture=(h,l)=>{uint p;GetWindowThreadProcessId(h,out p);if(p!=(uint)target)return true;var b=new StringBuilder(4096);GetWindowText(h,b,b.Capacity);var c=new StringBuilder(128);GetClassName(h,c,c.Capacity);list.Add(new Item{Handle=h.ToInt64(),Id=GetDlgCtrlID(h),Text=b.ToString(),Class=c.ToString(),Checked=c.ToString()=="Button"?SendMessage(h,0xf0,IntPtr.Zero,IntPtr.Zero).ToInt64():-1,Enabled=IsWindowEnabled(h),Visible=IsWindowVisible(h)});return true;};
  EnumWindows((h,l)=>{uint p;GetWindowThreadProcessId(h,out p);if(p==(uint)target){capture(h,l);EnumChildWindows(h,capture,IntPtr.Zero);}return true;},IntPtr.Zero);return list.ToArray();
 }
 // A page may replace its button between enumeration and dispatch. Never act
 // on a recycled/hidden handle; the caller refreshes the owned page instead.
 public static bool TryClick(long handle,int target){var h=new IntPtr(handle);uint p;GetWindowThreadProcessId(h,out p);if(p!=(uint)target||!IsWindowVisible(h)||!IsWindowEnabled(h))return false;return PostMessage(h,0xf5,IntPtr.Zero,IntPtr.Zero);}
}
'@
Add-Type -ReferencedAssemblies @([Uri].Assembly.Location) -TypeDefinition 'namespace ScopeQAExit { public static class Native { [System.Runtime.InteropServices.DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetExitCodeProcess(System.IntPtr p,out uint code); } }'
function Exit-Code($p,$handle) {[uint32]$exit=259;Check ([ScopeQAExit.Native]::GetExitCodeProcess($handle,[ref]$exit)) 'Native exit query failed';return $exit}
function Run-Silent([string]$flags) {
 $p=Start-Process $installer -ArgumentList ('/S /currentuser '+$flags+' /D='+$install) -PassThru;$h=$p.Handle
 Check ($p.WaitForExit(120000)) ('Own scope fixture timeout: '+$p.Id)
 $exit=Exit-Code $p $h;$p.Dispose();return $exit
}
try {
 foreach($keyName in @($private,$uninstallKey)){$k=$user.OpenSubKey($keyName);if($k){$k.Dispose();throw 'Refusing existing per-user fixture'}}
 Check (-not [IO.Directory]::Exists($install)) 'Refusing existing per-user target'
 $p=Start-Process $installer -ArgumentList ('/currentuser /D='+$install) -PassThru;$h=$p.Handle
 try {
  $last='';$clickedAt=[DateTime]::MinValue
  for($i=0;$i -lt 180;$i++) {
   Start-Sleep -Milliseconds 400;if($p.HasExited){break}
   $controls=@([NuwaxStandardScopeUI]::Read($p.Id));$key=($controls|ForEach-Object {$_.Id.ToString()+':'+$_.Text}) -join '|'
   if($key -ne $last){$pages+=@{step=$i;controls=$controls};$last=$key;$clickedAt=[DateTime]::MinValue}
   $maintenance=@($controls|Where-Object {$_.Class -eq 'Button' -and $_.Visible -and $_.Text -like '修复或升级*'})
   Check (-not $maintenance.Count) 'Other-scope installation incorrectly opened selected-scope maintenance'
   $next=@($controls|Where-Object {$_.Id -eq 1 -and $_.Class -eq 'Button' -and $_.Visible -and $_.Enabled -and $_.Text -match '下一步|Next|安装|Install|完成|Finish'})
   if($next.Count -and ([DateTime]::Now-$clickedAt).TotalMilliseconds -gt 1800){if([NuwaxStandardScopeUI]::TryClick($next[0].Handle,$p.Id)){$clickedAt=[DateTime]::Now}}
  }
  Check ($p.WaitForExit(10000)) 'Own interactive scope fixture did not exit'
  Check ((Exit-Code $p $h) -eq 0) 'Interactive standard-user setup failed or requested elevation'
 } finally {if(-not $p.HasExited){$cancel=@([NuwaxStandardScopeUI]::Read($p.Id)|Where-Object {$_.Id -eq 2 -and $_.Class -eq 'Button'});if($cancel.Count){[NuwaxStandardScopeUI]::TryClick($cancel[0].Handle,$p.Id)|Out-Null}};$p.Dispose()}
 Check-Installed
 $cases+=@{case='interactive-fresh-current-user-with-machine-copy';passed=$true}
 [IO.Directory]::CreateDirectory((Join-Path $install 'workspace'))|Out-Null;[IO.File]::WriteAllText((Join-Path $install 'workspace\keep.txt'),$m.guid)
 Check ((Run-Silent '') -eq 0) 'Silent current-user repair requested elevation or failed'
 Check-Installed
 Check ([IO.File]::ReadAllText((Join-Path $install 'workspace\keep.txt')) -eq $m.guid) 'Repair lost unknown workspace'
 $cases+=@{case='silent-current-user-repair-without-elevation';passed=$true}
 Check ((Run-Silent '/UNINSTALL') -eq 0) 'Selected per-user repair/uninstall requested elevation or failed'
 Check (-not [IO.File]::Exists($exe) -and -not [IO.File]::Exists($uninstaller)) 'Per-user program remains after uninstall'
 Check ([IO.File]::ReadAllText((Join-Path $install 'workspace\keep.txt')) -eq $m.guid) 'Default uninstall lost workspace'
 Check-Machine
 $cases+=@{case='current-user-uninstall-keeps-machine-copy';passed=$true}
 $r=@{passed=$true;cases=$cases;standardUser=$true;session=[Diagnostics.Process]::GetCurrentProcess().SessionId;syntheticPayload=$true;fixtureRoot=$root;machineInstallationUnchanged=$true;productionInstallationTouched=$false}
 [IO.File]::WriteAllText($OutputPath,($r|ConvertTo-Json -Depth 5));$r|ConvertTo-Json -Depth 5
} catch {
 [IO.File]::WriteAllText($OutputPath,(@{passed=$false;cases=$cases;error=$_.Exception.Message;standardUser=$true;fixtureRoot=$root;productionInstallationTouched=$false}|ConvertTo-Json -Depth 5));throw
} finally {$user.Dispose();$machine.Dispose();[IO.File]::WriteAllText((Join-Path $root 'pages.json'),(ConvertTo-Json -InputObject @($pages) -Depth 8))}
