param([string]$InstallDir, [string]$InstallerPath, [string]$OutputPath)
$ErrorActionPreference = 'Stop'

# Read-only maintenance diagnostics. No ACL, registry, program or business-data
# writes; the only created file is a new JSON report chosen by the caller.
$report = [ordered]@{ schemaVersion=1; kind='Nuwax installer permission diagnostics'; atUtc=[DateTime]::UtcNow.ToString('o') }
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$report.elevated=[Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$report.languageMode=$ExecutionContext.SessionState.LanguageMode.ToString()
$report.os=[Environment]::OSVersion.VersionString
$cv=Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$report.windows=@{displayVersion=$cv.DisplayVersion;build=$cv.CurrentBuildNumber;ubr=$cv.UBR}
try {
 Add-Type -ReferencedAssemblies @([Uri].Assembly.Location) -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class NuwaxPermissionDiagnostics {
 [DllImport("kernel32.dll",EntryPoint="CreateFileW",CharSet=CharSet.Unicode,SetLastError=true)]
 static extern SafeFileHandle Open(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
 [DllImport("shell32.dll")]
 static extern int SHGetKnownFolderPath([MarshalAs(UnmanagedType.LPStruct)]Guid id,uint flags,IntPtr token,out IntPtr result);
 public static int Probe(string path,uint access,bool directory){
  using(SafeFileHandle h=Open(path,access,7,IntPtr.Zero,3,directory?0x02200000u:0x00200000u,IntPtr.Zero)){
   return h.IsInvalid?Marshal.GetLastWin32Error():0;
  }
 }
 public static string UserPrograms(){
  IntPtr p=IntPtr.Zero;
  try {
   int result=SHGetKnownFolderPath(new Guid("5CD7AEE2-2219-4A67-B85D-6C9CE15660CB"),0x4000,IntPtr.Zero,out p);
   if(result!=0)Marshal.ThrowExceptionForHR(result);
   return Marshal.PtrToStringUni(p);
  } finally {if(p!=IntPtr.Zero)Marshal.FreeCoTaskMem(p);}
 }
}
'@
 $report.nativeProbesAvailable=$true
} catch { $report.nativeProbesAvailable=$false;$report.nativeProbeError=$_.Exception.Message }

function Local-Path([string]$value){
 if($value -notmatch '^[A-Za-z]:[\\/]' -or $value -match '[\x00-\x1f]'){throw 'Only absolute local paths are inspected'}
 return [IO.Path]::GetFullPath($value)
}
function Redirected-Ancestor([string]$path){
 $ancestors=[Collections.Generic.List[string]]::new()
 for($p=$path;$p;$p=[IO.Path]::GetDirectoryName($p)){$ancestors.Add($p)}
 for($i=$ancestors.Count-1;$i -ge 0;$i--){
  try{$a=[IO.File]::GetAttributes($ancestors[$i])}catch [IO.FileNotFoundException]{return $null}catch [IO.DirectoryNotFoundException]{return $null}
  if($a -band [IO.FileAttributes]::ReparsePoint){return $ancestors[$i]}
 }
 return $null
}
function Access-Result([string]$path,[uint32]$access,[bool]$directory){
 if(!$report.nativeProbesAvailable){return @{supported=$false}}
 $code=[NuwaxPermissionDiagnostics]::Probe($path,$access,$directory)
 return @{supported=$true;granted=($code -eq 0);nativeError=$code}
}
function Inspect-Path([string]$value){
 $result=[ordered]@{requested=$value}
 try{
  $path=Local-Path $value;$result.path=$path
  $redirect=Redirected-Ancestor $path
  if($redirect){$result.redirectedAncestor=$redirect;return $result}
  $result.exists=[IO.Directory]::Exists($path)
  $parent=$path
  while(![IO.Directory]::Exists($parent)){$parent=[IO.Path]::GetDirectoryName($parent);if(!$parent){throw 'No accessible existing parent'}}
  $result.existingParent=$parent
  $result.createFiles=Access-Result $parent 2 $true
  $result.createDirectories=Access-Result $parent 4 $true
  $result.deleteChildren=Access-Result $parent 64 $true
  $acl=Get-Acl -LiteralPath $parent
  $result.owner=$acl.Owner
  $result.access=@($acl.Access|Select-Object IdentityReference,FileSystemRights,AccessControlType,IsInherited)
  $license=Join-Path $path 'LICENSE.electron.txt'
  if([IO.File]::Exists($license)){
   $a=[IO.File]::GetAttributes($license)
   $result.license=@{path=$license;attributes=$a.ToString();readOnly=[bool]($a -band [IO.FileAttributes]::ReadOnly);delete=Access-Result $license 65536 $false;writeAttributes=Access-Result $license 256 $false}
  }
 }catch{$result.error=$_.Exception.Message}
 return $result
}

$registrations=@()
foreach($scope in @('CurrentUser','LocalMachine')){foreach($view in @('Registry64','Registry32')){
 $base=$null;$uninstall=$null
 try{
  $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$scope,[Microsoft.Win32.RegistryView]::$view)
  $uninstall=$base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall',$false)
  if(!$uninstall){continue}
  foreach($name in $uninstall.GetSubKeyNames()){
   $key=$null;$private=$null
   try{
    $key=$uninstall.OpenSubKey($name,$false)
    if(!$key -or [string]$key.GetValue('DisplayName') -notmatch '^(?:\u5973\u5a32|\u5973\u5aa7)?Nuwax(?:\s|$)'){continue}
    $private=$base.OpenSubKey('Software\'+$name,$false)
    $registrations+=@{scope=$scope;view=$view;key=$name;displayName=$key.GetValue('DisplayName');version=$key.GetValue('DisplayVersion');installLocation=$key.GetValue('InstallLocation');privateInstallLocation=$(if($private){$private.GetValue('InstallLocation')});uninstallString=$key.GetValue('UninstallString')}
   }finally{if($private){$private.Dispose()};if($key){$key.Dispose()}}
  }
 }catch{$registrations+=@{scope=$scope;view=$view;error=$_.Exception.Message}}finally{if($uninstall){$uninstall.Dispose()};if($base){$base.Dispose()}}
}}
$report.registrations=$registrations
$candidates=@()
if($InstallDir){$candidates+=@($InstallDir)}
$candidates+=@(Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\Nuwax')
if($report.nativeProbesAvailable){try{$report.userPrograms=[NuwaxPermissionDiagnostics]::UserPrograms();$candidates+=@(Join-Path $report.userPrograms 'Nuwax')}catch{$report.userProgramsError=$_.Exception.Message}}
foreach($r in $registrations){foreach($path in @($r.installLocation,$r.privateInstallLocation)){if($path){$candidates+=@([string]$path)}}}
$report.paths=@($candidates|Select-Object -Unique|ForEach-Object {Inspect-Path $_})
if($InstallerPath){
 try{
  $file=Local-Path $InstallerPath
  if([IO.Path]::GetFileName($file) -notmatch '^Nuwax.*\.exe$'){throw 'Expected a Nuwax installer EXE'}
  if(Redirected-Ancestor $file){throw 'Installer path is redirected'}
  $signature=Get-AuthenticodeSignature -LiteralPath $file
  $report.installer=@{path=$file;sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLower();signature=$signature.Status.ToString();signatureMessage=$signature.StatusMessage;signer=$(if($signature.SignerCertificate){$signature.SignerCertificate.Thumbprint});timestampPresent=[bool]$signature.TimeStamperCertificate}
 }catch{$report.installer=@{error=$_.Exception.Message}}
}
$logs=@{}
foreach($name in @('Nuwax-installer-lifecycle.log','Nuwax-installer-recovery.log','Nuwax-installer-space.log','Nuwax-uninstall-events.jsonl')){
 $reader=$null
 try{
  $file=Join-Path ([IO.Path]::GetTempPath()) $name
  if(![IO.File]::Exists($file)){continue}
  if(Redirected-Ancestor $file){$logs[$name]=@('Redirected log skipped');continue}
  $encoding=if($name -match 'lifecycle|space'){[Text.Encoding]::Unicode}elseif($name.EndsWith('.jsonl')){[Text.Encoding]::UTF8}else{[Text.Encoding]::Default}
  $stream=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
  $reader=[IO.StreamReader]::new($stream,$encoding,$true)
  $tail=[Collections.Generic.Queue[string]]::new()
  while(!$reader.EndOfStream){$line=$reader.ReadLine();if($line.Length -gt 2000){$line=$line.Substring(0,2000)};$tail.Enqueue($line);if($tail.Count -gt 30){$null=$tail.Dequeue()}}
  $logs[$name]=$tail.ToArray()
 }catch{$logs[$name]=@($_.Exception.Message)}finally{if($reader){$reader.Dispose()}}
}
$report.maintenanceLogs=$logs
if(!$OutputPath){$OutputPath=Join-Path ([IO.Path]::GetTempPath()) ('Nuwax-installer-diagnostics-'+[guid]::NewGuid().ToString('N')+'.json')}
$OutputPath=Local-Path $OutputPath
if(Redirected-Ancestor $OutputPath){throw 'Output path is redirected'}
$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($report|ConvertTo-Json -Depth 9))
$output=[IO.File]::Open($OutputPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
try{$output.Write($bytes,0,$bytes.Length)}finally{$output.Dispose()}
Write-Output $OutputPath
