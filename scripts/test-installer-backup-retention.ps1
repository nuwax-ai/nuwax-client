param([Parameter(Mandatory = $true)][string]$RecoveryScript)
$ErrorActionPreference = 'Stop'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('nuwax-backup-retention-test-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($fixture) | Out-Null
[IO.File]::WriteAllText((Join-Path $fixture 'owner.txt'), 'Synthetic backups only')
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
function Run([string]$action, [string]$install, [string]$state, [string]$inventory = '') {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = "$env:WINDIR\SysWOW64\WindowsPowerShell\v1.0\powershell.exe"
  $psi.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $RecoveryScript + '" -Action ' + $action + ' -InstallDir "' + $install + '" -StatePath "' + $state + '"'
  if ($inventory) { $psi.Arguments += ' -PayloadInventoryPath "' + $inventory + '"' }
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $p = [Diagnostics.Process]::Start($psi)
  $stdout = $p.StandardOutput.ReadToEndAsync(); $stderr = $p.StandardError.ReadToEndAsync()
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
foreach ($mode in @('legacy', 'unfinished', 'wrong-install', 'unknown', 'modified', 'modified-uninstaller', 'tampered-inventory', 'corrupt', 'link')) {
  $protected = Seed $mode 30 $mode; $latest = Seed $mode 1
  $before = Hash "$($protected.backup)\entry-000000"
  $result = Run 'Cleanup' $protected.install $protected.state
  Assert ($result.code -eq 0) $result.output
  Assert ([IO.Directory]::Exists($protected.backup)) "$mode backup removed"
  Assert ((Hash "$($protected.backup)\entry-000000") -eq $before) "$mode backup partly changed"
  if ($mode -eq 'link') { Assert ([IO.File]::ReadAllText("$($protected.parent)\outside\sentinel.txt") -eq 'OUTSIDE') 'Link destination changed' }
  $rows += @{ case = $mode; passed = $true }
}
$active = Seed 'active' 30; $latest = Seed 'active' 1
$sha = [Security.Cryptography.SHA256]::Create()
try { $rootHash = [BitConverter]::ToString($sha.ComputeHash($utf8.GetBytes($active.install.ToUpperInvariant())), 0, 12).Replace('-', '').ToLowerInvariant() }
finally { $sha.Dispose() }
Put "$($active.parent)\Nuwax-installer-recovery-active-$rootHash.txt" $active.backup
$result = Run 'Cleanup' $active.install $active.state
Assert ($result.code -eq 0 -and [IO.Directory]::Exists($active.backup)) 'Active recovery removed'
$rows += @{ case = 'active-recovery'; passed = $true }
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
