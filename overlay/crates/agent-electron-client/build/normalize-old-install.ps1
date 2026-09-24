param(
  [ValidateSet('Prepare', 'Restore', 'Rollback')][string]$Action = 'Prepare',
  [string]$InstallDir,
  [Alias('RecoveryPathFile')][Parameter(Mandatory = $true)][string]$StatePath
)

# The old electron-builder uninstaller recursively removes InstallDir. Preserve
# every old top-level entry by renaming it to a sibling on the same volume before
# the uninstaller starts. Moving a parent also preserves nested reserved device
# names and trailing dots/spaces without enumerating those paths.
$ErrorActionPreference = 'Stop'
$uninstallerName = 'Uninstall Nuwax.exe'
# Only the Electron payload has a predictable name. Restore every other
# top-level entry to its original location: workspaceDir may be any directory
# chosen by the user, including the installation root itself.
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

$statePathFull = [System.IO.Path]::GetFullPath($StatePath)
$stateFile = Get-ExtendedPath $statePathFull
$fromState = $null
if ([System.IO.File]::Exists($stateFile)) {
  $fromState = [System.IO.File]::ReadAllText($stateFile, $utf8).Trim()
}
$records = $null
$recoveryDir = $fromState

if ($Action -eq 'Prepare') {
  if (-not $InstallDir) {
    throw 'Prepare requires InstallDir.'
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
if ($statePathFull.StartsWith($root + '\', $pathComparison)) {
  throw 'Recovery state must be outside the installation directory.'
}

$marker = Get-MarkerPath $root
$extendedMarker = Get-ExtendedPath $marker

# StatePath lives in NSIS PLUGINSDIR. The sibling marker survives a process
# restart, while the JSONL manifest inside recovery records each individual
# intent before its rename.
$fromMarker = $null
if ([System.IO.File]::Exists($extendedMarker)) {
  $fromMarker = [System.IO.File]::ReadAllText($extendedMarker, $utf8).Trim()
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
  if (-not [System.IO.File]::Exists($manifestPath)) {
    throw "Recovery manifest is missing: $recoveryDir"
  }
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

if ($Action -eq 'Rollback') {
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
  if ($conflicts -eq 0 -and $missing -eq 0 -and $moveFailures.Count -eq 0 -and $uninstallerPresent) {
    Add-ManifestRecord $manifestPath ([ordered]@{ status = 'rollback-complete'; returned = $returned })
    if ([System.IO.File]::Exists($extendedMarker)) {
      [System.IO.File]::Delete($extendedMarker)
    }
    if ([System.IO.File]::Exists($stateFile)) {
      [System.IO.File]::Delete($stateFile)
    }
    Write-Output "Rolled back $returned old installation entries to $root"
    exit 0
  }

  Write-Output "Rollback incomplete: returned=$returned conflicts=$conflicts missing=$missing uninstallerPresent=$uninstallerPresent recovery=$recoveryDir $($moveFailures -join '; ')"
  exit 3
}

if ($Action -eq 'Restore') {
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
  foreach ($plan in $plans) {
    $original = [string]$plan.original
    $name = [System.IO.Path]::GetFileName($original)
    if ($appEntryNames -contains $name) {
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
  Add-ManifestRecord $manifestPath ([ordered]@{ status = 'restore-complete'; restored = $restored; conflicts = $conflicts })
  if ([System.IO.File]::Exists($extendedMarker)) {
    [System.IO.File]::Delete($extendedMarker)
  }
  Write-Output "Restored $restored non-application entries; $conflicts conflicts remain in $recoveryDir"
  if ($conflicts -gt 0) {
    exit 3
  }
  exit 0
}

if ($recoveryDir) {
  $lastTerminal = -1
  $lastPartialRestore = -1
  $lastPrepareChange = -1
  for ($index = 0; $index -lt $records.Count; $index++) {
    $status = [string]$records[$index].status
    if ($status -in @('restore-complete', 'rollback-complete')) {
      $lastTerminal = $index
    } elseif ($status -in @('workspace-restore-intent', 'workspace-restored')) {
      $lastPartialRestore = $index
    } elseif ($status -in @('planned', 'moved')) {
      $lastPrepareChange = $index
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
    throw 'Recovery has an unfinished Restore/Rollback; refusing to mix a new installation into it.'
  }
}

if (-not [System.IO.Directory]::Exists($extendedRoot)) {
  if ($recoveryDir) {
    Write-Output "Old installation already preserved in $recoveryDir"
  }
  exit 0
}
if (([System.IO.File]::GetAttributes($extendedRoot) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'Refusing to inspect an installation directory that is a reparse point.'
}
$uninstaller = [System.IO.Path]::Combine($extendedRoot, $uninstallerName)
if (-not [System.IO.File]::Exists($uninstaller)) {
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
if ($uninstallerCount -ne 1) {
  throw 'Expected exactly one old uninstaller.'
}
if (-not $recoveryDir -and $toMove.Count -eq 0) {
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

try {
  # The old uninstaller is the only file left in InstallDir. Keep a small
  # complete copy so Rollback can restore it if the old uninstaller deletes its
  # original before failing. Publish the copy atomically before any moves.
  $uninstallerBackup = [System.IO.Path]::Combine((Get-ExtendedPath $recoveryDir), 'uninstaller-backup.exe')
  if (-not [System.IO.File]::Exists($uninstallerBackup)) {
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
