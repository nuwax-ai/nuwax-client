# Compile old tag installer sources with the same random QA identity and a
# synthetic payload. This checks old installer compatibility, not old releases.
param([Parameter(Mandatory = $true)][string]$PackageRoot,
  [Parameter(Mandatory = $true)][string[]]$LegacyPackageRoots)
$ErrorActionPreference = 'Stop'
function Assert($value, [string]$message) { if (-not $value) { throw $message } }
function Meta([string]$directory) {
  $m = [IO.File]::ReadAllText((Join-Path $directory 'qa-meta.json')) | ConvertFrom-Json
  Assert ($m.kind -eq 'Synthetic Nuwax installer recovery QA' -and $m.syntheticPayload -and $m.nativeWindows -and
    $m.guid -match '^[0-9a-f-]{36}$' -and $m.identity -match '^NuwaxRecoveryQA[0-9a-f]{8}$') 'Invalid QA package identity'
  $file = Join-Path $directory 'installers\RecoveryQA-Setup.exe'
  Assert ((Get-FileHash -LiteralPath $file).Hash -ieq $m.installerSha256) 'Package hash mismatch'
  return $m
}
$current = Meta $PackageRoot
$root = Join-Path ([IO.Path]::GetTempPath()) ('nuwax-legacy-upgrade-fixture-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
[IO.File]::WriteAllText((Join-Path $root 'owner.txt'), $current.guid)
$privateKey = 'Software\' + $current.guid
$uninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $current.guid
$hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
$cases = @()
function Run([string]$package, [string]$directory, [string]$flags = '') {
  $p = Start-Process -FilePath (Join-Path $package 'installers\RecoveryQA-Setup.exe') -ArgumentList ('/S /currentuser ' + $flags + ' /D=' + $directory) -PassThru
  Assert ($p.WaitForExit(120000)) ('Own QA package did not finish: PID ' + $p.Id)
  return $p.ExitCode
}
try {
  foreach ($legacyRoot in $LegacyPackageRoots) {
    $old = Meta $legacyRoot
    Assert ($old.guid -eq $current.guid -and $old.version -match '^3\.0\.(16|19)-qa\.recovery\.\d+$') 'Unexpected old QA source identity'
    $machine = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
    try {
      $key = $machine.OpenSubKey($uninstallKey)
      if ($key) { $key.Dispose(); throw 'Refusing a concurrently installed all-users QA identity' }
    } finally { $machine.Dispose() }
    foreach ($name in @($privateKey, $uninstallKey)) {
      $key = $hive.OpenSubKey($name)
      if ($key) { $key.Dispose(); throw 'Refusing an already registered QA identity' }
    }
    $install = Join-Path (Join-Path $root $old.version) $current.identity
    [IO.Directory]::CreateDirectory($install) | Out-Null
    # 3.0.16 needs its old scope hint. 3.0.19 treats an empty hinted directory
    # as broken, so let its original first-install logic choose the location.
    if ($old.version -like '3.0.16-*') {
      $key = $hive.CreateSubKey($privateKey)
      try { $key.SetValue('InstallLocation', $install) } finally { $key.Dispose() }
    }
    Assert ((Run $legacyRoot $install) -eq 0) ('Old source installation failed: ' + $old.version)
    $key = $hive.OpenSubKey($privateKey)
    try { $actual = [string]$key.GetValue('InstallLocation') } finally { if ($key) { $key.Dispose() } }
    $default = Join-Path (Join-Path $env:LOCALAPPDATA 'Programs') $current.identity
    Assert ($actual -ieq $install -or $actual -ieq $default) 'Old installer selected an unexpected QA path'
    $install = $actual
    $exe = Join-Path $install ($current.identity + '.exe')
    Assert ((Get-FileHash -LiteralPath $exe).Hash -ieq $old.executableSha256) 'Old source did not install its own payload'
    $sentinels = @('workspace\keep.txt', 'resources\user-added.txt')
    foreach ($relative in $sentinels) {
      $file = Join-Path $install $relative
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file)) | Out-Null
      [IO.File]::WriteAllText($file, $current.guid)
    }
    Assert ((Run $PackageRoot $install '--updated') -eq 0) ('Upgrade failed: ' + $old.version)
    Assert ((Get-FileHash -LiteralPath $exe).Hash -ieq $current.executableSha256) 'Upgrade did not install the complete new payload'
    $key = $hive.OpenSubKey($uninstallKey)
    try { Assert ($key -and $key.GetValue('DisplayVersion') -eq $current.version) 'Upgrade registration version is wrong' }
    finally { if ($key) { $key.Dispose() } }
    foreach ($relative in $sentinels) { Assert ([IO.File]::ReadAllText((Join-Path $install $relative)) -eq $current.guid) 'Upgrade lost personal data' }
    Assert ((Run $PackageRoot $install '/UNINSTALL') -eq 0) 'New repaired uninstaller failed'
    Assert (-not [IO.File]::Exists($exe)) 'New payload remains'
    foreach ($relative in $sentinels) { Assert ([IO.File]::ReadAllText((Join-Path $install $relative)) -eq $current.guid) 'Uninstall lost personal data' }
    $key = $hive.OpenSubKey($uninstallKey)
    if ($key) { $key.Dispose(); throw 'Uninstall registration remains' }
    $cases += @{ version = $old.version; passed = $true; installerSha256 = $old.installerSha256; dataPreserved = $true; installDir = $install }
  }
  $report = @{ passed = $true; cases = $cases; fixtureRoot = $root; scope = 'CurrentUser';
    syntheticPayload = $true; signed = $false; productionInstallationTouched = $false } | ConvertTo-Json -Depth 5
  [IO.File]::WriteAllText((Join-Path $root 'result.json'), $report)
  $report
} catch {
  [IO.File]::WriteAllText((Join-Path $root 'result.json'), ((@{ passed = $false; cases = $cases; error = $_.Exception.Message } | ConvertTo-Json -Depth 5)))
  throw
} finally { $hive.Dispose() }
