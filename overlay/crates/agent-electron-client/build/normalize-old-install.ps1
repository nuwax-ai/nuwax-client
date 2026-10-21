param(
  [ValidateSet('Prepare', 'Reconcile', 'Detach', 'Restore', 'Rollback', 'RecordPayload', 'Cleanup', 'RestoreRegistration')][string]$Action = 'Prepare',
  [string]$InstallDir,
  [Alias('RecoveryPathFile')][Parameter(Mandatory = $true)][string]$StatePath,
  [string]$PayloadInventoryPath,
  [switch]$CleanupRuntime,
  [switch]$Repair,
  [switch]$AllowMissingUninstaller,
  [long]$RequiredSpaceKB = 0,
  [ValidateSet('CurrentUser', 'LocalMachine')][string]$RegistryScope = 'CurrentUser',
  [string]$InstallRegistryKey,
  [string]$UninstallRegistryKey
)

# The old electron-builder uninstaller recursively removes InstallDir. Preserve
# every old top-level entry by renaming it to a sibling on the same volume before
# the uninstaller starts. Moving a parent also preserves nested reserved device
# names and trailing dots/spaces without enumerating those paths.
$ErrorActionPreference = 'Stop'
trap {
  $failure = [ordered]@{ atUtc = [DateTime]::UtcNow.ToString('o'); action = $Action; installDir = $InstallDir;
    scope = $RegistryScope; state = $StatePath; error = $_.Exception.Message; category = [string]$_.CategoryInfo.Category;
    errorId = $_.FullyQualifiedErrorId; exceptionType = $_.Exception.GetType().FullName }
  try { [IO.File]::AppendAllText((Join-Path ([IO.Path]::GetTempPath()) 'Nuwax-installer-recovery-events.jsonl'), ($failure | ConvertTo-Json -Compress) + [Environment]::NewLine) } catch { }
  [Console]::Error.WriteLine(($failure | ConvertTo-Json -Compress))
  exit 1
}
$uninstallerName = 'Uninstall Nuwax.exe'
# Known payload files stay in recovery. Payload directories can also contain
# user files; restore missing descendants without replacing the new payload.
$appEntryNames = @(
  'Nuwax.exe',
  'locales',
  'resources',
  'chrome_100_percent.pak',
  'chrome_200_percent.pak',
  'd3dcompiler_47.dll',
  'dxcompiler.dll',
  'dxil.dll',
  'ffmpeg.dll',
  'icudtl.dat',
  'libEGL.dll',
  'libGLESv2.dll',
  'LICENSE.electron.txt',
  'LICENSES.chromium.html',
  'resources.pak',
  'snapshot_blob.bin',
  'v8_context_snapshot.bin',
  'vk_swiftshader.dll',
  'vk_swiftshader_icd.json',
  'vulkan-1.dll'
)
$utf8 = [System.Text.UTF8Encoding]::new($false)
$pathComparison = [System.StringComparison]::OrdinalIgnoreCase

function Get-ExtendedPath([string]$Path) {
  return '\\?\' + $Path
}

function Test-EntryExists([string]$Path) {
  try {
    [System.IO.File]::GetAttributes($Path) | Out-Null
    return $true
  } catch [System.IO.FileNotFoundException] {
    return $false
  } catch [System.IO.DirectoryNotFoundException] {
    return $false
  }
}

