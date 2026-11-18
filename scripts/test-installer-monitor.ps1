# Native Windows regression using a private synthetic EXE. No product installer,
# registration, client process or business data is touched.
param([string]$MonitorScript = (Join-Path $PSScriptRoot '../nuwa-electron-shell/crates/agent-electron-client/build/installer-monitor.ps1'))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Monitor regression requires Windows.' }
$source = [IO.Path]::GetFullPath($MonitorScript)
$root = Join-Path ([IO.Path]::GetTempPath()) ('nuwax monitor test ' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
$utf8 = [Text.UTF8Encoding]::new($false)
$owned = [Collections.Generic.List[Diagnostics.Process]]::new()
$completionKeys = [Collections.Generic.List[string]]::new()
function Write-Json([string]$Path, $Value) {
  [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 5 -Compress), $utf8)
}
function Read-Until([string]$File, [string[]]$States) {
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  while ([DateTime]::UtcNow -lt $deadline) {
    $value = $null
    try {
      $value = [IO.File]::ReadAllText($File) | ConvertFrom-Json
      if ($States -contains $value.status) { return $value }
    } catch { }
    if ($null -ne $value -and $value.status -eq 'failed') {
      throw ('Monitor failed during ' + $value.phase + ': ' + $value.error)
    }
    Start-Sleep -Milliseconds 50
  }
  $last = if ($null -ne $value) { $value | ConvertTo-Json -Compress } else { 'no receipt' }
  throw ('Timed out waiting for ' + ($States -join ',') + ': ' + $File + '; last=' + $last)
}
try {
  $fixtureExe = Join-Path $root 'SyntheticParent.exe'
  Add-Type -OutputAssembly $fixtureExe -OutputType WindowsApplication -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
public static class SyntheticInstallerMonitorFixture {
  public static int Main(string[] args) {
    if (Environment.GetEnvironmentVariable("NUWAX_QA_ROLE") == "parent") {
      while (!File.Exists(Environment.GetEnvironmentVariable("NUWAX_QA_RELEASE"))) Thread.Sleep(25);
      return 0;
    }
    File.WriteAllText(Environment.GetEnvironmentVariable("NUWAX_QA_MARKER"), Environment.CommandLine);
    if (Environment.GetEnvironmentVariable("NUWAX_QA_PAUSE") == "1") Thread.Sleep(1500);
    return Int32.Parse(Environment.GetEnvironmentVariable("NUWAX_QA_EXIT"));
  }
}
'@
  foreach ($case in @('success', 'failure', 'tampered', 'cancelled', 'locked', 'completion', 'job-tampered')) {
    $id = [Guid]::NewGuid().ToString()
    $directory = Join-Path $root $id
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    $installer = Join-Path $directory 'SyntheticInstaller.exe'
    [IO.File]::Copy($fixtureExe, $installer)
    $monitor = Join-Path $directory 'monitor.ps1'
    [IO.File]::Copy($source, $monitor)
    $release = Join-Path $directory 'release-parent'
    $marker = Join-Path $directory 'installer-ran'
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $fixtureExe
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.EnvironmentVariables['NUWAX_QA_ROLE'] = 'parent'
    $start.EnvironmentVariables['NUWAX_QA_RELEASE'] = $release
    $parent = [Diagnostics.Process]::Start($start)
    $owned.Add($parent)
    $job = @{
      schemaVersion = 1; id = $id; product = 'nuwax-monitor-qa'; fromVersion = '3.1.3'; targetVersion = '3.2.0';
      currentExe = $fixtureExe; installDirectory = $root; installerPath = $installer;
      installerSha512 = (Get-FileHash -LiteralPath $installer -Algorithm SHA512).Hash.ToLowerInvariant();
      monitorSha256 = (Get-FileHash -LiteralPath $monitor -Algorithm SHA256).Hash.ToLowerInvariant();
      parentPid = $parent.Id; createdAt = [DateTime]::UtcNow.ToString('o');
      messages = @{ title = 'Synthetic QA'; failed = 'Synthetic failure'; unconfirmed = 'Synthetic unconfirmed' }
    }
    $jobPath = Join-Path $directory 'job.json'
    Write-Json $jobPath $job
    $jobHash = (Get-FileHash -LiteralPath $jobPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $identity = @{ id = $id; jobSha256 = $jobHash }
    # The product uses this marker when the user has already seen the recovery
    # dialog. It also keeps this isolated regression from opening any GUI.
    Write-Json (Join-Path $directory 'acknowledged.json') $identity
    if ($case -eq 'completion') {
      $registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
      $keyPath = 'Software\nuwax-monitor-qa\InstallerResults\' + $id
      $completionKeys.Add($keyPath)
      $key = $registry.CreateSubKey($keyPath)
      try { $key.SetValue('Status', 'complete'); $key.SetValue('Version', '3.2.0'); $key.SetValue('InstallPath', $root) }
      finally { $key.Dispose(); $registry.Dispose() }
    }
    if ($case -eq 'job-tampered') { [IO.File]::AppendAllText($jobPath, ' ') }
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $start.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $monitor + '" -JobPath "' + $jobPath + '" -JobSha256 ' + $jobHash + ' -Launch'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.EnvironmentVariables['NUWAX_QA_ROLE'] = 'installer'
    $start.EnvironmentVariables['NUWAX_QA_MARKER'] = $marker
    $start.EnvironmentVariables['NUWAX_QA_EXIT'] = $(if ($case -eq 'failure') { '2' } else { '0' })
    $start.EnvironmentVariables['NUWAX_QA_PAUSE'] = $(if ($case -eq 'locked') { '1' } else { '0' })
    $launcher = [Diagnostics.Process]::Start($start)
    $owned.Add($launcher)
    if (-not $launcher.WaitForExit(10000)) { throw 'Monitor launcher did not exit independently of the worker.' }
    if ($case -eq 'job-tampered') {
      if ($launcher.ExitCode -eq 0 -or [IO.File]::Exists($marker)) { throw 'Modified job was accepted.' }
      [IO.File]::WriteAllText($release, 'exit')
      if (-not $parent.WaitForExit(5000)) { throw 'Synthetic parent did not terminate.' }
      Write-Output 'PASS monitor=job-tampered phase=Handoff'
      continue
    }
    if ($launcher.ExitCode -ne 0) { throw ('Monitor launcher exit code: ' + $launcher.ExitCode) }
    $launch = [IO.File]::ReadAllText((Join-Path $directory 'launch.json'), $utf8) | ConvertFrom-Json
    if ($launch.id -ne $id -or $launch.jobSha256 -ne $jobHash -or $launch.monitorPid -le 0) {
      throw 'Monitor launch receipt did not identify the worker.'
    }
    $workerPid = $launch.monitorPid
    try { $process = [Diagnostics.Process]::GetProcessById($workerPid) }
    catch {
      $workerLog = Get-Content -LiteralPath (Join-Path $directory 'monitor.stderr.log') -Raw -ErrorAction SilentlyContinue
      $receipt = Get-Content -LiteralPath (Join-Path $directory 'receipt.json') -Raw -ErrorAction SilentlyContinue
      throw ('Monitor worker exited before handoff: ' + $workerLog + ' ' + $receipt)
    }
    $owned.Add($process)
    $receiptPath = Join-Path $directory 'receipt.json'
    $ready = Read-Until $receiptPath @('ready', 'failed')
    if ($ready.status -ne 'ready' -or $ready.monitorPid -ne $workerPid) { throw ('Monitor did not become ready: ' + $ready.error) }
    if ([IO.File]::Exists($marker)) { throw 'Installer ran before the client committed and exited.' }
    if ($case -eq 'tampered') { [IO.File]::AppendAllText($installer, 'changed') }
    if ($case -eq 'cancelled') {
      Write-Json (Join-Path $directory 'cancel.json') $identity
      $result = Read-Until $receiptPath @('cancelled')
    } else {
      Write-Json (Join-Path $directory 'commit.json') $identity
      Start-Sleep -Milliseconds 150
      if ([IO.File]::Exists($marker)) { throw 'Installer ran while the old client was alive.' }
      [IO.File]::WriteAllText($release, 'exit')
      if ($case -eq 'locked') {
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        while (-not [IO.File]::Exists($marker) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 20 }
        if (-not [IO.File]::Exists($marker)) { throw 'Synthetic installer did not start.' }
        try {
          $writer = [IO.File]::OpenWrite($installer)
          $writer.Dispose()
          throw 'Running installer could be overwritten.'
        } catch [IO.IOException] { }
      }
      $expected = if ($case -in @('success', 'locked', 'completion')) { 'installer-exited' } else { 'failed' }
      $result = Read-Until $receiptPath @($expected)
      if ($case -in @('success', 'locked', 'completion')) {
        if ($result.exitCode -ne 0) { throw 'Successful synthetic installer exit was lost.' }
        if ($case -eq 'completion' -and -not $result.installationCompleted) { throw 'Native completion marker was lost.' }
        Write-Json (Join-Path $directory 'confirmed.json') $identity
        $result = Read-Until $receiptPath @('confirmed')
        $arguments = [IO.File]::ReadAllText($marker)
        if (-not $arguments.Contains('/NUWAX-UPDATE-ID=' + $id) -or -not $arguments.Contains('/D=' + $root)) { throw 'Installer transaction or original path was lost.' }
      } elseif ($case -eq 'failure' -and $result.exitCode -ne 2) { throw 'Installer failure exit code was lost.' }
    }
    if ($case -in @('tampered', 'cancelled') -and [IO.File]::Exists($marker)) { throw 'Rejected installer executed.' }
    if ($case -eq 'cancelled') { [IO.File]::WriteAllText($release, 'exit') }
    if (-not $process.WaitForExit(5000)) { throw 'Monitor did not terminate after recording its result.' }
    if (-not $parent.WaitForExit(5000)) { throw 'Synthetic parent did not terminate.' }
    Write-Output ('PASS monitor=' + $case + ' phase=' + $result.phase)
  }
} finally {
  foreach ($process in $owned) {
    try { if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() } } catch { }
    $process.Dispose()
  }
  $registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
  try { foreach ($keyPath in $completionKeys) { $registry.DeleteSubKeyTree($keyPath, $false) } }
  finally { $registry.Dispose() }
  [IO.Directory]::Delete($root, $true)
}
