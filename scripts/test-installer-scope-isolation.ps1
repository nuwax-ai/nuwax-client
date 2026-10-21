param([Parameter(Mandatory = $true)][string]$PackageRoot)
$ErrorActionPreference = 'Stop'
function Assert($value, [string]$message) { if (-not $value) { throw $message } }
$m = Get-Content (Join-Path $PackageRoot 'qa-meta.json') -Raw | ConvertFrom-Json
Assert ($m.kind -eq 'Synthetic Nuwax installer recovery QA' -and $m.syntheticPayload -and $m.nativeWindows -and
  $m.guid -match '^[0-9a-f-]{36}$' -and $m.identity -match '^NuwaxRecoveryQA[0-9a-f]{8}$') 'Invalid synthetic QA identity'
$installer = Join-Path $PackageRoot 'installers\RecoveryQA-Setup.exe'
Assert ((Get-FileHash -LiteralPath $installer).Hash -ieq $m.installerSha256) 'Wrong QA installer bytes'
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
Assert ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) 'Scope fixture requires an elevated session'
$root = Join-Path $env:TEMP ('nuwax-scope-fixture-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
[IO.File]::WriteAllText((Join-Path $root 'owner.txt'), $m.guid)
$userDir = Join-Path $root 'per-user installation'
$machineDir = Join-Path $root 'all-users installation'
$privateKey = 'Software\' + $m.guid
$uninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $m.guid
$user = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
$machine = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
$cases = @()
function Run([string]$scope, [string]$directory, [string]$flags = '') {
  Write-Output ('SCOPE_PACKAGE ' + $scope + ' ' + $flags) | Out-Host
  $arguments = '/S'
  if ($scope) { $arguments += ' /' + $scope }
  $arguments += ' ' + $flags
  if ($directory) { $arguments += ' /D=' + $directory }
  $p = Start-Process $installer -ArgumentList $arguments -PassThru
  Assert ($p.WaitForExit(120000)) ('Own QA installer timeout: PID ' + $p.Id)
  return $p.ExitCode
}
function Read-Path($base) {
  $key = $base.OpenSubKey($privateKey)
  try { if ($key) { return [string]$key.GetValue('InstallLocation') }; return '' } finally { if ($key) { $key.Dispose() } }
}
function User-Paths([string]$directory) {
  $key = $user.OpenSubKey($privateKey, $true)
  try { $key.SetValue('InstallLocation', $directory) } finally { $key.Dispose() }
  $key = $user.OpenSubKey($uninstallKey, $true)
  try {
    $key.SetValue('InstallLocation', $directory)
    $key.SetValue('UninstallString', ('"' + $directory + '\Uninstall ' + $m.identity + '.exe" /currentuser'))
    $key.SetValue('QuietUninstallString', ('"' + $directory + '\Uninstall ' + $m.identity + '.exe" /currentuser /S'))
  } finally { $key.Dispose() }
}
try {
  foreach ($base in @($user, $machine)) {
    foreach ($name in @($privateKey, $uninstallKey)) { $key = $base.OpenSubKey($name); if ($key) { $key.Dispose(); throw 'Refusing an existing QA identity' } }
  }
  Assert ((Run 'currentuser' $userDir) -eq 0) 'Initial per-user QA installation failed'
  $userExe = Join-Path $userDir ($m.identity + '.exe')
  $userUninstaller = Join-Path $userDir ('Uninstall ' + $m.identity + '.exe')
  $oldUninstallerHash = (Get-FileHash -LiteralPath $userUninstaller).Hash
  $lock = [IO.File]::Open($userExe, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
  try { Assert ((Run 'allusers' $machineDir) -eq 0) 'Machine installation touched the locked per-user copy' } finally { $lock.Dispose() }
  Assert ((Read-Path $user) -eq $userDir -and (Read-Path $machine) -eq $machineDir) 'Coexisting scope registration changed'
  Assert ((Get-FileHash -LiteralPath $userUninstaller).Hash -eq $oldUninstallerHash) 'Machine installation changed the other uninstaller'
  $cases += @{ case = 'coexisting-scopes'; passed = $true }
  $cases += @{ case = 'other-scope-locked-file'; passed = $true }
  Assert ((Run '' '') -ne 0) 'An ambiguous silent installation chose a scope without a target'
  Assert ((Get-FileHash -LiteralPath $userUninstaller).Hash -eq $oldUninstallerHash) 'Ambiguous-scope rejection changed the other installation'
  $cases += @{ case = 'ambiguous-silent-scope-rejected'; passed = $true }
  $wsh = New-Object -ComObject WScript.Shell
  $aliases = @{}
  foreach ($folder in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('DesktopDirectory'))) {
    foreach ($file in Get-ChildItem -LiteralPath $folder -Filter ($m.identity + '.lnk') -Recurse -File) {
      if ($wsh.CreateShortcut($file.FullName).TargetPath -ieq $userExe) { $aliases[$file.FullName] = (Get-FileHash -LiteralPath $file.FullName).Hash }
    }
  }
  Assert ($aliases.Count -gt 0) 'No own per-user aliases were created'
  [IO.File]::Delete($userExe)
  Assert ((Run 'allusers' $machineDir) -eq 0) 'Repair of machine scope failed'
  Assert (-not [IO.File]::Exists($userExe)) 'Machine repair wrote into the damaged per-user copy'
  Assert ((Get-FileHash -LiteralPath $userUninstaller).Hash -eq $oldUninstallerHash) 'Machine repair removed the other uninstaller'
  foreach ($file in $aliases.Keys) { Assert ((Get-FileHash -LiteralPath $file).Hash -eq $aliases[$file]) 'Machine repair retargeted an alias of the damaged other scope' }
  $cases += @{ case = 'damaged-other-scope-preserved'; passed = $true }
  [IO.File]::Copy((Join-Path $PackageRoot ('app\' + $m.identity + '.exe')), $userExe)
  # A per-user alias may intentionally launch the machine copy. Preserve that
  # target as well when the machine executable is temporarily missing.
  $machineExe = Join-Path $machineDir ($m.identity + '.exe')
  $machineAlias = Join-Path ([Environment]::GetFolderPath('Programs')) ($m.identity + '-machine.lnk')
  Assert (-not [IO.File]::Exists($machineAlias)) 'An unexpected QA alias already exists'
  [IO.File]::Copy(@($aliases.Keys)[0], $machineAlias)
  $link = $wsh.CreateShortcut($machineAlias)
  $link.TargetPath = $machineExe
  $link.Save()
  $aliasHash = (Get-FileHash -LiteralPath $machineAlias).Hash
  [IO.File]::Delete($machineExe)
  try {
    Assert ((Run 'currentuser' $userDir) -eq 0) 'Repair of current-user scope failed'
    Assert (-not [IO.File]::Exists($machineExe)) 'Per-user repair wrote into the machine copy'
    Assert ((Get-FileHash -LiteralPath $machineAlias).Hash -eq $aliasHash) 'Per-user repair retargeted the damaged machine alias'
  } finally {
    [IO.File]::Copy((Join-Path $PackageRoot ('app\' + $m.identity + '.exe')), $machineExe)
    if ((Get-FileHash -LiteralPath $machineAlias).Hash -eq $aliasHash) { [IO.File]::Delete($machineAlias) }
  }
  $cases += @{ case = 'damaged-machine-scope-alias-preserved'; passed = $true }
  User-Paths $machineDir
  Assert ((Run 'allusers' $machineDir '--updated') -ne 0) 'Two scopes sharing one directory were accepted'
  Assert ([IO.File]::Exists($userExe)) 'Ambiguous-scope rejection removed other files'
  User-Paths $userDir
  $cases += @{ case = 'shared-directory-scope-conflict'; passed = $true }
  $retargeted = @{}
  foreach ($file in $aliases.Keys) {
    $link = $wsh.CreateShortcut($file)
    $link.TargetPath = $machineExe
    $link.Save()
    $retargeted[$file] = (Get-FileHash -LiteralPath $file).Hash
  }
  Assert ((Run 'currentuser' $userDir) -eq 0) 'Per-user repair with a machine-target default alias failed'
  foreach ($file in $retargeted.Keys) {
    Assert ((Get-FileHash -LiteralPath $file).Hash -eq $retargeted[$file]) 'Repair overwrote a default alias targeting the other scope'
  }
  $cases += @{ case = 'repair-preserves-default-other-target-aliases'; passed = $true }
  Assert ((Run 'currentuser' $userDir '/UNINSTALL') -eq 0) 'Selected per-user uninstall failed'
  foreach ($file in $retargeted.Keys) {
    Assert ([IO.File]::Exists($file) -and (Get-FileHash -LiteralPath $file).Hash -eq $retargeted[$file]) 'Vendor cleanup removed a default alias targeting the other scope'
  }
  $cases += @{ case = 'uninstall-preserves-other-target-aliases'; passed = $true }
  Assert ((Read-Path $machine) -eq $machineDir) 'Per-user uninstall changed machine registration'
  Assert ((Get-FileHash -LiteralPath (Join-Path $machineDir ($m.identity + '.exe'))).Hash -ieq $m.executableSha256) 'Per-user uninstall changed machine payload'
  Assert ((Run 'allusers' $machineDir '/UNINSTALL') -eq 0) 'Selected all-users uninstall failed'
  $cases += @{ case = 'uninstall-only-selected-scope'; passed = $true }
  $report = @{ passed = $true; cases = $cases; fixtureRoot = $root; syntheticPayload = $true; signed = $false; productionInstallationTouched = $false } | ConvertTo-Json -Depth 5
  [IO.File]::WriteAllText((Join-Path $root 'result.json'), $report)
  $report
} catch {
  [IO.File]::WriteAllText((Join-Path $root 'result.json'), ((@{ passed = $false; cases = $cases; error = $_.Exception.Message } | ConvertTo-Json -Depth 5)))
  throw
} finally { $user.Dispose(); $machine.Dispose() }