function Get-RecoveryHash([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $hash = [Security.Cryptography.SHA256]::Create()
  try { return [Convert]::ToBase64String($hash.ComputeHash($stream)) }
  finally { $hash.Dispose(); $stream.Dispose() }
}

function Assert-NoRecoveryRedirect([string]$Path) {
  for ($current = $Path; $current; $current = [IO.Path]::GetDirectoryName($current)) {
    if ((Test-EntryExists $current) -and
        (([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
      throw "Recovery path is redirected: $current"
    }
  }
}

function Archive-RecoveryPointers([string]$Reason) {
  # Leave every backup byte in place. The archived pointer is diagnostic data,
  # not a completed transaction and never qualifies for retention cleanup.
  $archive = $marker + '.archived-' + [Guid]::NewGuid().ToString('N')
  $report = [ordered]@{ reason = $Reason; action = $Action; installDir = $root;
    recoveryDir = $recoveryDir; observedAtUtc = [DateTime]::UtcNow.ToString('o') }
  [IO.File]::WriteAllText((Get-ExtendedPath ($archive + '.json')), ($report | ConvertTo-Json -Compress), $utf8)
  if (Test-EntryExists $extendedMarker) { [IO.File]::Move($extendedMarker, (Get-ExtendedPath ($archive + '.pointer'))) }
  if (Test-EntryExists $stateFile) { [IO.File]::Delete($stateFile) }
  Write-Output "RECOVERY_WARNING $Reason; previous backup cannot be restored automatically: $recoveryDir; diagnostic=$archive.json"
}

function Save-RegistrationSnapshot {
  if (-not $InstallRegistryKey -and -not $UninstallRegistryKey) { return }
  $snapshotPath = [IO.Path]::Combine((Get-ExtendedPath $recoveryDir), 'registration.json')
  if (Test-EntryExists $snapshotPath) { return }
  $hive = [Microsoft.Win32.RegistryHive]::$RegistryScope
  $view = if ([Environment]::Is64BitOperatingSystem) { [Microsoft.Win32.RegistryView]::Registry64 } else { [Microsoft.Win32.RegistryView]::Registry32 }
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
  try {
    $keys = @()
    foreach ($name in @($InstallRegistryKey, $UninstallRegistryKey)) {
      if (-not $name -or $name -notmatch '^Software\\' -or $name -match '[\r\n]') { throw 'Invalid product registration key.' }
      $key = $base.OpenSubKey($name, $false)
      try {
        $values = @()
        if ($key) {
          foreach ($value in $key.GetValueNames()) {
            $values += @{ name = $value; kind = [string]$key.GetValueKind($value);
              value = $key.GetValue($value, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
          }
        }
        $keys += @{ path = $name; existed = [bool]$key; values = $values }
      } finally { if ($key) { $key.Dispose() } }
    }
    [IO.File]::WriteAllText($snapshotPath, (@{ scope = $RegistryScope; view = [string]$view; keys = $keys } | ConvertTo-Json -Depth 8), $utf8)
    Add-ManifestRecord $manifestPath ([ordered]@{ status = 'registration-snapshot-recorded'; sha256 = (Get-RecoveryHash $snapshotPath) })
  } finally { $base.Dispose() }
}

function Restore-RegistrationSnapshot {
  $snapshotPath = [IO.Path]::Combine((Get-ExtendedPath $recoveryDir), 'registration.json')
  if (-not (Test-EntryExists $snapshotPath)) { return }
  $proof = @($records | Where-Object { $_.status -eq 'registration-snapshot-recorded' })
  if (-not $proof.Count -or (Get-RecoveryHash $snapshotPath) -ne $proof[-1].sha256) { throw 'Registration snapshot was changed or is incomplete.' }
  if (-not $InstallRegistryKey -or -not $UninstallRegistryKey) { throw 'Rollback requires the original product registry keys.' }
  $snapshot = [IO.File]::ReadAllText($snapshotPath, $utf8) | ConvertFrom-Json
  if ($snapshot.scope -ne $RegistryScope -or $snapshot.keys.Count -ne 2) { throw 'Registration snapshot scope does not match this operation.' }
  $hive = [Microsoft.Win32.RegistryHive]::$RegistryScope
  $view = if ([Environment]::Is64BitOperatingSystem) { [Microsoft.Win32.RegistryView]::Registry64 } else { [Microsoft.Win32.RegistryView]::Registry32 }
  if ($snapshot.view -ne [string]$view) { throw 'Registration snapshot view does not match this operation.' }
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
  try {
    foreach ($entry in $snapshot.keys) {
      if ($entry.path -notin @($InstallRegistryKey, $UninstallRegistryKey)) { throw 'Registration snapshot contains a different product key.' }
      if (-not $entry.existed) { continue }
      $key = $base.CreateSubKey([string]$entry.path)
      try {
        foreach ($item in $entry.values) {
          $kind = [Microsoft.Win32.RegistryValueKind]::$($item.kind)
          $value = $item.value
          if ($kind -eq [Microsoft.Win32.RegistryValueKind]::DWord) { $value = [int]$value }
          elseif ($kind -eq [Microsoft.Win32.RegistryValueKind]::QWord) { $value = [long]$value }
          elseif ($kind -eq [Microsoft.Win32.RegistryValueKind]::Binary) { $value = [byte[]]$value }
          elseif ($kind -eq [Microsoft.Win32.RegistryValueKind]::MultiString) { $value = [string[]]$value }
          $key.SetValue([string]$item.name, $value, $kind)
        }
      } finally { $key.Dispose() }
    }
  } finally { $base.Dispose() }
}

function Add-ManifestRecord([string]$ManifestPath, [object]$Record) {
  $line = ($Record | ConvertTo-Json -Compress) + [Environment]::NewLine
  $bytes = $utf8.GetBytes($line)
  $stream = [System.IO.FileStream]::new(
    $ManifestPath,
    [System.IO.FileMode]::Append,
    [System.IO.FileAccess]::Write,
    [System.IO.FileShare]::Read,
    4096,
    [System.IO.FileOptions]::WriteThrough
  )
  try {
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally {
    $stream.Dispose()
  }
}

function Write-AtomicText([string]$Path, [string]$Value) {
  if ([System.IO.File]::Exists($Path)) {
    $existing = [System.IO.File]::ReadAllText($Path, $utf8).Trim()
    if (-not [string]::Equals($existing, $Value, $pathComparison)) {
      throw "Recovery state points to a different directory: $Path"
    }
    return
  }
  $temporary = $Path + '.tmp-' + [System.Guid]::NewGuid().ToString('N')
  try {
    [System.IO.File]::WriteAllText($temporary, $Value + [Environment]::NewLine, $utf8)
    [System.IO.File]::Move($temporary, $Path)
  } finally {
    if ([System.IO.File]::Exists($temporary)) {
      [System.IO.File]::Delete($temporary)
    }
  }
}

function Read-Manifest([string]$ManifestPath) {
  $plain = if ($ManifestPath.StartsWith('\\?\')) { $ManifestPath.Substring(4) } else { $ManifestPath }
  Assert-NoRecoveryRedirect $plain
  $records = New-Object 'System.Collections.Generic.List[object]'
  foreach ($line in [System.IO.File]::ReadAllLines($ManifestPath, $utf8)) {
    if (-not [string]::IsNullOrWhiteSpace($line)) {
      $records.Add(($line | ConvertFrom-Json))
    }
  }
  return ,$records
}

function Move-Entry([string]$Source, [string]$Destination, [bool]$IsDirectory) {
  if ($IsDirectory) {
    [System.IO.Directory]::Move($Source, $Destination)
  } else {
    [System.IO.File]::Move($Source, $Destination)
  }
}

function Restore-PayloadExtras([string]$Source, [string]$Destination) {
  $extendedSource = Get-ExtendedPath $Source
  $extendedDestination = Get-ExtendedPath $Destination
  if (-not (Test-EntryExists $extendedSource)) { return }
  $sourceAttributes = [System.IO.File]::GetAttributes($extendedSource)
  $isDirectory = ($sourceAttributes -band [System.IO.FileAttributes]::Directory) -ne 0
  if (-not (Test-EntryExists $extendedDestination)) {
    # Rename a missing subtree atomically, including links and reserved names.
    # A retry scans the remaining backup, so an interrupted rename is not
    # repeated and never needs to overwrite the returned entry.
    Add-ManifestRecord $manifestPath ([ordered]@{ status = 'payload-restore-intent'; original = $Destination; backup = $Source })
    Move-Entry $extendedSource $extendedDestination $isDirectory
    Add-ManifestRecord $manifestPath ([ordered]@{ status = 'payload-restored'; original = $Destination; backup = $Source })
    $script:payloadRestored++
    return
  }
  $destinationAttributes = [System.IO.File]::GetAttributes($extendedDestination)
  if (-not $isDirectory -or
      ($sourceAttributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
      ($destinationAttributes -band [System.IO.FileAttributes]::Directory) -eq 0 -or
      ($destinationAttributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    # Existing files, type conflicts and linked directories belong to the new
    # install. Keep their old counterparts in recovery; never traverse a link.
    $script:payloadCollisions++
    return
  }
  foreach ($entry in [System.IO.Directory]::GetFileSystemEntries($extendedSource)) {
    $name = [System.IO.Path]::GetFileName($entry)
    Restore-PayloadExtras ($entry.Substring(4)) ([System.IO.Path]::Combine($Destination, $name))
  }
}

function Get-MarkerPath([string]$Root) {
  $hash = [System.Security.Cryptography.SHA256]::Create()
  try {
    $rootHash = [System.BitConverter]::ToString(
      $hash.ComputeHash($utf8.GetBytes($Root.ToUpperInvariant())),
      0,
      12
    ).Replace('-', '').ToLowerInvariant()
  } finally {
    $hash.Dispose()
  }
  return [System.IO.Path]::Combine(
    [System.IO.Path]::GetDirectoryName($Root),
    "Nuwax-installer-recovery-active-$rootHash.txt"
  )
}

$script:recoveryRuntimePath = $PSCommandPath
. (Join-Path $PSScriptRoot 'installer-backup-retention.ps1')
if ($CleanupRuntime -and $Action -ne 'Cleanup') { throw 'CleanupRuntime is only valid for background cleanup.' }

$statePathFull = [System.IO.Path]::GetFullPath($StatePath)
$stateFile = Get-ExtendedPath $statePathFull
$fromState = $null
Assert-NoRecoveryRedirect $statePathFull
if (Test-EntryExists $stateFile) {
  $fromState = [System.IO.File]::ReadAllText($stateFile, $utf8).Trim()
}
$records = $null
$recoveryDir = $fromState

if ($Action -in @('Prepare', 'Reconcile', 'RecordPayload', 'Cleanup')) {
  if (-not $InstallDir) {
    throw "$Action requires InstallDir."
  }
  $root = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd([char]92)
} else {
  if (-not $recoveryDir) {
    Write-Output 'No recovery state; nothing to restore.'
    exit 0
  }
  $recoveryDir = [System.IO.Path]::GetFullPath($recoveryDir).TrimEnd([char]92)
  $manifestPath = [System.IO.Path]::Combine((Get-ExtendedPath $recoveryDir), 'manifest.jsonl')
  if (-not [System.IO.File]::Exists($manifestPath)) {
    throw "Recovery manifest is missing: $recoveryDir"
  }
  $records = Read-Manifest $manifestPath
  if ($records.Count -eq 0 -or $records[0].status -ne 'start' -or -not $records[0].installDir) {
    throw 'Recovery manifest has no installation directory.'
  }
  $root = [System.IO.Path]::GetFullPath([string]$records[0].installDir).TrimEnd([char]92)
  if ($InstallDir -and -not [string]::Equals([System.IO.Path]::GetFullPath($InstallDir).TrimEnd([char]92), $root, $pathComparison)) {
    throw 'Supplied installation directory disagrees with recovery manifest.'
  }
}

$volumeRoot = [System.IO.Path]::GetPathRoot($root)
if ($root -eq $volumeRoot.TrimEnd([char]92)) {
  throw 'Refusing to inspect a volume root as an application directory.'
}
if ($root -notmatch '^[A-Za-z]:\\') {
  throw 'Only a local installation directory can be preserved safely.'
}
$extendedRoot = Get-ExtendedPath $root
$parent = [System.IO.Path]::GetDirectoryName($root)
Assert-NoRecoveryRedirect $root
$drive = [IO.DriveInfo]::new($volumeRoot)
if (-not $drive.IsReady -or $drive.DriveType -ne [IO.DriveType]::Fixed) { throw 'Installation drive is not an available fixed local drive.' }
if ($RequiredSpaceKB -lt 0) { throw 'Invalid required space.' }
if ($Action -eq 'Prepare' -and $RequiredSpaceKB -gt 0 -and ($drive.AvailableFreeSpace / 1KB) -lt $RequiredSpaceKB) {
  throw 'Insufficient free space for the complete repair payload.'
}
if ($statePathFull.StartsWith($root + '\', $pathComparison)) {
  throw 'Recovery state must be outside the installation directory.'
}

$marker = Get-MarkerPath $root
$extendedMarker = Get-ExtendedPath $marker
$recoveryMutex = [Threading.Mutex]::new($false, ('Global\NuwaxInstallerRecovery-' + [IO.Path]::GetFileNameWithoutExtension($marker)))
$mutexHeld = $false
try { $mutexHeld = $recoveryMutex.WaitOne(30000) }
catch [Threading.AbandonedMutexException] { $mutexHeld = $true }
if (-not $mutexHeld) { $recoveryMutex.Dispose(); throw 'Another recovery operation is active for this installation.' }
try {

if ($Action -eq 'Cleanup') {
  Invoke-RecoveryRetention $root
  exit 0
}

# StatePath lives in NSIS PLUGINSDIR. The sibling marker survives a process
# restart, while the JSONL manifest inside recovery records each individual
# intent before its rename.
$fromMarker = $null
if (Test-EntryExists $extendedMarker) {
  Assert-NoRecoveryRedirect $marker
  $fromMarker = [System.IO.File]::ReadAllText($extendedMarker, $utf8).Trim()
  if (-not $fromMarker) {
    if ($Repair -and $Action -eq 'Prepare') {
      Archive-RecoveryPointers 'empty-persistent-marker'
      $fromState = $null
    } else { throw 'Persistent recovery marker is empty. Use the complete installer repair option.' }
  }
}
if ($fromState -and $fromMarker -and -not [string]::Equals($fromState, $fromMarker, $pathComparison)) {
  throw 'Installer state and persistent recovery marker disagree.'
}
$recoveryDir = if ($fromState) { $fromState } else { $fromMarker }
$manifestPath = $null
$plans = New-Object 'System.Collections.Generic.List[object]'
$planByOriginal = [System.Collections.Generic.Dictionary[string,object]]::new([System.StringComparer]::OrdinalIgnoreCase)
$usedBackups = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$restoredWorkspaces = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$restoreIntents = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

if ($recoveryDir) {
  $recoveryDir = [System.IO.Path]::GetFullPath($recoveryDir).TrimEnd([char]92)
  if (-not [string]::Equals([System.IO.Path]::GetDirectoryName($recoveryDir), $parent, $pathComparison) -or
      -not [System.IO.Path]::GetFileName($recoveryDir).StartsWith('Nuwax-installer-recovery-', $pathComparison)) {
    throw 'Recovery state does not point to a sibling recovery directory.'
  }
  $manifestPath = [System.IO.Path]::Combine((Get-ExtendedPath $recoveryDir), 'manifest.jsonl')
  Assert-NoRecoveryRedirect $recoveryDir
  $backupExists = Test-EntryExists (Get-ExtendedPath $recoveryDir)
  if ($Action -in @('Prepare', 'Reconcile') -and -not $backupExists) {
    Archive-RecoveryPointers 'backup-missing'
    $recoveryDir = $null
    $manifestPath = $null
    $records = $null
  } elseif ($Repair -and $Action -eq 'Prepare') {
    if (Test-EntryExists $manifestPath) {
      # Read errors remain fatal. Only JSON decoding can be bypassed by an
      # explicit repair, and a readable foreign transaction is never adopted.
      $lines = [IO.File]::ReadAllLines($manifestPath, $utf8)
      $header = $null
      if ($lines.Count) { try { $header = $lines[0] | ConvertFrom-Json } catch { } }
      if ($header -and $header.status -eq 'start' -and
          (-not [string]::Equals($header.installDir, $root, $pathComparison) -or
           -not [string]::Equals($header.recoveryDir, $recoveryDir, $pathComparison))) {
        throw 'Recovery manifest belongs to a different installation.'
      }
    }
    Archive-RecoveryPointers 'explicit-repair-protected-previous-backup'
    $recoveryDir = $null
    $manifestPath = $null
    $records = $null
  } elseif (-not (Test-EntryExists $manifestPath)) {
    throw "Recovery manifest is missing: $recoveryDir. Use the complete installer repair option; the backup was retained."
  }
}

if ($recoveryDir) {
  if ($null -eq $records) {
    $records = Read-Manifest $manifestPath
  }
  if ($records.Count -eq 0 -or $records[0].status -ne 'start' -or
      -not [string]::Equals($records[0].installDir, $root, $pathComparison) -or
      -not [string]::Equals($records[0].recoveryDir, $recoveryDir, $pathComparison)) {
    throw 'Recovery manifest does not match this installation.'
  }

  foreach ($record in $records) {
    if ($record.status -eq 'planned') {
      $original = [string]$record.original
      $backup = [string]$record.backup
      if (-not [string]::Equals([System.IO.Path]::GetDirectoryName($original), $root, $pathComparison) -or
          -not [string]::Equals([System.IO.Path]::GetDirectoryName($backup), $recoveryDir, $pathComparison) -or
          [string]::Equals([System.IO.Path]::GetFileName($original), $uninstallerName, $pathComparison) -or
          [System.IO.Path]::GetFileName($backup) -notmatch '^entry-[0-9]{6,}$' -or
          $planByOriginal.ContainsKey($original) -or -not $usedBackups.Add($backup)) {
        throw 'Recovery manifest contains an invalid or duplicate move.'
      }
      $planByOriginal.Add($original, $record)
      $plans.Add($record)
    } elseif ($record.status -eq 'workspace-restored') {
      $restoredWorkspaces.Add([string]$record.original) | Out-Null
    } elseif ($record.status -eq 'workspace-restore-intent') {
      $restoreIntents.Add([string]$record.original) | Out-Null
    }
  }
}

if ($Action -eq 'RestoreRegistration') {
  if (-not $recoveryDir) { throw 'No prepared registration snapshot.' }
  Restore-RegistrationSnapshot
  $originalUninstaller = [IO.Path]::Combine($extendedRoot, $uninstallerName)
  $savedUninstaller = [IO.Path]::Combine((Get-ExtendedPath $recoveryDir), 'uninstaller-backup.exe')
  if (-not (Test-EntryExists $originalUninstaller) -and (Test-EntryExists $savedUninstaller)) {
    [IO.Directory]::CreateDirectory($extendedRoot) | Out-Null
    [IO.File]::Copy($savedUninstaller, $originalUninstaller, $false)
  }
  Write-Output 'Original registration restored; file recovery remains available.'
  exit 0
}

if ($Action -eq 'Detach') {
  if (-not $recoveryDir -or @($records | Where-Object { $_.status -eq 'complete' }).Count -eq 0) {
    throw 'Cannot retire an old uninstaller without completed preservation.'
  }
  # A failed legacy uninstaller is never given permission to delete unknown
  # content. Prepare must have moved every other top-level entry out first.
  if (Test-EntryExists $extendedRoot) {
    foreach ($entry in [IO.Directory]::GetFileSystemEntries($extendedRoot)) {
      if ([IO.Path]::GetFileName($entry) -cne $uninstallerName) { throw 'Installation was repopulated after preservation; refusing old-uninstaller fallback.' }
      $attributes = [IO.File]::GetAttributes($entry)
      if (($attributes -band ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint)) -ne 0) { throw 'Old uninstaller is not a regular file.' }
      $backup = [IO.Path]::Combine((Get-ExtendedPath $recoveryDir), 'uninstaller-backup.exe')
      if (-not (Test-EntryExists $backup) -or (Get-RecoveryHash $entry) -ne (Get-RecoveryHash $backup)) {
        throw 'Old uninstaller changed after preservation.'
      }
      [IO.File]::Delete($entry)
    }
  }
  Add-ManifestRecord $manifestPath ([ordered]@{ status = 'old-uninstaller-detached'; observedAtUtc = [DateTime]::UtcNow.ToString('o') })
  Write-Output 'Preserved installation is ready for complete-payload repair; old registration is retained until replacement.'
  exit 0
}

if ($Action -eq 'RecordPayload') {
  if ($recoveryDir) {
    if (-not $PayloadInventoryPath) { throw 'RecordPayload requires an embedded inventory.' }
    Save-RecoveryPayloadInventory $PayloadInventoryPath
  }
  exit 0
}

$needsRollback = $Action -in @('Prepare', 'Reconcile') -and $recoveryDir -and
  (@($records | Where-Object { $_.status -eq 'complete' }).Count -eq 0 -or
   (@($records | Where-Object { $_.status -eq 'rolled-back' }).Count -gt 0 -and
    @($records | Where-Object { $_.status -eq 'rollback-complete' }).Count -eq 0))
if ($Action -eq 'Rollback' -or $needsRollback) {
  if (-not $recoveryDir) {
    exit 0
  }
  if ([System.IO.Directory]::Exists($extendedRoot)) {
    if (([System.IO.File]::GetAttributes($extendedRoot) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Refusing to roll back into an installation directory that is a reparse point.'
    }
  } else {
    [System.IO.Directory]::CreateDirectory($extendedRoot) | Out-Null
  }

  $returned = 0
  $conflicts = 0
  $missing = 0
  $moveFailures = New-Object 'System.Collections.Generic.List[string]'
  for ($index = $plans.Count - 1; $index -ge 0; $index--) {
    $plan = $plans[$index]
    $original = [string]$plan.original
    $source = Get-ExtendedPath ([string]$plan.backup)
    $destination = Get-ExtendedPath $original
    $backupExists = Test-EntryExists $source
    $originalExists = Test-EntryExists $destination
    if ($backupExists -and $originalExists) {
      $conflicts++
      continue
    }
    if (-not $backupExists) {
      if (-not $originalExists) {
        $missing++
      }
      continue
    }

    try {
      Move-Entry $source $destination ([bool]$plan.directory)
      Add-ManifestRecord $manifestPath ([ordered]@{ status = 'rolled-back'; original = $original })
      $returned++
    } catch {
      $moveFailures.Add("$original`: $($_.Exception.Message)")
    }
  }

  $uninstaller = [System.IO.Path]::Combine($extendedRoot, $uninstallerName)
  $uninstallerBackup = [System.IO.Path]::Combine((Get-ExtendedPath $recoveryDir), 'uninstaller-backup.exe')
  $uninstallerPresent = [System.IO.File]::Exists($uninstaller)
  if (-not $uninstallerPresent -and [System.IO.File]::Exists($uninstallerBackup)) {
    try {
      [System.IO.File]::Copy($uninstallerBackup, $uninstaller, $false)
      Add-ManifestRecord $manifestPath ([ordered]@{ status = 'uninstaller-restored'; original = $root + '\' + $uninstallerName })
      $uninstallerPresent = $true
    } catch {
      $moveFailures.Add("Uninstaller: $($_.Exception.Message)")
    }
  }
  $originalHadUninstaller = @($records | Where-Object { $_.status -eq 'uninstaller-backed-up' }).Count -gt 0
  if ($conflicts -eq 0 -and $missing -eq 0 -and $moveFailures.Count -eq 0 -and ($uninstallerPresent -or -not $originalHadUninstaller)) {
    Restore-RegistrationSnapshot
    Add-ManifestRecord $manifestPath ([ordered]@{ status = 'rollback-complete'; returned = $returned; completedAtUtc = [DateTime]::UtcNow.ToString('o') })
    if ([System.IO.File]::Exists($extendedMarker)) {
      [System.IO.File]::Delete($extendedMarker)
    }
    if ([System.IO.File]::Exists($stateFile)) {
      [System.IO.File]::Delete($stateFile)
    }
    Write-Output "Rolled back $returned old installation entries to $root"
    if ($Action -ne 'Prepare') { exit 0 }
    $recoveryDir = $null
    $manifestPath = $null
    $records = $null
    $plans.Clear()
    $planByOriginal.Clear()
    $usedBackups.Clear()
  } else {
    Write-Output "Rollback incomplete: returned=$returned conflicts=$conflicts missing=$missing uninstallerPresent=$uninstallerPresent recovery=$recoveryDir $($moveFailures -join '; ')"
    exit 3
  }
}

$resumeRestoreBeforePrepare = $false
if ($Action -in @('Prepare', 'Reconcile') -and $recoveryDir) {
  $lastTerminal = -1
  $lastPartialRestore = -1
  $lastPrepareChange = -1
  $lastComplete = -1
  for ($index = 0; $index -lt $records.Count; $index++) {
    $status = [string]$records[$index].status
    if ($status -in @('restore-complete', 'rollback-complete')) {
      $lastTerminal = $index
    } elseif ($status -in @('workspace-restore-intent', 'workspace-restored', 'payload-restore-intent', 'payload-restored', 'restore-incomplete')) {
      $lastPartialRestore = $index
    } elseif ($status -in @('planned', 'moved')) {
      $lastPrepareChange = $index
    } elseif ($status -eq 'complete') {
      $lastComplete = $index
    }
  }
  if ($lastTerminal -gt $lastPartialRestore -and $lastTerminal -gt $lastPrepareChange) {
    # A prior Restore/Rollback finished but marker cleanup was interrupted.
    if ([System.IO.File]::Exists($extendedMarker)) {
      [System.IO.File]::Delete($extendedMarker)
    }
    if ([System.IO.File]::Exists($stateFile)) {
      [System.IO.File]::Delete($stateFile)
    }
    $recoveryDir = $null
    $manifestPath = $null
    $plans.Clear()
    $planByOriginal.Clear()
    $usedBackups.Clear()
  } elseif ($lastPartialRestore -ge 0 -or $lastTerminal -ge 0) {
    $resumeRestoreBeforePrepare = $true
  } elseif ($lastComplete -gt $lastPrepareChange) {
    # Prepare completed, but extraction or a later reinstall repopulated the
    # application before Restore ran. Finish the previous workspace restore
    # first, then preserve the current install in a separate transaction.
    # Restore keeps old payload backups and refuses workspace collisions.
    foreach ($plan in $plans) {
      if ($appEntryNames -contains [System.IO.Path]::GetFileName([string]$plan.original)) {
        if (Test-EntryExists (Get-ExtendedPath ([string]$plan.original))) {
          $resumeRestoreBeforePrepare = $true
          break
        }
      }
    }
  }
}

if ($Action -eq 'Restore' -or $resumeRestoreBeforePrepare -or ($Action -eq 'Reconcile' -and $recoveryDir)) {
  if (-not $recoveryDir) {
    exit 0
  }
  if (@($records | Where-Object { $_.status -eq 'rollback-complete' }).Count -gt 0) {
    throw 'Recovery was already rolled back; refusing selective restore.'
  }
  $lastComplete = -1
  $lastPrepareChange = -1
  for ($index = 0; $index -lt $records.Count; $index++) {
    if ($records[$index].status -eq 'complete') {
      $lastComplete = $index
    } elseif ($records[$index].status -in @('planned', 'moved')) {
      $lastPrepareChange = $index
    }
  }
  if ($lastComplete -lt $lastPrepareChange -or $lastComplete -lt 0) {
    throw 'Old installation preservation did not complete; refusing to restore selectively.'
  }
  if ([System.IO.Directory]::Exists($extendedRoot)) {
    if (([System.IO.File]::GetAttributes($extendedRoot) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Refusing to restore into an installation directory that is a reparse point.'
    }
  } else {
    [System.IO.Directory]::CreateDirectory($extendedRoot) | Out-Null
  }
  $restored = 0
  $conflicts = 0
  $script:payloadRestored = 0
  $script:payloadCollisions = 0
  foreach ($plan in $plans) {
    $original = [string]$plan.original
    $name = [System.IO.Path]::GetFileName($original)
    if ($appEntryNames -contains $name) {
      if ([bool]$plan.directory) {
        Restore-PayloadExtras ([string]$plan.backup) $original
      }
      continue
    }

    $source = Get-ExtendedPath ([string]$plan.backup)
    $destination = Get-ExtendedPath $original
    $backupExists = Test-EntryExists $source
    $destinationExists = Test-EntryExists $destination
    if ($backupExists -and $destinationExists) {
      $conflicts++
      continue
    }
    if (-not $backupExists) {
      if ($destinationExists -and ($restoredWorkspaces.Contains($original) -or $restoreIntents.Contains($original))) {
        if (-not $restoredWorkspaces.Contains($original)) {
          Add-ManifestRecord $manifestPath ([ordered]@{ status = 'workspace-restored'; original = $original })
          $restoredWorkspaces.Add($original) | Out-Null
        }
        continue
      }
      throw "Workspace is missing from both recovery and installation: $original"
    }

    # Never merge into or overwrite a path created by the new installation.
    Add-ManifestRecord $manifestPath ([ordered]@{ status = 'workspace-restore-intent'; original = $original })
    Move-Entry $source $destination ([bool]$plan.directory)
    Add-ManifestRecord $manifestPath ([ordered]@{ status = 'workspace-restored'; original = $original })
    $restoredWorkspaces.Add($original) | Out-Null
    $restored++
  }
  if ($conflicts -gt 0) {
    # Keep the marker and unfinished state even when every entry conflicts.
    Add-ManifestRecord $manifestPath ([ordered]@{ status = 'restore-incomplete'; restored = $restored; conflicts = $conflicts })
    Write-Output "Restored $restored non-application entries; $conflicts conflicts remain in $recoveryDir"
    exit 3
  }
  Add-ManifestRecord $manifestPath ([ordered]@{ status = 'restore-complete'; restored = $restored; conflicts = $conflicts; payloadExtrasRestored = $script:payloadRestored; payloadCollisionsRetained = $script:payloadCollisions; completedAtUtc = [DateTime]::UtcNow.ToString('o') })
  if ([System.IO.File]::Exists($extendedMarker)) {
    [System.IO.File]::Delete($extendedMarker)
  }
  Write-Output "Restored $restored non-application entries and $script:payloadRestored missing payload-directory entries; $script:payloadCollisions existing payload paths retained in $recoveryDir"
  if (-not $resumeRestoreBeforePrepare -or $Action -eq 'Reconcile') {
    try { Start-RecoveryRetention $root }
    catch { Write-Output ('Backup retention skipped: ' + $_.Exception.Message) }
    exit 0
  }
  if ([System.IO.File]::Exists($stateFile)) {
    [System.IO.File]::Delete($stateFile)
  }
  $recoveryDir = $null
  $manifestPath = $null
  $plans.Clear()
  $planByOriginal.Clear()
  $usedBackups.Clear()
  $restoredWorkspaces.Clear()
  $restoreIntents.Clear()
}

if ($Action -eq 'Reconcile') { exit 0 }

if (-not (Test-EntryExists $extendedRoot)) {
  if ($recoveryDir) {
    Write-Output "Old installation already preserved in $recoveryDir"
  }
  if (-not $AllowMissingUninstaller) { exit 0 }
  [IO.Directory]::CreateDirectory($extendedRoot) | Out-Null
}
if (([System.IO.File]::GetAttributes($extendedRoot) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'Refusing to inspect an installation directory that is a reparse point.'
}
$uninstaller = [System.IO.Path]::Combine($extendedRoot, $uninstallerName)
if (-not (Test-EntryExists $uninstaller) -and -not $AllowMissingUninstaller) {
  throw "Expected old uninstaller is missing: $uninstallerName"
}

$topLevel = [System.IO.Directory]::GetFileSystemEntries($extendedRoot)
$toMove = New-Object 'System.Collections.Generic.List[string]'
$uninstallerCount = 0
foreach ($entry in $topLevel) {
  $name = [System.IO.Path]::GetFileName($entry)
  if ([string]::Equals($name, $uninstallerName, [System.StringComparison]::Ordinal)) {
    $uninstallerCount++
    $attributes = [System.IO.File]::GetAttributes($entry)
    if (($attributes -band [System.IO.FileAttributes]::Directory) -ne 0 -or
        ($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Expected old uninstaller is not a regular file.'
    }
    continue
  }
  if ([string]::Equals($name, $uninstallerName, $pathComparison)) {
    throw 'Multiple case variants of the old uninstaller name were found.'
  }
  $toMove.Add($entry)
}
if ($uninstallerCount -ne 1 -and -not ($AllowMissingUninstaller -and $uninstallerCount -eq 0)) {
  throw 'Expected exactly one old uninstaller.'
}
if (-not $recoveryDir -and $toMove.Count -eq 0 -and -not $AllowMissingUninstaller) {
  exit 0
}

if (-not $recoveryDir) {
  $folder = 'Nuwax-installer-recovery-{0}-{1}' -f [System.DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'), [System.Guid]::NewGuid().ToString('N')
  $recoveryDir = [System.IO.Path]::Combine($parent, $folder)
  $extendedRecoveryDir = Get-ExtendedPath $recoveryDir
  if ([System.IO.Directory]::Exists($extendedRecoveryDir)) {
    throw 'Recovery directory already exists; refusing to overwrite it.'
  }
  [System.IO.Directory]::CreateDirectory($extendedRecoveryDir) | Out-Null
  $manifestPath = [System.IO.Path]::Combine($extendedRecoveryDir, 'manifest.jsonl')
  Add-ManifestRecord $manifestPath ([ordered]@{ status = 'start'; installDir = $root; recoveryDir = $recoveryDir })
}

# Both pointers are durable before the first move. If the process dies between
# the manifest intent and the move, a later Prepare reconciles source/backup.
Write-AtomicText $extendedMarker $recoveryDir
Write-AtomicText $stateFile $recoveryDir
Save-RegistrationSnapshot

try {
  # The old uninstaller is the only file left in InstallDir. Keep a small
  # complete copy so Rollback can restore it if the old uninstaller deletes its
  # original before failing. Publish the copy atomically before any moves.
  $uninstallerBackup = [System.IO.Path]::Combine((Get-ExtendedPath $recoveryDir), 'uninstaller-backup.exe')
  if (-not (Test-EntryExists $uninstaller)) {
    Add-ManifestRecord $manifestPath ([ordered]@{ status = 'uninstaller-missing-before-repair' })
  } elseif (-not [System.IO.File]::Exists($uninstallerBackup)) {
    Add-ManifestRecord $manifestPath ([ordered]@{ status = 'uninstaller-backup-intent'; original = $root + '\' + $uninstallerName })
    $temporaryBackup = $uninstallerBackup + '.tmp-' + [System.Guid]::NewGuid().ToString('N')
    try {
      [System.IO.File]::Copy($uninstaller, $temporaryBackup, $false)
      if (([System.IO.FileInfo]::new($uninstaller)).Length -ne ([System.IO.FileInfo]::new($temporaryBackup)).Length) {
        throw 'Old uninstaller backup size does not match its source.'
      }
      [System.IO.File]::Move($temporaryBackup, $uninstallerBackup)
    } finally {
      if ([System.IO.File]::Exists($temporaryBackup)) {
        [System.IO.File]::Delete($temporaryBackup)
      }
    }
    Add-ManifestRecord $manifestPath ([ordered]@{ status = 'uninstaller-backed-up'; backup = $recoveryDir + '\uninstaller-backup.exe' })
  } elseif (([System.IO.FileInfo]::new($uninstaller)).Length -ne ([System.IO.FileInfo]::new($uninstallerBackup)).Length) {
    throw 'Existing old uninstaller backup size does not match its source.'
  }

  foreach ($plan in $plans) {
    $source = Get-ExtendedPath ([string]$plan.original)
    $backup = Get-ExtendedPath ([string]$plan.backup)
    $sourceExists = Test-EntryExists $source
    $backupExists = Test-EntryExists $backup
    if ($sourceExists -and $backupExists) {
      throw "Both original and recovery paths exist: $($plan.original)"
    }
    if (-not $sourceExists -and -not $backupExists) {
      throw "Both original and recovery paths are missing: $($plan.original)"
    }
  }

  foreach ($entry in $toMove) {
    $original = $entry.Substring(4)
    if ($planByOriginal.ContainsKey($original)) {
      $plan = $planByOriginal[$original]
      $backup = Get-ExtendedPath ([string]$plan.backup)
      if (Test-EntryExists $backup) {
        throw "Original path was recreated while recovery already exists: $original"
      }
    } else {
      $index = 0
      do {
        $backupPath = [System.IO.Path]::Combine($recoveryDir, ('entry-{0:D6}' -f $index))
        $index++
      } while ($usedBackups.Contains($backupPath) -or (Test-EntryExists (Get-ExtendedPath $backupPath)))
      $attributes = [System.IO.File]::GetAttributes($entry)
      $isDirectory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0
      $plan = [ordered]@{ status = 'planned'; original = $original; backup = $backupPath; directory = $isDirectory }
      Add-ManifestRecord $manifestPath $plan
      $plans.Add($plan)
      $planByOriginal.Add($original, $plan)
      $usedBackups.Add($backupPath) | Out-Null
      $backup = Get-ExtendedPath $backupPath
    }

    Move-Entry $entry $backup ([bool]$plan.directory)
    Add-ManifestRecord $manifestPath ([ordered]@{ status = 'moved'; original = $original; backup = [string]$plan.backup })
  }

  Add-ManifestRecord $manifestPath ([ordered]@{ status = 'complete'; moved = $plans.Count })
} catch {
  $failure = $_.Exception.Message
  $rollbackFailures = New-Object 'System.Collections.Generic.List[string]'
  for ($index = $plans.Count - 1; $index -ge 0; $index--) {
    $plan = $plans[$index]
    $source = Get-ExtendedPath ([string]$plan.original)
    $backup = Get-ExtendedPath ([string]$plan.backup)
    try {
      if (-not (Test-EntryExists $backup)) {
        continue
      }
      if (Test-EntryExists $source) {
        throw "Cannot roll back because original path exists: $($plan.original)"
      }
      Move-Entry $backup $source ([bool]$plan.directory)
      Add-ManifestRecord $manifestPath ([ordered]@{ status = 'restored'; original = [string]$plan.original })
    } catch {
      $rollbackFailures.Add($_.Exception.Message)
    }
  }
  if ($rollbackFailures.Count -gt 0) {
    throw "Preservation failed: $failure. Rollback incomplete; inspect $recoveryDir. $($rollbackFailures -join '; ')"
  }
  throw "Preservation failed: $failure. Original entries were restored; inspect $recoveryDir"
}

Write-Output "Preserved $($plans.Count) old installation entries in $recoveryDir"
} finally {
  if ($mutexHeld) { $recoveryMutex.ReleaseMutex() }
  $recoveryMutex.Dispose()
  if ($CleanupRuntime) {
    try { Remove-RecoveryRetentionRuntime ([IO.Path]::GetDirectoryName($script:recoveryRuntimePath)) $root }
    catch { Write-Output ('Cleanup runtime retained: ' + $_.Exception.Message) }
  }
}
