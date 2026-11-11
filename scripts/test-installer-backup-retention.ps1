param([Parameter(Mandatory = $true)][string]$RecoveryScript)
$ErrorActionPreference = 'Stop'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('nuwax-backup-retention-test-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($fixture) | Out-Null
[IO.File]::WriteAllText((Join-Path $fixture 'owner.txt'), 'Synthetic backups only')
[IO.File]::WriteAllText((Join-Path $fixture 'System.dll'), 'Native NSIS plugin shadow fixture')
$utf8 = [Text.UTF8Encoding]::new($false)
function Assert($condition, [string]$message) { if (!$condition) { throw $message } }
function Put([string]$path, [string]$value) {
  Assert ($path.StartsWith($fixture + '\', [StringComparison]::OrdinalIgnoreCase)) 'Fixture path escaped'
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path)) | Out-Null
  [IO.File]::WriteAllText($path, $value, $utf8)
}
function Hash([string]$path) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($path))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}
function Run([string]$action, [string]$install, [string]$state, [string]$inventory = '', [switch]$NoWait) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = "$env:WINDIR\SysWOW64\WindowsPowerShell\v1.0\powershell.exe"
  $psi.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $RecoveryScript + '" -Action ' + $action + ' -InstallDir "' + $install + '" -StatePath "' + $state + '"'
  if ($inventory) { $psi.Arguments += ' -PayloadInventoryPath "' + $inventory + '"' }
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $psi.WorkingDirectory = $fixture
  $p = [Diagnostics.Process]::Start($psi)
  $stdout = $p.StandardOutput.ReadToEndAsync(); $stderr = $p.StandardError.ReadToEndAsync()
  if ($NoWait) { return @{ process = $p; stdout = $stdout; stderr = $stderr } }
  if (!$p.WaitForExit(30000)) { $p.Kill(); throw 'Recovery test exceeded 30 seconds' }
  return @{ code = $p.ExitCode; output = $stdout.Result + $stderr.Result }
}
function Inventory([string]$file) {
  @{ schemaVersion = 1; executable = 'Nuwax.exe'; files = @('Nuwax.exe', 'resources/app.asar');
    directories = @('resources'); fileHashes = @{ 'Nuwax.exe' = (Hash $file); 'resources/app.asar' = (Hash $file) } }
}
function Seed([string]$case, [int]$days, [string]$mode = 'owned') {
  $parent = Join-Path $fixture $case
  $install = Join-Path $parent 'installation'
  $date = [DateTime]::UtcNow.AddDays(-$days)
  $backup = Join-Path $parent ('Nuwax-installer-recovery-' + $date.ToString('yyyyMMddTHHmmssZ') + '-' + [Guid]::NewGuid().ToString('N'))
  Put "$install\Nuwax.exe" 'CURRENT MUST STAY'
  Put "$backup\entry-000000" 'old owned payload'
  Put "$backup\entry-000001\app.asar" 'old owned payload'
  Put "$backup\uninstaller-backup.exe" 'not an executable'
  $inventory = Inventory "$backup\entry-000000"
  Put "$backup\payload-inventory.json" ($inventory | ConvertTo-Json -Depth 5 -Compress)
  $records = @(
    @{ status = 'start'; installDir = $install; recoveryDir = $backup },
    @{ status = 'planned'; original = "$install\Nuwax.exe"; backup = "$backup\entry-000000"; directory = $false },
    @{ status = 'planned'; original = "$install\resources"; backup = "$backup\entry-000001"; directory = $true },
    @{ status = 'complete'; moved = 2 },
    @{ status = 'payload-inventory-recorded'; sha256 = (Hash "$backup\payload-inventory.json"); uninstallerSha256 = (Hash "$backup\uninstaller-backup.exe") },
    @{ status = 'restore-complete'; conflicts = 0; completedAtUtc = $date.ToString('o') }
  )
  if ($mode -eq 'legacy') { $records = @($records | Where-Object { $_.status -ne 'payload-inventory-recorded' }); [IO.File]::Delete("$backup\payload-inventory.json") }
  if ($mode -eq 'unfinished') { $records[$records.Count - 1].status = 'restore-incomplete' }
  if ($mode -in @('registration', 'modified-registration', 'unproven-registration')) {
    Put "$backup\registration.json" '{"keys":[]}'
    if ($mode -ne 'unproven-registration') {
      $sha = [Security.Cryptography.SHA256]::Create()
      try { $digest = [Convert]::ToBase64String($sha.ComputeHash([IO.File]::ReadAllBytes("$backup\registration.json"))) }
      finally { $sha.Dispose() }
      $records = @($records[0..($records.Count - 2)]) + @(@{ status = 'registration-snapshot-recorded'; sha256 = $digest }, $records[-1])
    }
    if ($mode -eq 'modified-registration') { [IO.File]::AppendAllText("$backup\registration.json", 'changed') }
  }
  if ($mode -eq 'wrong-install') { $records[0].installDir = "$parent\other-install" }
  Put "$backup\manifest.jsonl" (($records | ForEach-Object { $_ | ConvertTo-Json -Compress }) -join [Environment]::NewLine)
  if ($mode -eq 'unknown') { Put "$backup\entry-000001\user-collision.txt" 'PERSONAL DATA' }
  if ($mode -eq 'modified') { Put "$backup\entry-000001\app.asar" 'USER MODIFIED OWNED FILE' }
  if ($mode -eq 'modified-uninstaller') { Put "$backup\uninstaller-backup.exe" 'USER MODIFIED UNINSTALLER' }
  if ($mode -eq 'tampered-inventory') { [IO.File]::AppendAllText("$backup\payload-inventory.json", ' ') }
  if ($mode -eq 'corrupt') { [IO.File]::AppendAllText("$backup\manifest.jsonl", "`nnot-json") }
  if ($mode -eq 'link') {
    Put "$parent\outside\sentinel.txt" 'OUTSIDE'
    [IO.File]::Delete("$backup\entry-000001\app.asar"); [IO.Directory]::Delete("$backup\entry-000001")
    $null = & cmd.exe /d /c mklink /J "$backup\entry-000001" "$parent\outside"
    Assert ($LASTEXITCODE -eq 0) 'Could not create owned junction fixture'
  }
  return @{ install = $install; backup = $backup; state = "$parent\state.txt"; parent = $parent }
}
$rows = @()
$old = Seed 'window' 20; $recent = Seed 'window' 3; $newest = Seed 'window' 1
$result = Run 'Cleanup' $old.install $old.state
Assert ($result.code -eq 0) $result.output
Assert (![IO.Directory]::Exists($old.backup)) ('Expired owned backup retained: ' + $result.output)
Assert ([IO.Directory]::Exists($recent.backup)) 'Backup younger than seven days removed'
Assert ([IO.Directory]::Exists($newest.backup)) 'Newest backup removed'
Assert ([IO.File]::ReadAllText("$($old.install)\Nuwax.exe") -eq 'CURRENT MUST STAY') 'Current install changed'
$rows += @{ case = 'one-latest-and-seven-day-window'; passed = $true }
$older = Seed 'latest-old' 40; $latestOld = Seed 'latest-old' 20
$result = Run 'Cleanup' $older.install $older.state
Assert ($result.code -eq 0 -and ![IO.Directory]::Exists($older.backup) -and [IO.Directory]::Exists($latestOld.backup)) ('Newest aged backup was not retained: ' + $result.output)
$rows += @{ case = 'newest-retained-after-seven-days'; passed = $true }
foreach ($mode in @('legacy', 'unfinished', 'wrong-install', 'unknown', 'modified', 'modified-uninstaller', 'tampered-inventory', 'corrupt', 'link', 'modified-registration', 'unproven-registration')) {
  $protected = Seed $mode 30 $mode; $latest = Seed $mode 1
  $before = Hash "$($protected.backup)\entry-000000"
  $result = Run 'Cleanup' $protected.install $protected.state
  Assert ($result.code -eq 0) $result.output
  Assert ([IO.Directory]::Exists($protected.backup)) "$mode backup removed"
  Assert ((Hash "$($protected.backup)\entry-000000") -eq $before) "$mode backup partly changed"
  if ($mode -eq 'link') { Assert ([IO.File]::ReadAllText("$($protected.parent)\outside\sentinel.txt") -eq 'OUTSIDE') 'Link destination changed' }
  $rows += @{ case = $mode; passed = $true }
}
$registered = Seed 'registration' 30 'registration'; $latest = Seed 'registration' 1
$result = Run 'Cleanup' $registered.install $registered.state
Assert ($result.code -eq 0 -and ![IO.Directory]::Exists($registered.backup)) ('Verified expired registry snapshot retained: ' + $result.output)
$rows += @{ case = 'verified-registration-snapshot'; passed = $true }
$active = Seed 'active' 30; $latest = Seed 'active' 1
$sha = [Security.Cryptography.SHA256]::Create()
try { $rootHash = [BitConverter]::ToString($sha.ComputeHash($utf8.GetBytes($active.install.ToUpperInvariant())), 0, 12).Replace('-', '').ToLowerInvariant() }
finally { $sha.Dispose() }
Put "$($active.parent)\Nuwax-installer-recovery-active-$rootHash.txt" $active.backup
$result = Run 'Cleanup' $active.install $active.state
Assert ($result.code -eq 0 -and [IO.Directory]::Exists($active.backup)) 'Active recovery removed'
$rows += @{ case = 'active-recovery'; passed = $true }
$busy = Seed 'foreground-priority' 30; $latest = Seed 'foreground-priority' 1
$manifest = "$($busy.backup)\manifest.jsonl"
$originalManifest = [IO.File]::ReadAllText($manifest)
# Keep a real cleanup busy parsing synthetic history until Inspect requests
# the same installation. No production paths, processes or registry are used.
$lines = $originalManifest -split [Environment]::NewLine
Put $manifest (($lines[0..($lines.Count - 2)] -join [Environment]::NewLine) + [Environment]::NewLine +
  ((('{"status":"fixture-history"}' + [Environment]::NewLine) * 20000)) + $lines[-1])
