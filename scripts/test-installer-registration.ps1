param([Parameter(Mandatory = $true)][string]$RecoveryScript)
$ErrorActionPreference = 'Stop'
$id = [Guid]::NewGuid().ToString('N')
$root = Join-Path ([IO.Path]::GetTempPath()) ('nuwax-registration-fixture-' + $id)
$install = Join-Path $root 'installation'
$state = Join-Path $root 'state.txt'
[IO.Directory]::CreateDirectory($install) | Out-Null
[IO.File]::WriteAllText((Join-Path $root 'owner.txt'), $id)
$prefix = 'Software\NuwaxInstallerFixture\' + $id
$private = $prefix + '\Install'
$uninstall = $prefix + '\Uninstall'
$view = if ([Environment]::Is64BitOperatingSystem) { [Microsoft.Win32.RegistryView]::Registry64 } else { [Microsoft.Win32.RegistryView]::Registry32 }
$hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
function Assert($value, [string]$message) { if (-not $value) { throw $message } }
function Run([string]$action) {
  $psi = [Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
  $psi.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $RecoveryScript + '" -Action ' + $action + ' -InstallDir "' + $install + '" -StatePath "' + $state + '" -RegistryScope CurrentUser -InstallRegistryKey "' + $private + '" -UninstallRegistryKey "' + $uninstall + '"'
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $p = [Diagnostics.Process]::Start($psi)
  $stdout = $p.StandardOutput.ReadToEndAsync(); $stderr = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit(45000)) { $p.Kill(); throw 'Owned fixture timed out' }
  return @{ code = $p.ExitCode; output = $stdout.Result + $stderr.Result }
}
try {
  foreach ($keyName in @($private, $uninstall)) {
    $key = $hive.CreateSubKey($keyName)
    try {
      $key.SetValue('InstallLocation', $install)
      $key.SetValue('UninstallString', ('"' + $install + '\Uninstall Nuwax.exe" /currentuser'))
      $key.SetValue('NoModify', 1, [Microsoft.Win32.RegistryValueKind]::DWord)
      $key.SetValue('FixtureMultiString', [string[]]@('first', 'second'), [Microsoft.Win32.RegistryValueKind]::MultiString)
    } finally { $key.Dispose() }
  }
  [IO.File]::WriteAllText((Join-Path $install 'Uninstall Nuwax.exe'), 'not an executable')
  [IO.File]::WriteAllText((Join-Path $install 'Nuwax.exe'), 'old app')
  $prepared = Run 'Prepare'; Assert ($prepared.code -eq 0) $prepared.output
  $backup = [IO.File]::ReadAllText($state).Trim()
  $snapshot = Join-Path $backup 'registration.json'
  Assert ([IO.File]::Exists($snapshot)) 'Registration snapshot missing'
  $detached = Run 'Detach'; Assert ($detached.code -eq 0) $detached.output
  $hive.DeleteSubKeyTree($private); $hive.DeleteSubKeyTree($uninstall)
  # Model extraction failing after the legacy uninstaller removed registration.
  [IO.File]::WriteAllText((Join-Path $install 'Nuwax.exe'), 'partial new app must not be overwritten')
  $restored = Run 'RestoreRegistration'; Assert ($restored.code -eq 0) $restored.output
  foreach ($keyName in @($private, $uninstall)) {
    $key = $hive.OpenSubKey($keyName)
    try {
      Assert ($key -and $key.GetValue('InstallLocation') -eq $install) 'Original registration not restored'
      Assert ($key.GetValueKind('NoModify') -eq [Microsoft.Win32.RegistryValueKind]::DWord) 'Registry value type changed'
      Assert ($key.GetValue('FixtureMultiString').Count -eq 2) 'Multi-string snapshot changed'
    } finally { if ($key) { $key.Dispose() } }
  }
  Assert ([IO.File]::Exists((Join-Path $install 'Uninstall Nuwax.exe'))) 'Failed installation lost uninstall entry'
  Assert ([IO.File]::ReadAllText((Join-Path $install 'Nuwax.exe')) -eq 'partial new app must not be overwritten') 'Registration recovery overwrote files'
  $originalSnapshot = [IO.File]::ReadAllText($snapshot)
  [IO.File]::WriteAllText($snapshot, $originalSnapshot + ' ')
  $rejected = Run 'RestoreRegistration'; Assert ($rejected.code -ne 0) 'Changed snapshot was accepted'
  [pscustomobject]@{ passed = $true; fixtureRoot = $root; cases = @('typed-registration-snapshot', 'failed-extraction-entry-restored', 'changed-snapshot-rejected'); productionRegistryTouched = $false } | ConvertTo-Json
} finally {
  # The prefix was generated in this process and never names an application.
  $hive.DeleteSubKeyTree($prefix, $false)
  $hive.Dispose()
}
