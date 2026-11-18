param(
  [Parameter(Mandatory=$true)][string]$JobPath,
  [Parameter(Mandatory=$true)][string]$JobSha256,
  [switch]$Launch
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$directory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($JobPath))
$receiptPath = Join-Path $directory 'receipt.json'
$utf8 = [Text.UTF8Encoding]::new($false)
$job = $null
$phase = 'Handoff'
$installationCompleted = $false

function Write-AtomicJson([string]$Path, $Value) {
  $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  $backup = $temporary + '.previous'
  try {
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 5 -Compress), $utf8)
    if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary, $Path, $backup) }
    else { [IO.File]::Move($temporary, $Path) }
  } finally {
    if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    if ([IO.File]::Exists($backup)) { [IO.File]::Delete($backup) }
  }
}
function Write-Receipt([string]$Status, $ExitCode = $null, [string]$Detail = '') {
  Write-AtomicJson $receiptPath ([ordered]@{
    schemaVersion = 1; id = $job.id; jobSha256 = $JobSha256; status = $Status;
    phase = $script:phase; monitorPid = $PID; exitCode = $ExitCode; error = $Detail;
    installationCompleted = $script:installationCompleted;
    updatedAt = [DateTime]::UtcNow.ToString('o')
  })
}
function Has-Marker([string]$Name) {
  $file = Join-Path $directory $Name
  if (-not [IO.File]::Exists($file)) { return $false }
  $value = [IO.File]::ReadAllText($file) | ConvertFrom-Json
  return $value.id -eq $job.id -and $value.jobSha256 -eq $JobSha256
}
function Show-Recovery([string]$Message) {
  try {
    if (Has-Marker 'acknowledged.json') { return }
    Add-Type -AssemblyName System.Windows.Forms
    [Windows.Forms.MessageBox]::Show(($Message + "`r`n`r`n" + $directory), [string]$job.messages.title,
      [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
  } catch { } # A blocked UI still leaves a durable receipt for the next launch.
}
function Save-InstallerLog {
  try {
    $file = Join-Path ([IO.Path]::GetTempPath()) 'Nuwax-installer-lifecycle.log'
    if ([IO.File]::Exists($file)) {
      $lines = @(Get-Content -LiteralPath $file -Encoding Unicode -Tail 500 | Where-Object { $_.Contains('transaction=' + $job.id + ' ') })
      if ($lines.Count) { [IO.File]::WriteAllLines((Join-Path $directory 'installer-lifecycle.log'), [string[]]$lines, $utf8) }
    }
  } catch { }
}
function Read-InstallCompletion {
  $registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
  try {
    $key = $registry.OpenSubKey('Software\' + $job.product + '\InstallerResults\' + $job.id)
    if ($null -eq $key) { return $false }
    try {
      return $key.GetValue('Status') -ceq 'complete' -and $key.GetValue('Version') -ceq $job.targetVersion -and
        $key.GetValue('InstallPath') -ieq $job.installDirectory
    } finally { $key.Dispose() }
  } finally { $registry.Dispose() }
}

try {
  if ((Get-Item -LiteralPath $JobPath).Length -gt 65536) { throw 'Update job is too large.' }
  $jobBytes = [IO.File]::ReadAllBytes($JobPath)
  $jobHash = [Security.Cryptography.SHA256]::Create()
  try { $actualJobHash = [BitConverter]::ToString($jobHash.ComputeHash($jobBytes)).Replace('-', '').ToLowerInvariant() }
  finally { $jobHash.Dispose() }
  if ($JobSha256 -notmatch '^[a-f0-9]{64}$' -or $actualJobHash -cne $JobSha256) {
    throw 'Update job digest mismatch.'
  }
  $job = $utf8.GetString($jobBytes) | ConvertFrom-Json
  if ($job.schemaVersion -ne 1 -or $job.id -notmatch '^[a-f0-9-]{36}$' -or
      $job.product -notmatch '^[a-z][a-z0-9-]{0,48}$' -or
      [IO.Path]::GetFileName($directory) -cne $job.id -or
      $job.installerSha512 -notmatch '^[a-f0-9]{128}$' -or
      $job.installDirectory -notmatch '^[A-Za-z]:\\' -or $job.installDirectory -match '["\x00-\x1f]' -or
      [IO.Path]::GetDirectoryName($job.currentExe) -ine $job.installDirectory) {
    throw 'Invalid update job identity or installation path.'
  }
  if ((Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash -ine $job.monitorSha256) {
    throw 'Update monitor differs from the installed signed resource.'
  }
  if ($Launch) {
    # Windows PowerShell can exit before running -File under DETACHED_PROCESS.
    # Give the worker its own hidden console and report its PID to the client.
    $arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $PSCommandPath +
      '" -JobPath "' + [IO.Path]::GetFullPath($JobPath) + '" -JobSha256 ' + $JobSha256
    $worker = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments `
      -WorkingDirectory $directory -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput (Join-Path $directory 'monitor.stdout.log') `
      -RedirectStandardError (Join-Path $directory 'monitor.stderr.log')
    try {
      Write-AtomicJson (Join-Path $directory 'launch.json') @{
        id = $job.id; jobSha256 = $JobSha256; monitorPid = $worker.Id
      }
    } finally { $worker.Dispose() }
    exit 0
  }
  # Capture the actual parent process before acknowledging readiness; a reused
  # numeric PID or another installed copy must not authorize an installation.
  $parent = [Diagnostics.Process]::GetProcessById([int]$job.parentPid)
  $null = $parent.Handle
  if ($parent.MainModule.FileName -ine $job.currentExe) { throw 'Update parent executable mismatch.' }
  try {
    Write-Receipt 'ready'
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while (-not (Has-Marker 'commit.json')) {
      if (Has-Marker 'cancel.json') { Write-Receipt 'cancelled'; exit 0 }
      if ($parent.HasExited -or [DateTime]::UtcNow -gt $deadline) { throw 'Client exited without committing the update handoff.' }
      Start-Sleep -Milliseconds 100
    }
    $phase = 'WaitingForClientExit'
    Write-Receipt 'running'
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    while (-not $parent.HasExited) {
      if (Has-Marker 'cancel.json') { Write-Receipt 'cancelled'; exit 0 }
      if ([DateTime]::UtcNow -gt $deadline) { throw 'Client did not exit; installer was not started.' }
      Start-Sleep -Milliseconds 100
    }
  } finally { $parent.Dispose() }

  $phase = 'VerifyInstaller'
  Write-Receipt 'running'
  # The SDK verified the download before handoff. Recheck the exact bytes after
  # shutdown so a mutable download cache cannot substitute another executable.
  $payload = [IO.File]::Open($job.installerPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $payloadHash = [Security.Cryptography.SHA512]::Create()
    try { $actualHash = [BitConverter]::ToString($payloadHash.ComputeHash($payload)).Replace('-', '').ToLowerInvariant() }
    finally { $payloadHash.Dispose() }
    if ($actualHash -cne $job.installerSha512) { throw 'Downloaded installer changed after verification.' }
    $phase = 'Installer'
    Write-Receipt 'running'
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $job.installerPath
    # /D consumes the complete tail, including spaces; no shell interprets it.
    $start.Arguments = '--updated --force-run /NUWAX-UPDATE-ID=' + $job.id + ' /D=' + $job.installDirectory
    $start.UseShellExecute = $false
    $start.WorkingDirectory = $directory
    try { $installer = [Diagnostics.Process]::Start($start) }
    catch [ComponentModel.Win32Exception] {
      if ($_.Exception.NativeErrorCode -ne 740) { throw }
      $start.UseShellExecute = $true
      $start.Verb = 'runas'
      $installer = [Diagnostics.Process]::Start($start)
    }
    try {
      $installer.WaitForExit()
      $code = $installer.ExitCode
    } finally { $installer.Dispose() }
  } finally { $payload.Dispose() }
  Save-InstallerLog
  try { $installationCompleted = Read-InstallCompletion } catch { $installationCompleted = $false }
  $phase = 'InstallerExited'
  if ($code -ne 0) {
    Write-Receipt 'failed' $code 'Installer returned a nonzero exit code.'
    Show-Recovery ([string]$job.messages.failed)
    exit 0
  }
  Write-Receipt 'installer-exited' 0
  # A zero exit can mean cancellation/UAC refusal. Only the launched target
  # version can acknowledge success; absence of confirmation remains visible.
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Has-Marker 'confirmed.json') { Write-Receipt 'confirmed' 0; exit 0 }
    Start-Sleep -Milliseconds 250
  }
  Show-Recovery ([string]$job.messages.unconfirmed)
} catch {
  if ($Launch) {
    Write-AtomicJson (Join-Path $directory 'launch.json') @{
      id = [IO.Path]::GetFileName($directory); jobSha256 = $JobSha256; error = $_.Exception.Message
    }
    exit 2
  }
  if ($null -ne $job) {
    try { Save-InstallerLog; Write-Receipt 'failed' $null $_.Exception.Message } catch { }
    Show-Recovery ([string]$job.messages.failed)
  }
  exit 2
}
