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
$sourceBytes = [IO.File]::ReadAllBytes($scriptPath)
$hasUtf8Bom = $sourceBytes.Length -ge 3 -and $sourceBytes[0] -eq 0xEF -and $sourceBytes[1] -eq 0xBB -and $sourceBytes[2] -eq 0xBF
if (-not $hasUtf8Bom -and @($sourceBytes | Where-Object { $_ -gt 127 }).Count -gt 0) {
  throw 'Windows PowerShell 5.1 requires ASCII or UTF-8 with BOM; ANSI decoding can swallow a newline after a non-ASCII comment.'
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

function Remove-FixtureTree([string]$ExtendedPath) {
  $attributes = [IO.File]::GetAttributes($ExtendedPath)
  if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
      foreach ($entry in [IO.Directory]::GetFileSystemEntries($ExtendedPath)) { Remove-FixtureTree $entry }
    }
    [IO.Directory]::Delete($ExtendedPath, $false)
  } else {
    [IO.File]::Delete($ExtendedPath)
  }
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

function Test-InterruptedUpgrade([string]$CaseName, [bool]$Workspace, [bool]$Conflict, [bool]$CompletePreservation = $true) {
  $caseRoot = [IO.Path]::Combine($fixtureRoot, $CaseName)
  $install = [IO.Path]::Combine($caseRoot, 'fake-install')
  $state = [IO.Path]::Combine($caseRoot, 'old-plugin-state.txt')
  $freshState = [IO.Path]::Combine($caseRoot, 'new-plugin-state.txt')
  $appFile = [IO.Path]::Combine($install, 'Nuwax.exe')
  $workspaceFile = [IO.Path]::Combine($install, 'workspace', 'user.bin')
  Write-FixtureFile ([IO.Path]::Combine($install, 'Uninstall Nuwax.exe')) 'NOT AN EXECUTABLE: fixture only'
  Write-FixtureFile $appFile 'original application'
  Write-FixtureFile ([IO.Path]::Combine($install, 'resources', 'app.asar')) 'original resources'
  $workspaceHash = $null
  if ($Workspace) {
    Write-FixtureFile $workspaceFile 'workspace must survive interrupted upgrade'
    $workspaceHash = Get-FixtureHash $workspaceFile
  }
  $prepared = Invoke-Recovery 'Prepare' $state $install
  Assert-True ($prepared.ExitCode -eq 0) "Initial Prepare failed: $($prepared.Output)"
  $oldRecovery = [IO.File]::ReadAllText($state).Trim()
  $oldManifest = [IO.Path]::Combine($oldRecovery, 'manifest.jsonl')
  $oldRecords = @(Read-FixtureManifest $oldManifest)
  $oldApp = @($oldRecords | Where-Object { $_.status -eq 'planned' -and $_.original -eq $appFile })[0].backup
  $oldAppHash = Get-FixtureHash $oldApp
  $workspaceBackup = $null
  if ($Workspace) {
    $workspaceBackup = [IO.Path]::Combine([string](@($oldRecords | Where-Object { $_.status -eq 'planned' -and $_.original -eq [IO.Path]::GetDirectoryName($workspaceFile) })[0].backup), 'user.bin')
  }
  if (-not $CompletePreservation) {
    # Model a process interruption before the durable complete record.
    $lines = [IO.File]::ReadAllLines($oldManifest)
    [IO.File]::WriteAllLines($oldManifest, [string[]]$lines[0..($lines.Count - 2)], [Text.UTF8Encoding]::new($false))
  }

  # The installer died after Prepare. A reinstall or partial extraction has
  # repopulated the app directory without ever running customInstall/Restore.
  Write-FixtureFile $appFile 'repopulated application'
  Write-FixtureFile ([IO.Path]::Combine($install, 'resources', 'app.asar')) 'repopulated resources'
  $repopulatedHash = Get-FixtureHash $appFile
  $collision = [IO.Path]::Combine($install, 'workspace', 'new-owner.bin')
  if ($Conflict) { Write-FixtureFile $collision 'do not overwrite this destination' }

  $retry = Invoke-Recovery 'Prepare' $freshState $install
  $markers = @([IO.Directory]::GetFiles($caseRoot, 'Nuwax-installer-recovery-active-*.txt'))
  Assert-True ($markers.Count -eq 1) 'Retry lost the active recovery marker.'
  Assert-True ((Get-FixtureHash $oldApp) -eq $oldAppHash) 'Retry changed the prior application backup.'
  if (-not $CompletePreservation) {
    Assert-True ($retry.ExitCode -ne 0) 'Retry accepted duplicate payloads without a completed preservation record.'
    Assert-True ((Get-FixtureHash $appFile) -eq $repopulatedHash) 'Incomplete preservation overwrote the repopulated payload.'
    $records = @(Read-FixtureManifest $oldManifest)
    Assert-True (@($records | Where-Object { $_.status -eq 'restore-complete' }).Count -eq 0) 'Incomplete preservation was finalized as a completed restore.'
    if ($Workspace) {
      $remainingWorkspace = if ([IO.File]::Exists($workspaceFile)) { $workspaceFile } else { $workspaceBackup }
      Assert-True ((Get-FixtureHash $remainingWorkspace) -eq $workspaceHash) 'Incomplete preservation lost workspace bytes.'
    }
  } elseif ($Conflict) {
    Assert-True ($retry.ExitCode -eq 3) "Retry did not stop for a real workspace collision: $($retry.Output)"
    Assert-True (([IO.File]::ReadAllText($markers[0]).Trim()) -eq $oldRecovery) 'Conflict replaced the previous recovery marker.'
    Assert-True ((Get-FixtureHash $workspaceBackup) -eq $workspaceHash) 'Conflict changed the preserved workspace.'
    Assert-True ((Get-FixtureHash $appFile) -eq $repopulatedHash) 'Conflict changed the repopulated app.'
    Assert-True ([IO.File]::ReadAllText($collision) -eq 'do not overwrite this destination') 'Conflict overwrote destination bytes.'
    Assert-True (-not [IO.File]::Exists($freshState)) 'Conflict published a new installer state.'
  } else {
    Assert-True ($retry.ExitCode -eq 0) "Interrupted upgrade retry failed: $($retry.Output)"
    $newRecovery = [IO.File]::ReadAllText($freshState).Trim()
    Assert-True ($newRecovery -ne $oldRecovery) 'Retry reused the previous payload transaction.'
    Assert-True (([IO.File]::ReadAllText($markers[0]).Trim()) -eq $newRecovery) 'Retry did not publish the new transaction marker.'
    $oldRecords = @(Read-FixtureManifest $oldManifest)
    Assert-True ($oldRecords[-1].status -eq 'restore-complete') 'Retry did not finish the previous workspace restore.'
    $records = @(Read-FixtureManifest ([IO.Path]::Combine($newRecovery, 'manifest.jsonl')))
    $newApp = @($records | Where-Object { $_.status -eq 'planned' -and $_.original -eq $appFile })[0].backup
    Assert-True ((Get-FixtureHash $newApp) -eq $repopulatedHash) 'Retry did not preserve the current payload in the new transaction.'
    $again = Invoke-Recovery 'Prepare' $freshState $install
    Assert-True ($again.ExitCode -eq 0) "Repeated prepared retry failed: $($again.Output)"
    Assert-True (([IO.File]::ReadAllText($freshState).Trim()) -eq $newRecovery) 'Idempotent Prepare changed the transaction.'
    Write-FixtureFile $appFile 'final installed app'
    $restored = Invoke-Recovery 'Restore' $freshState
    Assert-True ($restored.ExitCode -eq 0) "Final Restore failed: $($restored.Output)"
    Assert-True ([IO.File]::ReadAllText($appFile) -eq 'final installed app') 'Restore changed the new application.'
    if ($Workspace) { Assert-True ((Get-FixtureHash $workspaceFile) -eq $workspaceHash) 'Retry lost workspace data across the two transactions.' }
    Assert-True (-not [IO.File]::Exists($markers[0])) 'Final Restore did not clear the active marker.'
  }
  return [pscustomobject]@{ case = $CaseName; passed = $true; priorBackupPreserved = $true; workspaceConflictBlocked = $Conflict }
}

