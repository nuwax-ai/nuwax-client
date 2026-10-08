# Windows-only regression fixtures. All payloads and workspaces are fake files
# in a new, randomly named temporary directory; no installer or payload EXE runs.
# Run from the client repository:
# powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test-installer-recovery.ps1
param(
  [string]$RecoveryScript = (Join-Path $PSScriptRoot '../overlay/crates/agent-electron-client/build/normalize-old-install.ps1'),
  [switch]$KeepFixture
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'These fixtures require Windows; they do not validate Windows behavior on another platform.'
}
$scriptPath = [IO.Path]::GetFullPath($RecoveryScript)
if (-not [IO.File]::Exists($scriptPath)) {
  throw 'Recovery script does not exist.'
}
foreach ($parsePath in @($scriptPath, $PSCommandPath)) {
  $parseTokens = $null
  $parseErrors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($parsePath, [ref]$parseTokens, [ref]$parseErrors) | Out-Null
  if ($parseErrors.Count -gt 0) {
    throw "PowerShell syntax errors in $parsePath"
  }
}
$powershellExe = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
if (-not [IO.File]::Exists($powershellExe)) {
  throw 'Windows PowerShell is required to exercise the installer recovery runtime.'
}
$tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([char]92)
if ($tempParent -notmatch '^[A-Za-z]:\\') {
  throw 'A local-drive TEMP directory is required.'
}
$fixtureName = 'nuwax-installer-recovery-test-' + [Guid]::NewGuid().ToString('N')
$fixtureRoot = [IO.Path]::Combine($tempParent, $fixtureName)
if ([IO.Directory]::Exists($fixtureRoot)) {
  throw 'Refusing to reuse an existing fixture directory.'
}
[IO.Directory]::CreateDirectory($fixtureRoot) | Out-Null
$ownerFile = [IO.Path]::Combine($fixtureRoot, 'fixture-owner.txt')
[IO.File]::WriteAllText($ownerFile, $fixtureName)

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Assert-FixturePath([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  Assert-True ($full.StartsWith($fixtureRoot + '\', [StringComparison]::OrdinalIgnoreCase)) 'Path escaped the self-created fixture directory.'
}

function Write-FixtureFile([string]$Path, [string]$Content) {
  Assert-FixturePath $Path
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path)) | Out-Null
  [IO.File]::WriteAllText($Path, $Content)
}

function Get-FixtureHash([string]$Path) {
  Assert-FixturePath $Path
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($Path)))
  } finally {
    $sha.Dispose()
  }
}

function Read-FixtureManifest([string]$Path) {
  Assert-FixturePath $Path
  foreach ($line in [IO.File]::ReadAllLines($Path)) {
    if (-not [string]::IsNullOrWhiteSpace($line)) { $line | ConvertFrom-Json }
  }
}

function Invoke-Recovery([string]$Action, [string]$StatePath, [string]$InstallDir = '') {
  Assert-FixturePath $StatePath
  $recoveryArgs = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $scriptPath), '-Action', $Action, '-StatePath', ('"{0}"' -f $StatePath))
  if ($InstallDir) {
    Assert-FixturePath $InstallDir
    $recoveryArgs += @('-InstallDir', ('"{0}"' -f $InstallDir))
  }
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $powershellExe
  $start.Arguments = $recoveryArgs -join ' '
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $start
  try {
    Assert-True ($process.Start()) 'Could not start the recovery script.'
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(30000)) {
      # This is only the child launched above, not an installation or service.
      $process.Kill()
      $process.WaitForExit()
      throw 'The fixture recovery process exceeded 30 seconds.'
    }
    return [pscustomobject]@{ ExitCode = $process.ExitCode; Output = $stdout.Result + $stderr.Result }
  } finally {
    $process.Dispose()
  }
}

