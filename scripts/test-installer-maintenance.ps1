# Real NSIS package, random QA identity, synthetic payload only. The caller
# stages the package/meta/legacy-exit-2.exe into a new owned local directory.
param([Parameter(Mandatory = $true)][string]$PackageRoot,
  [ValidateSet('CurrentUser', 'AllUsers')][string]$Scope = 'CurrentUser')
$ErrorActionPreference = 'Stop'
$meta = [IO.File]::ReadAllText((Join-Path $PackageRoot 'qa-meta.json')) | ConvertFrom-Json
if ($meta.kind -ne 'Synthetic Nuwax installer recovery QA' -or -not $meta.syntheticPayload -or -not $meta.nativeWindows -or
    $meta.guid -notmatch '^[0-9a-f-]{36}$' -or $meta.identity -notmatch '^NuwaxRecoveryQA[0-9a-f]{8}$') { throw 'Invalid QA identity' }
$installer = Join-Path $PackageRoot 'RecoveryQA-Setup.exe'
if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ine $meta.installerSha256) { throw 'Wrong QA package bytes' }
$root = Join-Path ([IO.Path]::GetTempPath()) ('nuwax-maintenance-fixture-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
[IO.File]::WriteAllText((Join-Path $root 'owner.txt'), $meta.guid)
$install = Join-Path (Join-Path $root 'custom installation with spaces') $meta.identity
$exe = Join-Path $install ($meta.identity + '.exe')
$uninstaller = Join-Path $install ('Uninstall ' + $meta.identity + '.exe')
$privateKey = 'Software\' + $meta.guid
$uninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $meta.guid
$hiveName = if ($Scope -eq 'AllUsers') { 'LocalMachine' } else { 'CurrentUser' }
if ($Scope -eq 'AllUsers') {
  $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'All-users QA requires an elevated test session' }
}
$hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$hiveName, [Microsoft.Win32.RegistryView]::Registry64)
foreach ($key in @($privateKey, $uninstallKey)) {
  $existing = $hive.OpenSubKey($key)
  if ($existing) { $existing.Dispose(); $hive.Dispose(); throw 'Refusing an already registered QA identity' }
}
function Assert($value, [string]$message) { if (-not $value) { throw $message } }
function Put([string]$file, [string]$content) {
  Assert ($file.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) 'Fixture path escaped'
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file)) | Out-Null
  [IO.File]::WriteAllText($file, $content)
}
function Run-Package([string]$flags = '', [switch]$ForwardSlashes, [string]$TargetOverride = '') {
  $scopeArgument = if ($Scope -eq 'AllUsers') { '/allusers' } else { '/currentuser' }
  Write-Output ('RUN_PACKAGE ' + $flags) | Out-Host
  $directory = if ($ForwardSlashes) { $install.Replace('\', '/') } else { $install }
  if ($TargetOverride) { $directory = $TargetOverride }
  $p = Start-Process -FilePath $installer -ArgumentList ('/S ' + $scopeArgument + ' ' + $flags + ' /D=' + $directory) -PassThru
  if (-not $p.WaitForExit(120000)) { throw ('Own QA installer is still active: PID ' + $p.Id) }
  return $p.ExitCode
}
function Assert-Installed {
  Assert ([IO.File]::Exists($uninstaller)) 'QA uninstall entry is missing'
  Assert ((Get-FileHash -LiteralPath $exe).Hash -ieq $meta.executableSha256) 'Complete new payload was not installed'
  $key = $hive.OpenSubKey($privateKey)
  try { Assert ($key -and $key.GetValue('InstallLocation') -eq $install) 'Private install path is wrong' }
  finally { if ($key) { $key.Dispose() } }
}
function Marker {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($install.ToUpperInvariant())), 0, 12).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
  return Join-Path ([IO.Path]::GetDirectoryName($install)) ('Nuwax-installer-recovery-active-' + $hash + '.txt')
}
$cases = @()
try {
  $scopeArgument = if ($Scope -eq 'AllUsers') { '/allusers' } else { '/currentuser' }
  $rejected = Start-Process -FilePath $installer -ArgumentList ('/S ' + $scopeArgument + ' /D=C:\') -PassThru
  Assert ($rejected.WaitForExit(30000) -and $rejected.ExitCode -ne 0) 'Volume-root installation was accepted'
  Assert (-not [IO.File]::Exists(('C:\' + $meta.identity + '.exe'))) 'Rejected root target wrote a QA executable'
  $cases += @{ case = 'volume-root-rejected'; passed = $true }
  Assert ((Run-Package) -eq 0) 'Fresh package installation failed'
  Assert-Installed
  $cases += @{ case = 'fresh-custom-directory'; passed = $true }
  $wrong = Join-Path $root 'unregistered relocation'
  Assert ((Run-Package -TargetOverride $wrong) -ne 0) 'Registered installation was silently relocated'
  Assert (-not [IO.File]::Exists((Join-Path $wrong ($meta.identity + '.exe')))) 'Rejected relocation wrote a payload'
  Assert-Installed
  $cases += @{ case = 'registered-directory-retained'; passed = $true }
  Assert ((Run-Package '' -ForwardSlashes) -eq 0) 'Forward-slash /D argument was truncated'
  Assert-Installed
  $cases += @{ case = 'forward-slash-directory'; passed = $true }
  Put "$install\workspace\keep.txt" 'personal data'
  Put "$install\resources\user-added.txt" 'resource-directory personal data'
  [IO.File]::Copy((Join-Path $PackageRoot 'legacy-exit-2.exe'), $uninstaller, $true)
  Assert ((Run-Package) -eq 0) 'Broken legacy uninstaller blocked repair'
  Assert-Installed
  Assert ([IO.File]::ReadAllText("$install\workspace\keep.txt") -eq 'personal data') 'Legacy fallback lost workspace'
  $cases += @{ case = 'legacy-exit-2-fallback'; passed = $true }
  Put $uninstaller 'Not a Windows executable'
  Assert ((Run-Package) -eq 0) 'Unstartable legacy uninstaller blocked repair'
  Assert-Installed
  $cases += @{ case = 'legacy-start-failure-fallback'; passed = $true }
  [IO.File]::Delete($uninstaller)
  Assert ((Run-Package) -eq 0) 'Missing uninstaller blocked complete-package repair'
  Assert-Installed
  $cases += @{ case = 'missing-uninstaller-fallback'; passed = $true }
  [IO.File]::Delete($exe)
  [IO.File]::Delete($uninstaller)
  Assert ((Run-Package) -ne 0) 'Partial payload was adopted without explicit repair'
  Assert ((Run-Package '/REPAIR') -eq 0) 'Explicit repair did not recover a partial installation'
  Assert-Installed
  $cases += @{ case = 'partial-installation-repair'; passed = $true }
  $lost = Join-Path ([IO.Path]::GetDirectoryName($install)) ('Nuwax-installer-recovery-lost-' + [Guid]::NewGuid().ToString('N'))
  [IO.File]::WriteAllText((Marker), $lost)
  Assert ((Run-Package '--updated') -eq 0) 'Lost backup pointer blocked automatic upgrade protocol'
  Assert-Installed
  $cases += @{ case = 'lost-backup-pointer'; passed = $true }
  $orphan = Join-Path ([IO.Path]::GetDirectoryName($install)) ('Nuwax-installer-recovery-orphan-' + [Guid]::NewGuid().ToString('N'))
  Put "$orphan\unknown-backup.bin" 'unknown recovery bytes'
  [IO.File]::WriteAllText((Marker), $orphan)
  Assert ((Run-Package) -ne 0) 'Damaged backup was bypassed without explicit repair'
  Assert-Installed
  Assert ((Run-Package '/REPAIR') -eq 0) 'Explicit repair could not protect an orphan backup'
  Assert-Installed
  Assert ([IO.File]::ReadAllText("$orphan\unknown-backup.bin") -eq 'unknown recovery bytes') 'Explicit repair changed orphan backup'
  $cases += @{ case = 'protected-orphan-repair'; passed = $true }
  $other = Join-Path $root 'other candidate'
  foreach ($relative in @(($meta.identity + '.exe'), 'resources\app.asar', ('Uninstall ' + $meta.identity + '.exe'))) {
    $target = Join-Path $other $relative
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
    [IO.File]::Copy((Join-Path $install $relative), $target)
  }
  $key = $hive.OpenSubKey($privateKey, $true)
  try { $key.SetValue('InstallLocation', $other) } finally { $key.Dispose() }
  Assert ((Run-Package) -ne 0) 'Conflicting registration silently chose a path'
  Assert ((Run-Package '/REPAIR') -eq 0) 'Explicitly selected original directory was not repaired'
  Assert-Installed
  Assert ([IO.File]::Exists((Join-Path $other ($meta.identity + '.exe')))) 'Repair changed the other installation candidate'
  $cases += @{ case = 'explicit-conflict-target'; passed = $true }
  $runName = 'com.nuwax-ai.recoveryqa.' + $meta.guid
  $runKey = $hive.CreateSubKey('Software\Microsoft\Windows\CurrentVersion\Run')
  try { $runKey.SetValue($runName, ('"' + $exe + '" --hidden')) } finally { $runKey.Dispose() }
  $dataTargets = @((Join-Path $env:USERPROFILE ('.' + $meta.name)), (Join-Path $env:APPDATA $meta.identity), (Join-Path $env:LOCALAPPDATA ($meta.name + '-updater')))
  foreach ($target in $dataTargets) {
    [IO.Directory]::CreateDirectory($target) | Out-Null
    [IO.File]::WriteAllText((Join-Path $target 'recovery-qa-owned.txt'), $meta.guid)
  }
  Assert ((Run-Package '/UNINSTALL') -eq 0) 'Repair-then-uninstall failed'
  Assert (-not [IO.File]::Exists($exe)) 'Program payload remains after uninstall'
  Assert (-not [IO.File]::Exists($uninstaller)) 'Uninstaller remains after completed uninstall'
  $key = $hive.OpenSubKey($uninstallKey)
  Assert (-not $key) 'Uninstall registration remains'
  Assert ([IO.File]::ReadAllText("$install\workspace\keep.txt") -eq 'personal data') 'Default uninstall lost workspace'
  Assert ([IO.File]::ReadAllText("$install\resources\user-added.txt") -eq 'resource-directory personal data') 'Default uninstall lost nested unknown file'
  foreach ($target in $dataTargets) {
    Assert ([IO.File]::ReadAllText((Join-Path $target 'recovery-qa-owned.txt')) -eq $meta.guid) 'Default uninstall removed app-managed QA data'
  }
  $runKey = $hive.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run')
  try { Assert (-not $runKey.GetValue($runName)) 'Exact-target startup value remains after uninstall' } finally { $runKey.Dispose() }
  $cases += @{ case = 'repair-then-uninstall'; passed = $true }
  $report = [pscustomobject]@{ passed = $true; cases = $cases; fixtureRoot = $root; productIdentity = $meta.identity; scope = $Scope;
    signed = $meta.signed; syntheticPayload = $true; productionInstallationTouched = $false } | ConvertTo-Json -Depth 5
  [IO.File]::WriteAllText((Join-Path $root 'result.json'), $report)
  $report
} catch {
  [IO.File]::WriteAllText((Join-Path $root 'result.json'), ((@{ passed = $false; cases = $cases; scope = $Scope; error = $_.Exception.Message } | ConvertTo-Json -Depth 5)))
  throw
} finally { $hive.Dispose() }