$sha = [Security.Cryptography.SHA256]::Create()
try { $rootHash = [BitConverter]::ToString($sha.ComputeHash($utf8.GetBytes($busy.install.ToUpperInvariant())), 0, 12).Replace('-', '').ToLowerInvariant() }
finally { $sha.Dispose() }
$mutex = [Threading.Mutex]::new($false, ('Global\NuwaxInstallerRecovery-Nuwax-installer-recovery-active-' + $rootHash))
$worker = Run 'Cleanup' $busy.install $busy.state '' -NoWait
try {
  $deadline = [DateTime]::UtcNow.AddSeconds(10); $observedBusy = $false
  do {
    $held = $mutex.WaitOne(0)
    if ($held) { $mutex.ReleaseMutex(); Start-Sleep -Milliseconds 10 } else { $observedBusy = $true }
  } while (!$observedBusy -and !$worker.process.HasExited -and [DateTime]::UtcNow -lt $deadline)
  Assert $observedBusy 'Cleanup never acquired the fixture recovery lock'
  $elapsed = [Diagnostics.Stopwatch]::StartNew()
  $result = Run 'Inspect' $busy.install $busy.state
  Assert ($result.code -eq 0 -and $elapsed.Elapsed.TotalSeconds -lt 10) ('Cleanup blocked foreground inspection: ' + $result.output)
  Assert ($worker.process.WaitForExit(5000)) 'Cleanup did not release its lock after yielding'
  $cleanupOutput = $worker.stdout.Result + $worker.stderr.Result
  Assert ($worker.process.ExitCode -eq 0 -and $cleanupOutput.Contains('yielded to an installation operation')) $cleanupOutput
  Assert ([IO.File]::Exists("$($busy.backup)\entry-000000")) 'Yielding cleanup changed preserved payload'
  Assert ([IO.File]::ReadAllText("$($busy.install)\Nuwax.exe") -eq 'CURRENT MUST STAY') 'Yielding cleanup changed current install'
} finally {
  if (!$worker.process.HasExited) { $worker.process.Kill(); $worker.process.WaitForExit() }
  $worker.process.Dispose(); $mutex.Dispose()
}
$rows += @{ case = 'foreground-inspection-preempts-cleanup'; passed = $true }
Put $manifest $originalManifest
$result = Run 'Cleanup' $busy.install $busy.state
Assert ($result.code -eq 0 -and ![IO.Directory]::Exists($busy.backup)) ('Cleanup did not resume after foreground work: ' + $result.output)
$rows += @{ case = 'cleanup-resumes-after-foreground'; passed = $true }
function Start-LegacyCleanupFixture([string]$install, [switch]$InvalidOwner) {
  $runtime = Join-Path ([IO.Path]::GetTempPath()) ('Nuwax-backup-cleanup-' + [Guid]::NewGuid().ToString('N'))
  Assert (![IO.Directory]::Exists($runtime)) 'Legacy fixture runtime already exists'
  [IO.Directory]::CreateDirectory($runtime) | Out-Null
  $owner = @{ kind = $(if ($InvalidOwner) { 'Unrelated task' } else { 'Nuwax backup cleanup' }); installDir = $install }
  [IO.File]::WriteAllText("$runtime\owner.json", ($owner | ConvertTo-Json -Compress), $utf8)
  [IO.File]::WriteAllText("$runtime\normalize-old-install.ps1", @'
param([string]$Action, [switch]$CleanupRuntime, [string]$StatePath, [string]$InstallDir)
if (([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'owner.json')) | ConvertFrom-Json).kind -ne 'Nuwax backup cleanup') {
  [IO.File]::WriteAllText(($StatePath + '.ready'), 'ready')
  while ($true) { Start-Sleep -Milliseconds 100 }
}
$sha = [Security.Cryptography.SHA256]::Create()
try { $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($InstallDir.ToUpperInvariant())), 0, 12).Replace('-', '').ToLowerInvariant() }
finally { $sha.Dispose() }
$mutex = [Threading.Mutex]::new($false, ('Global\NuwaxInstallerRecovery-Nuwax-installer-recovery-active-' + $hash))
if (!$mutex.WaitOne(0)) { exit 2 }
try {
  [IO.File]::WriteAllText(($StatePath + '.ready'), 'ready')
  while ($true) { Start-Sleep -Milliseconds 100 }
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
'@, $utf8)
  $psi = [Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
  $psi.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $runtime + '\normalize-old-install.ps1" -Action Cleanup -CleanupRuntime -StatePath "' + $runtime + '\state.txt" -InstallDir "' + $install + '"'
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  return @{ process = [Diagnostics.Process]::Start($psi); runtime = $runtime; ready = "$runtime\state.txt.ready" }
}
$legacy = Seed 'legacy-cleanup' 30; $other = Seed 'other-installation' 30
Put "$($legacy.install)\workspace\sentinel.txt" 'PERSONAL DATA MUST STAY'
$legacyWorker = Start-LegacyCleanupFixture $legacy.install
$otherWorker = Start-LegacyCleanupFixture $other.install
$unownedWorker = Start-LegacyCleanupFixture $legacy.install -InvalidOwner
try {
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while ((!([IO.File]::Exists($legacyWorker.ready)) -or !([IO.File]::Exists($otherWorker.ready)) -or !([IO.File]::Exists($unownedWorker.ready))) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 20 }
  Assert ([IO.File]::Exists($legacyWorker.ready) -and [IO.File]::Exists($otherWorker.ready) -and [IO.File]::Exists($unownedWorker.ready)) 'Legacy fixture workers were not ready'
  $elapsed = [Diagnostics.Stopwatch]::StartNew()
  $result = Run 'Inspect' $legacy.install $legacy.state
  Assert ($result.code -eq 0 -and $result.output.Trim() -eq 'NO_PENDING_RECOVERY' -and $elapsed.Elapsed.TotalSeconds -lt 15) ('Legacy cleanup blocked upgrade or altered installer protocol: ' + $result.output)
  Assert ($legacyWorker.process.WaitForExit(5000)) 'Owned legacy cleanup did not stop'
  Assert (!$otherWorker.process.HasExited) 'Another installation cleanup was stopped'
  Assert (!$unownedWorker.process.HasExited) 'A process without verified cleanup ownership was stopped'
  Assert ([IO.File]::ReadAllText("$($legacy.install)\workspace\sentinel.txt") -eq 'PERSONAL DATA MUST STAY') 'Legacy handoff modified workspace data'
  Assert ([IO.Directory]::Exists($legacy.backup)) 'Legacy handoff removed a backup'
} finally {
  foreach ($worker in @($legacyWorker, $otherWorker, $unownedWorker)) {
    if (!$worker.process.HasExited) { $worker.process.Kill(); $worker.process.WaitForExit() }
    $worker.process.Dispose()
    foreach ($file in @('normalize-old-install.ps1', 'owner.json', 'state.txt.ready')) { [IO.File]::Delete((Join-Path $worker.runtime $file)) }
    [IO.Directory]::Delete($worker.runtime, $false)
  }
}
$rows += @{ case = 'legacy-cleanup-handoff-and-installation-isolation'; passed = $true }
$expiredTransactionBackup = Seed 'transaction' 30
$transaction = Join-Path $fixture 'transaction'
$install = "$transaction\installation"; $state = "$transaction\state.txt"
Put "$install\Nuwax.exe" 'old owned payload'; Put "$install\resources\app.asar" 'old owned payload'
Put "$install\Uninstall Nuwax.exe" 'not an executable'
$inventory = "$transaction\embedded.json"
Put $inventory ((Inventory "$install\Nuwax.exe") | ConvertTo-Json -Depth 5)
foreach ($action in @('Prepare', 'RecordPayload')) {
  $result = Run $action $install $state $inventory
  Assert ($result.code -eq 0) ($action + ': ' + $result.output)
}
$recovery = [IO.File]::ReadAllText($state).Trim()
Put "$install\Nuwax.exe" 'new owned payload'; Put "$install\resources\app.asar" 'new owned payload'
$result = Run 'Restore' $install $state
Assert ($result.code -eq 0) $result.output
Assert ([IO.File]::Exists("$recovery\payload-inventory.json")) 'Old embedded inventory was not recorded'
Assert ([IO.File]::ReadAllText("$recovery\entry-000000") -eq 'old owned payload') 'Latest backup removed after Restore'
$rows += @{ case = 'prepare-record-restore'; passed = $true }
Assert ($result.output.Contains('Backup retention scheduled in background.')) 'Restore did not schedule background cleanup'
$sha = [Security.Cryptography.SHA256]::Create()
try { $rootHash = [BitConverter]::ToString($sha.ComputeHash($utf8.GetBytes($install.ToUpperInvariant())), 0, 12).Replace('-', '').ToLowerInvariant() }
finally { $sha.Dispose() }
$log = Join-Path ([IO.Path]::GetTempPath()) "Nuwax-installer-recovery-active-$rootHash-cleanup.log"
$deadline = [DateTime]::UtcNow.AddSeconds(15); $finished = $false
do {
  try { $finished = [IO.File]::ReadAllText($log).Contains('Backup retention:') } catch { }
  if (!$finished) { Start-Sleep -Milliseconds 100 }
} while (!$finished -and [DateTime]::UtcNow -lt $deadline)
Assert $finished 'Detached cleanup did not complete after Restore returned'
Assert (![IO.Directory]::Exists($expiredTransactionBackup.backup)) 'Detached cleanup did not remove expired owned backup'
Assert ([IO.File]::Exists("$recovery\entry-000000")) 'Background cleanup removed latest backup'
$rows += @{ case = 'detached-cleanup-completes'; passed = $true }
@{ passed = $true; cases = $rows; fixtureRoot = $fixture; realUserDataTouched = $false; fixtureRetained = $true } | ConvertTo-Json -Depth 5