function Test-RestoreConflict([string]$CaseName, [bool]$PartialRestore) {
  $caseRoot = [IO.Path]::Combine($fixtureRoot, $CaseName)
  $install = [IO.Path]::Combine($caseRoot, 'fake-install')
  $state = [IO.Path]::Combine($caseRoot, 'fake-plugin-state.txt')
  $workspace = [IO.Path]::Combine($install, 'workspace')
  $originalFile = [IO.Path]::Combine($workspace, 'original.bin')
  $otherFile = [IO.Path]::Combine($install, 'other-workspace', 'other.bin')
  $appFile = [IO.Path]::Combine($install, 'Nuwax.exe')
  Write-FixtureFile ([IO.Path]::Combine($install, 'Uninstall Nuwax.exe')) 'NOT AN EXECUTABLE: fixture only'
  Write-FixtureFile $appFile 'old fake payload'
  Write-FixtureFile ([IO.Path]::Combine($install, 'resources', 'old.txt')) 'old fake resource'
  Write-FixtureFile $originalFile 'original workspace bytes must survive'
  $originalHash = Get-FixtureHash $originalFile
  $otherHash = $null
  if ($PartialRestore) {
    Write-FixtureFile $otherFile 'independently restored workspace bytes'
    $otherHash = Get-FixtureHash $otherFile
  }

  $prepared = Invoke-Recovery 'Prepare' $state $install
  Assert-True ($prepared.ExitCode -eq 0) "Prepare failed: $($prepared.Output)"
  $recovery = [IO.File]::ReadAllText($state).Trim()
  Assert-FixturePath $recovery
  $manifest = [IO.Path]::Combine($recovery, 'manifest.jsonl')
  $records = @(Read-FixtureManifest $manifest)
  $workspacePlans = @($records | Where-Object { $_.status -eq 'planned' -and $_.original -eq $workspace })
  Assert-True ($workspacePlans.Count -eq 1) 'Prepare did not preserve the workspace exactly once.'
  $backupFile = [IO.Path]::Combine([string]$workspacePlans[0].backup, 'original.bin')
  Assert-True ((Get-FixtureHash $backupFile) -eq $originalHash) 'Prepare changed original workspace bytes.'
  $markers = @([IO.Directory]::GetFiles($caseRoot, 'Nuwax-installer-recovery-active-*.txt'))
  Assert-True ($markers.Count -eq 1) 'Prepare did not publish one persistent marker.'
  $marker = $markers[0]
  $markerHash = Get-FixtureHash $marker

  # Simulate a new payload and a destination collision, never an actual install.
  Write-FixtureFile $appFile 'new fake payload must not be overwritten'
  $newResource = [IO.Path]::Combine($install, 'resources', 'new.txt')
  Write-FixtureFile $newResource 'new fake resource'
  $collisionFile = [IO.Path]::Combine($workspace, 'new-owner.txt')
  Write-FixtureFile $collisionFile 'new destination bytes must not be overwritten'
  $appHash = Get-FixtureHash $appFile
  $resourceHash = Get-FixtureHash $newResource
  $collisionHash = Get-FixtureHash $collisionFile

  foreach ($attempt in 1..2) {
    $restored = Invoke-Recovery 'Restore' $state
    Assert-True ($restored.ExitCode -eq 3) "Conflicting Restore did not return 3: $($restored.Output)"
    Assert-True ([IO.File]::Exists($marker)) 'Conflict cleared the persistent marker.'
    Assert-True ((Get-FixtureHash $marker) -eq $markerHash) 'Conflict changed the recovery pointer.'
    $records = @(Read-FixtureManifest $manifest)
    Assert-True ($records[-1].status -eq 'restore-incomplete') 'Conflict was not recorded as an unfinished restore.'
    Assert-True (@($records | Where-Object { $_.status -eq 'restore-complete' }).Count -eq 0) 'Conflict was recorded as a completed restore.'
    Assert-True ((Get-FixtureHash $backupFile) -eq $originalHash) 'Conflict changed preserved workspace bytes.'
    Assert-True ((Get-FixtureHash $collisionFile) -eq $collisionHash) 'Conflict overwrote the new destination.'
    Assert-True ((Get-FixtureHash $appFile) -eq $appHash) 'Restore overwrote the new application payload.'
    Assert-True ((Get-FixtureHash $newResource) -eq $resourceHash) 'Restore overwrote the new resources payload.'
    if ($PartialRestore) {
      Assert-True ((Get-FixtureHash $otherFile) -eq $otherHash) 'Partial Restore lost or changed the independent workspace.'
    }
  }

  # A new NSIS process has a different StatePath; only the persistent marker
  # can expose this unfinished recovery to its Prepare invocation.
  $freshState = [IO.Path]::Combine($caseRoot, 'new-plugin-state.txt')
  $manifestHash = Get-FixtureHash $manifest
  $recoveryCount = @([IO.Directory]::GetDirectories($caseRoot, 'Nuwax-installer-recovery-*')).Count
  $reprepare = Invoke-Recovery 'Prepare' $freshState $install
  Assert-True ($reprepare.ExitCode -ne 0) 'Prepare mixed a new installation into the unfinished recovery.'
  Assert-True ($reprepare.Output.Contains('unfinished Restore/Rollback')) 'Prepare failed for a reason other than the unfinished recovery guard.'
  Assert-True (-not [IO.File]::Exists($freshState)) 'Rejected Prepare wrote new plugin state.'
  Assert-True (@([IO.Directory]::GetDirectories($caseRoot, 'Nuwax-installer-recovery-*')).Count -eq $recoveryCount) 'Rejected Prepare created another recovery directory.'
  Assert-True ((Get-FixtureHash $manifest) -eq $manifestHash) 'Rejected Prepare changed the recovery manifest.'
  Assert-True ((Get-FixtureHash $marker) -eq $markerHash) 'Rejected Prepare changed the persistent marker.'
  Assert-True ((Get-FixtureHash $backupFile) -eq $originalHash) 'Rejected Prepare changed preserved data.'

  # Delete only our self-created collision, then retry the real Restore action.
  Assert-FixturePath $workspace
  [IO.Directory]::Delete($workspace, $true)
  $retried = Invoke-Recovery 'Restore' $state
  Assert-True ($retried.ExitCode -eq 0) "Restore retry failed: $($retried.Output)"
  Assert-True ((Get-FixtureHash $originalFile) -eq $originalHash) 'Restore retry did not return original workspace bytes.'
  Assert-True ((Get-FixtureHash $appFile) -eq $appHash) 'Restore retry overwrote new payload bytes.'
  Assert-True ((Get-FixtureHash $newResource) -eq $resourceHash) 'Restore retry overwrote new resource bytes.'
  Assert-True (-not [IO.File]::Exists($marker)) 'Successful Restore did not clear the marker.'
  $records = @(Read-FixtureManifest $manifest)
  Assert-True ($records[-1].status -eq 'restore-complete' -and $records[-1].conflicts -eq 0) 'Successful retry did not record a zero-conflict completion.'
  if ($PartialRestore) {
    Assert-True ((Get-FixtureHash $otherFile) -eq $otherHash) 'Retry changed the workspace restored during the earlier partial attempt.'
  }
  $again = Invoke-Recovery 'Restore' $state
  Assert-True ($again.ExitCode -eq 0) "Repeated completed Restore failed: $($again.Output)"
  Assert-True ((Get-FixtureHash $originalFile) -eq $originalHash) 'Repeated Restore changed workspace bytes.'
  return [pscustomobject]@{ case = $CaseName; passed = $true; blockedPrepareUsesFreshStatePath = $true; dataHashesPreserved = $true; restoreRetryCompleted = $true }
}

try {
  $cases = @(
    (Test-RestoreConflict 'all-conflicts' $false),
    (Test-RestoreConflict 'partial-restore' $true)
  )
} finally {
  if (-not $KeepFixture) {
    # Cleanup is confined to the unique directory created above and its owner
    # sentinel. No install directory, registry entry, or user profile is used.
    Assert-True ([IO.Path]::GetDirectoryName($fixtureRoot) -eq $tempParent) 'Refusing cleanup outside the fixture parent.'
    Assert-True ([IO.Path]::GetFileName($fixtureRoot) -eq $fixtureName) 'Refusing cleanup of a different directory.'
    Assert-True ([IO.File]::ReadAllText($ownerFile) -eq $fixtureName) 'Fixture owner sentinel does not match.'
    [IO.Directory]::Delete($fixtureRoot, $true)
  }
}
[pscustomobject]@{ success = $true; cases = $cases; fixtureRetained = [bool]$KeepFixture; fixturePath = $fixtureRoot; installerExecuted = $false; registryTouched = $false } | ConvertTo-Json -Depth 5
