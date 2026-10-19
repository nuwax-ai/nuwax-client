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

function Assert-NoReparseAncestors([string]$Value) {
  $current = $Value
  while ($current) {
    $attributes = Existing-Attributes $current
    if ($null -ne $attributes -and ($attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Refusing a redirected path: $current" }
    $current = [IO.Path]::GetDirectoryName($current)
  }
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
foreach ($file in $files) {
  Assert-NoReparseAncestors $file
  $attributes = Existing-Attributes $file
  if ($null -ne $attributes) {
    if ($attributes -band [IO.FileAttributes]::Directory) { throw "Payload file became a directory: $file" }
    $stream = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    $stream.Dispose()
  }
}

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
foreach ($file in $files) {
  Assert-NoReparseAncestors $file
  if ($null -ne (Existing-Attributes $file)) { [IO.File]::Delete($file) }
}
foreach ($directory in ($directories | Sort-Object Length -Descending)) {
  Assert-NoReparseAncestors $directory
  if ([IO.Directory]::Exists($directory) -and [IO.Directory]::GetFileSystemEntries($directory).Length -eq 0) {
    [IO.Directory]::Delete($directory, $false)
  }
}
foreach ($target in $dataTargets) { Remove-OwnedData $target }
Write-Output ('Removed owned program files. Local data deletion requested: ' + [bool]$DeleteLocalData + '. Unknown installation files are retained.')
