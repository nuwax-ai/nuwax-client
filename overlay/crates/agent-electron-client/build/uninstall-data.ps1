param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$ManifestPath,
  [Parameter(Mandatory = $true)][string]$ProfileDir,
  [Parameter(Mandatory = $true)][string]$RoamingDir,
  [Parameter(Mandatory = $true)][string]$LocalDir,
  [switch]$DeleteLocalData
)

$ErrorActionPreference = 'Stop'
$comparison = [StringComparison]::OrdinalIgnoreCase

function Full-LocalPath([string]$Value) {
  if ($Value -notmatch '^[A-Za-z]:\\' -or $Value -match '[\x00-\x1f]') { throw 'Expected an absolute local path.' }
  $full = [IO.Path]::GetFullPath($Value).TrimEnd([char]92)
  if ($full.Length -le 3) { throw 'Refusing a volume root.' }
  return $full
}

function Existing-Attributes([string]$Value) {
  try { return [IO.File]::GetAttributes($Value) }
  catch [IO.FileNotFoundException] { return $null }
  catch [IO.DirectoryNotFoundException] { return $null }
}

# Payload inventories reach tens of thousands of files that share a few
# thousand ancestor directories; the original per-file ancestor walk was the
# dominant uninstall cost on real installs (minutes of CPU with no output).
# Verify each directory once per run instead. Whenever a path enters the set,
# its whole ancestor chain entered in the same walk, so an early hit proves
# the remaining chain was already verified.
$verifiedAncestors = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
function Assert-NoReparseAncestors([string]$Value) {
  $pending = $null
  $current = $Value
  while ($current) {
    if (-not $verifiedAncestors.Add($current)) { break }
    if ($null -eq $pending) { $pending = New-Object 'System.Collections.Generic.List[string]' }
    $pending.Add($current)
    $current = [IO.Path]::GetDirectoryName($current)
  }
  if ($null -ne $pending) {
    foreach ($path in $pending) {
      $attributes = Existing-Attributes $path
      if ($null -ne $attributes -and ($attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Refusing a redirected path: $path" }
    }
  }
}

# The uninstaller UI shows nothing while the hidden PowerShell process runs;
# keep a timestamped trace so a stalled pass can be diagnosed post mortem.
$progressPath = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'Nuwax-uninstall-progress.log')
function Write-UninstallProgress([string]$Message) {
  try { [IO.File]::AppendAllText($progressPath, ('{0:u} {1}{2}' -f [DateTime]::UtcNow, $Message, [Environment]::NewLine)) } catch { }
}

$root = Full-LocalPath $InstallDir
$profile = Full-LocalPath $ProfileDir
$roaming = Full-LocalPath $RoamingDir
$local = Full-LocalPath $LocalDir
foreach ($protected in @($profile, $roaming, $local, $env:WINDIR, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
  if ($protected -and [string]::Equals($root, $protected.TrimEnd([char]92), $comparison)) { throw 'Refusing a profile or system directory as installation root.' }
}
Assert-NoReparseAncestors $root
$manifest = [IO.File]::ReadAllText($ManifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1 -or $manifest.executable -notmatch '^[A-Za-z0-9 _.-]+\.exe$' -or
    $manifest.dataDirectoryName -notmatch '^\.nuwax(?:-[a-z0-9-]+)?$' -or
    $manifest.appDataName -notmatch '^Nuwax[A-Za-z0-9 _.-]*$' -or
    $manifest.updaterCacheName -notmatch '^nuwax(?:-[a-z0-9-]+)?-updater$') { throw 'Invalid embedded payload inventory.' }

function Payload-Path([string]$Relative) {
  if (!$Relative -or $Relative -match '[\\:\x00-\x1f]' -or $Relative.StartsWith('/') -or
      @($Relative.Split('/') | Where-Object { $_ -in @('', '.', '..') -or $_.EndsWith('.') -or $_.EndsWith(' ') }).Count) {
    throw 'Invalid relative payload path.'
  }
  $full = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $Relative.Replace('/', '\')))
  if (!$full.StartsWith($root + '\', $comparison)) { throw 'Payload path escapes installation.' }
  return $full
}

$files = @($manifest.files | ForEach-Object { Payload-Path $_ })
$directories = @($manifest.directories | ForEach-Object { Payload-Path $_ })
if ($files.Count -eq 0 -or $manifest.executable -notin $manifest.files) { throw 'Incomplete payload inventory.' }
# Preflight every owned file before deleting any. Unknown entries, including
# files added inside resources, are never enumerated as removal candidates.
# The probes are exception-free (Windows PowerShell 5.1 exception handling in
# these loops costs more than the filesystem calls themselves).
$preflightDone = 0
foreach ($file in $files) {
  Assert-NoReparseAncestors $file
  if ([IO.File]::Exists($file)) {
    $attributes = [IO.File]::GetAttributes($file)
    if ($attributes -band [IO.FileAttributes]::Directory) { throw "Payload file became a directory: $file" }
    $stream = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    $stream.Dispose()
  } elseif ([IO.Directory]::Exists($file)) {
    throw "Payload file became a directory: $file"
  }
  $preflightDone++
  if (($preflightDone % 5000) -eq 0) { Write-UninstallProgress "preflight $preflightDone/$($files.Count)" }
}
Write-UninstallProgress "preflight-complete $preflightDone/$($files.Count)"

function Remove-OwnedData([string]$Target) {
  $attributes = Existing-Attributes $Target
  if ($null -eq $attributes) { return }
  if ($attributes -band [IO.FileAttributes]::ReparsePoint) {
    # Remove a nested link itself, never its external destination.
    if ($attributes -band [IO.FileAttributes]::Directory) { [IO.Directory]::Delete($Target, $false) }
    else { [IO.File]::Delete($Target) }
  } elseif ($attributes -band [IO.FileAttributes]::Directory) {
    foreach ($entry in [IO.Directory]::GetFileSystemEntries($Target)) { Remove-OwnedData $entry }
    [IO.Directory]::Delete($Target, $false)
  } else { [IO.File]::Delete($Target) }
}

$dataTargets = @()
if ($DeleteLocalData) {
  $dataTargets = @([IO.Path]::Combine($profile, $manifest.dataDirectoryName),
    [IO.Path]::Combine($roaming, $manifest.appDataName), [IO.Path]::Combine($local, $manifest.updaterCacheName))
  foreach ($target in $dataTargets) {
    Assert-NoReparseAncestors $target
    if ([string]::Equals($root, $target, $comparison) -or $root.StartsWith($target + '\', $comparison) -or
        $target.StartsWith($root + '\', $comparison)) { throw 'Installation and local data directories overlap; refusing local data deletion.' }
  }
}
$deleted = 0
foreach ($file in $files) {
  Assert-NoReparseAncestors $file
  if ([IO.File]::Exists($file)) {
    [IO.File]::Delete($file)
    $deleted++
    if (($deleted % 5000) -eq 0) { Write-UninstallProgress "delete $deleted/$($files.Count)" }
  }
}
Write-UninstallProgress "delete-complete $deleted/$($files.Count)"
foreach ($directory in ($directories | Sort-Object Length -Descending)) {
  Assert-NoReparseAncestors $directory
  if ([IO.Directory]::Exists($directory) -and [IO.Directory]::GetFileSystemEntries($directory).Length -eq 0) {
    [IO.Directory]::Delete($directory, $false)
  }
}
foreach ($target in $dataTargets) {
  Write-UninstallProgress "data-start $target"
  Remove-OwnedData $target
  Write-UninstallProgress "data-complete $target"
}
Write-Output ('Removed owned program files. Local data deletion requested: ' + [bool]$DeleteLocalData + '. Unknown installation files are retained.')
