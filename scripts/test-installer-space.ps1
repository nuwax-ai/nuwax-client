param([string]$SpaceScript = (Join-Path $PSScriptRoot '../nuwa-electron-shell/crates/agent-electron-client/build/installer-space.ps1'))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Native Windows is required.' }
. $SpaceScript -FunctionsOnly
$cases = [Collections.Generic.List[string]]::new()
function Check($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Request([string]$Path, [long]$Bytes) { [pscustomobject]@{ Path = $Path; Bytes = $Bytes; Role = 'fixture' } }
$same = { param($p) [pscustomobject]@{ Id = 'volume-one'; Display = 'C:\'; Available = [long](20GB) } }
$result = @(Get-InstallSpaceBudget @((Request 'C:\app' 3GB), (Request 'C:\temp' 1GB), (Request 'C:\cache' 1GB)) $same)
Check ($result.Count -eq 1 -and $result[0].Required -eq (5GB + 256MB)) 'Same-volume requests must sum before margin.'
$cases.Add('same-volume-sum-and-margin')
$split = { param($p) [pscustomobject]@{ Id = $p.Substring(0,1); Display = $p.Substring(0,3); Available = [long](20GB) } }
$result = @(Get-InstallSpaceBudget @((Request 'D:\app' 3GB), (Request 'C:\temp' 1GB), (Request 'C:\cache' 1GB)) $split)
Check ($result.Count -eq 2 -and ($result | Where-Object Volume -eq 'C:\').Required -eq (2GB + 256MB)) 'Temp and cache on C must be checked even when installing on D.'
$cases.Add('different-volume-temp-cache')
$boundary = { param($p) [pscustomobject]@{ Id = 'v'; Display = 'C:\'; Available = [long](1GB + 256MB) } }
$result = @(Get-InstallSpaceBudget @((Request 'C:\app' 1GB)) $boundary)
Check ($result[0].Shortfall -eq 0) 'Exact free-space boundary should pass.'
$oneShort = { param($p) [pscustomobject]@{ Id = 'v'; Display = 'C:\'; Available = [long](1GB + 256MB - 1) } }
$result = @(Get-InstallSpaceBudget @((Request 'C:\app' 1GB)) $oneShort)
Check ($result[0].Shortfall -eq 1) 'One-byte deficit must fail.'
Check ((Format-InstallSpaceBudget $result) -match '0[.,]01 GiB') 'A positive deficit must not be displayed as zero.'
$cases.Add('exact-boundary-and-one-byte-short')
$result = @(Get-InstallSpaceBudget @((Request 'C:\app' 9GB), (Request 'C:\temp' 2GB), (Request 'C:\cache' 2GB)) $same)
Check ($result[0].Required -eq ([long](13GB) + [long][Math]::Ceiling([decimal](13GB)/20))) 'Budget must not overflow at 2/4 GiB.'
$cases.Add('64-bit-budget')
$failed = $false
try { Get-InstallSpaceBudget @((Request 'C:\app' 1GB)) { throw 'fixture query failure' } } catch { $failed = $true }
Check $failed 'Volume query failures must not pass.'
$failed = $false
try { Get-InstallSpaceBudget @((Request 'C:\app' ([long]::MaxValue))) $same } catch { $failed = $true }
Check $failed 'Overflow must fail closed.'
$cases.Add('query-failure-and-overflow')
$root = Join-Path ([IO.Path]::GetTempPath()) ('nuwax-space-test-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
try {
  $v = Get-InstallSpaceVolume (Join-Path $root 'not-created\app')
  Check ($v.Id.StartsWith('\\?\Volume{') -and $v.Available -gt 0) 'Actual native volume lookup failed.'
  Check (-not [IO.Directory]::Exists((Join-Path $root 'not-created'))) 'Preflight must not create the target directory.'
  $cases.Add('actual-volume-and-nonexistent-target')
  $exe = Join-Path $root 'installer.exe'; [IO.File]::WriteAllBytes($exe, [byte[]](1,2,3))
  $ps = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $report = Join-Path $root 'report.txt'
  & $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $SpaceScript -InstallDir (Join-Path $root 'app') -TempPath $root -CachePath (Join-Path $root 'cache\installer.exe') -InstallerPath $exe -UnpackedSizeKB 1 -ReportPath $report | Out-Host
  Check ($LASTEXITCODE -eq 0 -and [IO.File]::ReadAllText($report).Contains('GiB')) 'Real helper entry should pass a tiny payload.'
  $cases.Add('native-entry-success')
  & $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $SpaceScript -InstallDir (Join-Path $root 'app') -TempPath $root -CachePath (Join-Path $root 'cache\installer.exe') -InstallerPath $exe -UnpackedSizeKB 900000000000 -ReportPath $report | Out-Host
  Check ($LASTEXITCODE -eq 112 -and [IO.File]::ReadAllText($report).Contains('GiB')) 'Real helper must reject insufficient space.'
  Check (-not [IO.Directory]::Exists((Join-Path $root 'app'))) 'Failure must not create installed payload.'
  $cases.Add('native-entry-insufficient')
  & $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $SpaceScript -InstallDir 'Z:\unavailable\app' -TempPath $root -CachePath (Join-Path $root 'cache\installer.exe') -InstallerPath $exe -UnpackedSizeKB 1 -ReportPath $report | Out-Host
  Check ($LASTEXITCODE -eq 2) 'Unavailable path must return query failure, not success or disk-full.'
  $cases.Add('native-entry-unavailable-drive')
  # Recheck all writable roles without creating the target. This also exercises
  # a non-ASCII user-chosen path on Windows PowerShell 5.1.
  $custom=Join-Path $root ('custom ' + [char]0x6d4b + [char]0x8bd5 + '\app')
  Assert-InstallWriteAccess $custom 'fixture'
  Check (-not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($custom))) 'Write probe created the installation directory.'
  Check (@(Get-ChildItem $root -Filter 'nuwax-write-probe-*').Count -eq 0) 'Write probe was retained.'
  $cases.Add('native-write-probe-unicode-cleanup')
  $outside=Join-Path $root 'outside';[IO.Directory]::CreateDirectory($outside)|Out-Null
  $sentinel=Join-Path $outside 'sentinel.txt';[IO.File]::WriteAllText($sentinel,'keep')
  $link=Join-Path $root 'redirected'
  New-Item -ItemType Junction -Path $link -Target $outside|Out-Null
  try {
    $failed=$false;try { Assert-InstallWriteAccess (Join-Path $link 'app') 'fixture' } catch { $failed=$true }
    Check $failed 'Redirected path accepted for a write probe.'
    Check ([IO.File]::ReadAllText($sentinel) -eq 'keep' -and @(Get-ChildItem $outside).Count -eq 1) 'Probe touched redirected destination.'
  }finally{[IO.Directory]::Delete($link)}
  $cases.Add('native-write-probe-refuses-redirect')
  $denied=Join-Path $root 'denied';[IO.Directory]::CreateDirectory($denied)|Out-Null
  $acl=[IO.Directory]::GetAccessControl($denied)
  $rule=New-Object Security.AccessControl.FileSystemAccessRule ([Security.Principal.WindowsIdentity]::GetCurrent().User),([Security.AccessControl.FileSystemRights]::CreateFiles -bor [Security.AccessControl.FileSystemRights]::CreateDirectories),([Security.AccessControl.AccessControlType]::Deny)
  $acl.AddAccessRule($rule);[IO.Directory]::SetAccessControl($denied,$acl)
  try {
    foreach($role in @('install','temp','cache')) {
      $install=Join-Path $root 'app';$temp=$root;$cache=Join-Path $root 'cache\installer.exe'
      if($role -eq 'install'){$install=Join-Path $denied 'app'}
      if($role -eq 'temp'){$temp=$denied}
      if($role -eq 'cache'){$cache=Join-Path $denied 'installer.exe'}
      & $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $SpaceScript -InstallDir $install -TempPath $temp -CachePath $cache -InstallerPath $exe -UnpackedSizeKB 1 -ReportPath $report | Out-Host
      Check ($LASTEXITCODE -eq 2 -and [IO.File]::ReadAllText($report).Contains($denied)) ('Write denial was not reported before installation: '+$role)
      Check (-not [IO.Directory]::Exists($install)) 'Failed preflight created the installation directory.'
      $cases.Add('native-write-denial-'+$role)
    }
  } finally {
    $acl=[IO.Directory]::GetAccessControl($denied);$acl.RemoveAccessRuleSpecific($rule);[IO.Directory]::SetAccessControl($denied,$acl)
  }
  $cases | ForEach-Object { Write-Output ('PASS ' + $_) }
  Write-Output ('SPACE_FIXTURES_OK ' + $cases.Count)
  # Expected failed child probes must not become the CI shell's final status.
  $global:LASTEXITCODE = 0
} finally { [IO.Directory]::Delete($root, $true) }