function Test-PayloadExtras([string]$Mode) {
  $caseName = 'payload-extras-' + $Mode
  $caseRoot = [IO.Path]::Combine($fixtureRoot, $caseName)
  $install = [IO.Path]::Combine($caseRoot, 'fake-install')
  $state = [IO.Path]::Combine($caseRoot, 'plugin-state.txt')
  $resources = [IO.Path]::Combine($install, 'resources')
  $outside = [IO.Path]::Combine($caseRoot, 'outside-link-target')
  Write-FixtureFile "$install\Uninstall Nuwax.exe" 'NOT AN EXECUTABLE: fixture only'
  Write-FixtureFile "$install\Nuwax.exe" 'old application'
  Write-FixtureFile "$resources\app.asar" 'old archive stays backed up'
  Write-FixtureFile "$resources\a-first.txt" 'first returned file'
  Write-FixtureFile "$resources\user-added.txt" 'user file inside payload directory'
  Write-FixtureFile "$resources\nested\shared\user.bin" 'nested user bytes'
  Write-FixtureFile "$resources\file-conflict.txt" 'old colliding bytes'
  Write-FixtureFile "$resources\type-conflict\old.bin" 'old directory bytes'
  Write-FixtureFile "$resources\z-locked.txt" 'retry returns locked bytes'
  Write-FixtureFile "$resources\own-workspace\note.txt" 'directory with reserved filename'
  [IO.File]::WriteAllText("\\?\$resources\own-workspace\nul", 'reserved device-name bytes')
  Write-FixtureFile "$install\locales\custom\user.txt" 'custom locale directory'
  Write-FixtureFile "$outside\outside.txt" 'outside bytes must remain unchanged'
  if ($Mode -eq 'links') {
    Write-FixtureFile "$resources\linked-destination\user.bin" 'must remain in backup, not outside'
    $null = & cmd.exe /d /c mklink /J "$resources\source-link" $outside
    Assert-True ($LASTEXITCODE -eq 0) 'Could not create source junction fixture.'
  }

  $prepared = Invoke-Recovery 'Prepare' $state $install
  Assert-True ($prepared.ExitCode -eq 0) "Payload fixture Prepare failed: $($prepared.Output)"
  $recovery = [IO.File]::ReadAllText($state).Trim()
  $manifest = "$recovery\manifest.jsonl"
  $plans = @(Read-FixtureManifest $manifest | Where-Object { $_.status -eq 'planned' })
  $resourcePlan = @($plans | Where-Object { $_.original -eq $resources })[0]
  $backup = [string]$resourcePlan.backup
  Write-FixtureFile "$install\Nuwax.exe" 'new application must not change'
  Write-FixtureFile "$resources\app.asar" 'new archive must not change'
  Write-FixtureFile "$resources\nested\shared\new.bin" 'new nested payload'
  Write-FixtureFile "$resources\file-conflict.txt" 'new colliding bytes'
  Write-FixtureFile "$resources\type-conflict" 'new file wins over old directory'
  Write-FixtureFile "$install\locales\new.pak" 'new locale payload'
  if ($Mode -eq 'links') {
    $null = & cmd.exe /d /c mklink /J "$resources\linked-destination" $outside
    Assert-True ($LASTEXITCODE -eq 0) 'Could not create destination junction fixture.'
  }
  if ($Mode -in @('interrupted', 'failure')) {
    # Simulate process loss after an atomic nested rename and before its
    # completion record, using the same durable intent as the implementation.
    $intent = [ordered]@{ status = 'payload-restore-intent'; original = "$resources\a-first.txt"; backup = "$backup\a-first.txt" }
    [IO.File]::AppendAllText($manifest, (($intent | ConvertTo-Json -Compress) + [Environment]::NewLine))
    [IO.File]::Move("$backup\a-first.txt", "$resources\a-first.txt")
    $freshState = "$caseRoot\fresh-plugin-state.txt"
    $blocked = Invoke-Recovery 'Prepare' $freshState $install
    Assert-True ($blocked.ExitCode -ne 0 -and $blocked.Output.Contains('unfinished Restore/Rollback')) 'New Prepare ignored partial nested restoration.'
    Assert-True (-not [IO.File]::Exists($freshState)) 'Blocked Prepare wrote a new transaction.'
  }
  if ($Mode -eq 'failure') {
    $lock = [IO.File]::Open("$backup\z-locked.txt", [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    try {
      $failed = Invoke-Recovery 'Restore' $state
      Assert-True ($failed.ExitCode -ne 0) 'Locked nested file did not stop restoration.'
      Assert-True ([IO.File]::Exists("$backup\z-locked.txt")) 'Locked nested file was lost.'
      Assert-True (@([IO.Directory]::GetFiles($caseRoot, 'Nuwax-installer-recovery-active-*.txt')).Count -eq 1) 'Failed restore cleared recovery marker.'
    } finally { $lock.Dispose() }
  }
  $restored = Invoke-Recovery 'Restore' $state
  Assert-True ($restored.ExitCode -eq 0) "Payload extras Restore failed: $($restored.Output)"
  Assert-True ([IO.File]::Exists("$resources\user-added.txt")) 'Payload-directory user file was not restored in place.'
  Assert-True ([IO.File]::ReadAllText("$resources\user-added.txt") -eq 'user file inside payload directory') 'Payload-directory user file was not restored in place.'
  Assert-True ([IO.File]::ReadAllText("$resources\a-first.txt") -eq 'first returned file') 'Interrupted returned entry changed.'
  Assert-True ([IO.File]::ReadAllText("$resources\nested\shared\user.bin") -eq 'nested user bytes') 'Deep shared-directory file was not restored.'
  Assert-True ([IO.File]::ReadAllText("$resources\nested\shared\new.bin") -eq 'new nested payload') 'New nested payload changed.'
  Assert-True ([IO.File]::ReadAllText("\\?\$resources\own-workspace\nul") -eq 'reserved device-name bytes') 'Reserved filename was lost during subtree restore.'
  Assert-True ([IO.File]::ReadAllText("$install\locales\custom\user.txt") -eq 'custom locale directory') 'Locale-directory user files were not restored.'
  Assert-True ([IO.File]::ReadAllText("$resources\z-locked.txt") -eq 'retry returns locked bytes') 'Retry failed to restore locked entry.'
  Assert-True ([IO.File]::ReadAllText("$install\Nuwax.exe") -eq 'new application must not change') 'New application changed.'
  Assert-True ([IO.File]::ReadAllText("$resources\app.asar") -eq 'new archive must not change') 'New archive was overwritten.'
  Assert-True ([IO.File]::ReadAllText("$backup\app.asar") -eq 'old archive stays backed up') 'Old application backup changed.'
  Assert-True ([IO.File]::ReadAllText("$resources\file-conflict.txt") -eq 'new colliding bytes') 'Existing file was overwritten.'
  Assert-True ([IO.File]::ReadAllText("$backup\file-conflict.txt") -eq 'old colliding bytes') 'Colliding backup was lost.'
  Assert-True ([IO.File]::ReadAllText("$resources\type-conflict") -eq 'new file wins over old directory') 'Type conflict overwrote new file.'
  Assert-True ([IO.File]::ReadAllText("$backup\type-conflict\old.bin") -eq 'old directory bytes') 'Type conflict lost old directory.'
  Assert-True ([IO.File]::ReadAllText("$outside\outside.txt") -eq 'outside bytes must remain unchanged') 'Link target was changed.'
  if ($Mode -eq 'links') {
    Assert-True (([IO.File]::GetAttributes("$resources\source-link") -band [IO.FileAttributes]::ReparsePoint) -ne 0) 'Missing source link was not restored as a link.'
    Assert-True (-not [IO.File]::Exists("$outside\user.bin")) 'Restore followed a destination junction.'
    Assert-True ([IO.File]::ReadAllText("$backup\linked-destination\user.bin") -eq 'must remain in backup, not outside') 'Linked destination lost its preserved source.'
  }
  $again = Invoke-Recovery 'Restore' $state
  Assert-True ($again.ExitCode -eq 0) "Repeated payload Restore failed: $($again.Output)"
  Assert-True ([IO.File]::ReadAllText("$resources\user-added.txt") -eq 'user file inside payload directory') 'Repeated restore changed returned bytes.'
  Assert-True (@([IO.Directory]::GetFiles($caseRoot, 'Nuwax-installer-recovery-active-*.txt')).Count -eq 0) 'Completed restore kept active marker.'
  return [pscustomobject]@{ case = $caseName; passed = $true; missingEntriesRestoredInPlace = $true; newPayloadPreserved = $true; collisionBackupsRetained = $true }
}

try {
  $cases = @(
    (Test-RestoreConflict 'all-conflicts' $false),
    (Test-RestoreConflict 'partial-restore' $true),
    (Test-InterruptedUpgrade 'interrupted-app-only' $false $false),
    (Test-InterruptedUpgrade 'interrupted-with-workspace' $true $false),
    (Test-InterruptedUpgrade 'interrupted-workspace-conflict' $true $true),
    (Test-InterruptedUpgrade 'interrupted-incomplete-prepare' $true $false $false),
    (Test-PayloadExtras 'basic'),
    (Test-PayloadExtras 'interrupted'),
    (Test-PayloadExtras 'failure'),
    (Test-PayloadExtras 'links')
  )
} finally {
  if (-not $KeepFixture) {
    # Cleanup is confined to the unique directory created above and its owner
    # sentinel. No install directory, registry entry, or user profile is used.
    Assert-True ([IO.Path]::GetDirectoryName($fixtureRoot) -eq $tempParent) 'Refusing cleanup outside the fixture parent.'
    Assert-True ([IO.Path]::GetFileName($fixtureRoot) -eq $fixtureName) 'Refusing cleanup of a different directory.'
    Assert-True ([IO.File]::ReadAllText($ownerFile) -eq $fixtureName) 'Fixture owner sentinel does not match.'
    Remove-FixtureTree ('\\?\' + $fixtureRoot)
  }
}
[pscustomobject]@{ success = $true; cases = $cases; fixtureRetained = [bool]$KeepFixture; fixturePath = $fixtureRoot; installerExecuted = $false; registryTouched = $false } | ConvertTo-Json -Depth 5
