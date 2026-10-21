# Run only against a freshly generated, random synthetic product identity.
param([Parameter(Mandatory = $true)][string]$PackageRoot,
  [ValidateSet('CurrentUser', 'AllUsers')][string]$Scope = 'CurrentUser')
$ErrorActionPreference = 'Stop'
$m = Get-Content -LiteralPath (Join-Path $PackageRoot 'qa-meta.json') -Raw | ConvertFrom-Json
if ($m.kind -ne 'Synthetic Nuwax installer recovery QA' -or -not $m.syntheticPayload -or -not $m.nativeWindows -or
    $m.guid -notmatch '^[0-9a-f-]{36}$' -or $m.identity -notmatch '^NuwaxRecoveryQA[0-9a-f]{8}$') { throw 'Invalid synthetic identity' }
$installer = Join-Path $PackageRoot 'installers\RecoveryQA-Setup.exe'
if ((Get-FileHash -LiteralPath $installer).Hash -ine $m.installerSha256) { throw 'Changed synthetic package' }
$keys = @(('Software\' + $m.guid), ('Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $m.guid))
$scopeName = if ($Scope -eq 'AllUsers') { 'LocalMachine' } else { 'CurrentUser' }
$scopeFlag = if ($Scope -eq 'AllUsers') { '/allusers' } else { '/currentuser' }
$otherFlag = if ($Scope -eq 'AllUsers') { '/currentuser' } else { '/allusers' }
$root = Join-Path $env:TEMP ('nuwax-pending-fixture-' + [guid]::NewGuid().ToString('N'))
$install = Join-Path (Join-Path $root 'custom path with spaces') $m.identity
$workspace = Join-Path $install 'workspace\owner.txt'
$uninstaller = Join-Path $install ('Uninstall ' + $m.identity + '.exe')
$exe = Join-Path $install ($m.identity + '.exe')
$state = Join-Path $root 'prepared.txt'
$helper = Join-Path $PackageRoot 'build\normalize-old-install.ps1'
$cases = @()
function Assert($value, [string]$message) { if (-not $value) { throw $message } }
function Open-Hive([string]$name, $view = [Microsoft.Win32.RegistryView]::Registry64) {
  return [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$name, $view)
}
foreach ($name in @('CurrentUser', 'LocalMachine')) {
  foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
    $hive = Open-Hive $name $view
    try { foreach ($keyName in $keys) { $key = $hive.OpenSubKey($keyName); if ($key) { $key.Dispose(); throw 'Refusing existing QA registration' } } }
    finally { $hive.Dispose() }
  }
}
[IO.Directory]::CreateDirectory($root) | Out-Null
[IO.File]::WriteAllText((Join-Path $root 'owner.txt'), $m.guid)
function Run([string]$flags) {
  $p = Start-Process $installer -ArgumentList ('/S ' + $flags + ' /D=' + $install) -PassThru
  Assert ($p.WaitForExit(120000)) ('Own installer timeout: ' + $p.Id)
  return $p.ExitCode
}
function Assert-Installed {
  Assert ([IO.File]::Exists($workspace) -and [IO.File]::ReadAllText($workspace) -eq $m.guid) 'Workspace not restored'
  Assert ((Get-FileHash -LiteralPath $exe).Hash -ieq $m.executableSha256) 'Incomplete program payload'
  Assert ([IO.File]::Exists($uninstaller)) 'Missing retry uninstaller'
  Assert (@(Get-ChildItem -LiteralPath ([IO.Path]::GetDirectoryName($install)) -Filter 'Nuwax-installer-recovery-active-*.txt').Count -eq 0) 'Unfinished recovery reported success'
  foreach ($name in @('CurrentUser', 'LocalMachine')) {
    $hive = Open-Hive $name
    try {
      $key = $hive.OpenSubKey($keys[0])
      try {
        if ($name -eq $scopeName) { Assert ($key -and $key.GetValue('InstallLocation') -eq $install) 'Wrong recovered scope/path' }
        else { Assert (-not $key) 'Recovery registered the other scope' }
      } finally { if ($key) { $key.Dispose() } }
    } finally { $hive.Dispose() }
  }
}
function Remove-Registration([int]$KeepIndex = -1) {
  foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
    $hive = Open-Hive $scopeName $view
    try { for ($i = 0; $i -lt $keys.Count; $i++) { if ($i -ne $KeepIndex) { $hive.DeleteSubKeyTree($keys[$i], $false) } } } finally { $hive.Dispose() }
  }
}
function Interrupt-AfterUninstall([int]$KeepIndex = -1) {
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helper -Action Prepare -InstallDir $install -StatePath $state -RegistryScope $scopeName -InstallRegistryKey $keys[0] -UninstallRegistryKey $keys[1] | Out-Host
  Assert ($LASTEXITCODE -eq 0) 'Own preservation failed'
  $script:backup = [IO.File]::ReadAllText($state).Trim()
  Assert (-not [IO.File]::Exists($workspace)) 'Fixture did not preserve workspace'
  [IO.File]::Delete($uninstaller)
  Remove-Registration -KeepIndex $KeepIndex
}
try {
  Assert ((Run $scopeFlag) -eq 0) 'Initial synthetic install failed'
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($workspace)) | Out-Null
  [IO.File]::WriteAllText($workspace, $m.guid)
  Remove-Registration
  Assert ((Run ($scopeFlag + ' --updated')) -eq 0) 'Update metadata repair lost the explicit original target'
  Assert-Installed
  $cases += 'unregistered-without-marker-update-metadata-repair'
  Interrupt-AfterUninstall
  $manifest = Join-Path $backup 'manifest.jsonl'
  $manifestBytes = [IO.File]::ReadAllBytes($manifest)
  [IO.File]::WriteAllText($manifest, '{corrupt')
  Assert ((Run ($scopeFlag + ' /REPAIR')) -eq 2) 'Unregistered corrupt recovery was adopted by explicit repair'
  Assert ([IO.File]::ReadAllText($manifest) -eq '{corrupt' -and -not [IO.File]::Exists($exe)) 'Rejected corrupt recovery changed files'
  [IO.File]::WriteAllBytes($manifest, $manifestBytes)
  $cases += 'unregistered-corrupt-manifest-preserved-even-with-repair'
  $hash = (Get-FileHash -LiteralPath $manifest).Hash
  Assert ((Run $otherFlag) -eq 2) 'Explicit wrong scope adopted pending recovery'
  Assert ((Get-FileHash -LiteralPath $manifest).Hash -eq $hash) 'Wrong-scope attempt mutated recovery'
  Assert (-not [IO.File]::Exists($exe)) 'Wrong-scope attempt wrote payload'
  $cases += 'explicit-wrong-scope-preserves-pending-state'
  Assert ((Run '') -eq 0) 'Full installer could not infer recorded scope'
  Assert-Installed
  $cases += 'unregistered-full-install-restores-original-scope-and-workspace'
  foreach ($flags in @('--updated', '/REPAIR', 'partial-payload', 'private-registration-remains', 'uninstall-registration-remains')) {
    $keep = if ($flags -eq 'private-registration-remains') { 0 } elseif ($flags -eq 'uninstall-registration-remains') { 1 } else { -1 }
    Interrupt-AfterUninstall -KeepIndex $keep
    $arguments = $flags
    if ($flags -eq 'partial-payload') {
      [IO.File]::Copy((Join-Path $PackageRoot ('app\' + $m.identity + '.exe')), $exe)
      $arguments = ''
    }
    if ($keep -ge 0) { $arguments = '' }
    Assert ((Run $arguments) -eq 0) ('Pending recovery failed: ' + $flags)
    Assert-Installed
    $cases += ('unregistered-retry-' + $flags.TrimStart([char[]]'-/'))
  }
  Interrupt-AfterUninstall
  Assert ((Run '/UNINSTALL') -eq 0) 'Unregistered repair-then-uninstall failed'
  Assert (-not [IO.File]::Exists($exe) -and -not [IO.File]::Exists($uninstaller)) 'Uninstall left program payload'
  Assert ([IO.File]::ReadAllText($workspace) -eq $m.guid) 'Repair-then-uninstall lost workspace'
  $hive = Open-Hive $scopeName
  try { $key = $hive.OpenSubKey($keys[1]); if ($key) { $key.Dispose(); throw 'Uninstall registration remains' } } finally { $hive.Dispose() }
  $cases += 'unregistered-repair-then-uninstall-preserves-workspace'
  $report = @{ passed = $true; cases = $cases; scope = $Scope; fixtureRoot = $root; syntheticPayload = $true; productionInstallationTouched = $false } | ConvertTo-Json -Depth 5
  [IO.File]::WriteAllText((Join-Path $root 'result.json'), $report)
  $report
} catch {
  [IO.File]::WriteAllText((Join-Path $root 'result.json'), (@{ passed = $false; cases = $cases; scope = $Scope; error = $_.Exception.Message } | ConvertTo-Json -Depth 5))
  throw
}
