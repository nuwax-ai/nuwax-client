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

# The shipped inventory contains tens of thousands of files. Keep repeated path
# walks in .NET to avoid per-ancestor PowerShell invocation overhead. Recheck
# ancestors on every pass: cached attributes could miss a directory replaced
# by a junction during removal.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text.RegularExpressions;

public static class NuwaxUninstallPaths {
  public static FileAttributes? ExistingAttributes(string path) {
    try { return File.GetAttributes(path); }
    catch (FileNotFoundException) { return null; }
    catch (DirectoryNotFoundException) { return null; }
  }

  public static void AssertNoReparseAncestors(string path) {
    for (string current = path; !String.IsNullOrEmpty(current); current = Path.GetDirectoryName(current)) {
      FileAttributes? attributes = ExistingAttributes(current);
      if (attributes.HasValue && (attributes.Value & FileAttributes.ReparsePoint) != 0)
        throw new IOException("Refusing a redirected path: " + current);
    }
  }

  public static string[] PayloadPaths(string root, string[] relativePaths) {
    if (relativePaths == null) return new string[0];
    var result = new string[relativePaths.Length];
    for (int i = 0; i < relativePaths.Length; i++) {
      string relative = relativePaths[i];
      if (String.IsNullOrEmpty(relative) || Regex.IsMatch(relative, @"[\\:\x00-\x1f]") || relative.StartsWith("/"))
        throw new IOException("Invalid relative payload path.");
      foreach (string segment in relative.Split('/')) {
        if (segment == "" || segment == "." || segment == ".." || segment.EndsWith(".") || segment.EndsWith(" "))
          throw new IOException("Invalid relative payload path.");
      }
      string full = Path.GetFullPath(Path.Combine(root, relative.Replace('/', '\\')));
      if (!full.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase))
        throw new IOException("Payload path escapes installation.");
      result[i] = full;
    }
    return result;
  }

  public static void PreflightFiles(string[] files) {
    foreach (string file in files) {
      AssertNoReparseAncestors(file);
      FileAttributes? attributes = ExistingAttributes(file);
      if (!attributes.HasValue) continue;
      if ((attributes.Value & FileAttributes.Directory) != 0)
        throw new IOException("Payload file became a directory: " + file);
      using (File.Open(file, FileMode.Open, FileAccess.Read, FileShare.None)) { }
    }
  }

  public static void RemoveFiles(string[] files) {
    foreach (string file in files) {
      AssertNoReparseAncestors(file);
      if (ExistingAttributes(file).HasValue) File.Delete(file);
    }
  }
}
'@

function Full-LocalPath([string]$Value) {
  if ($Value -notmatch '^[A-Za-z]:\\' -or $Value -match '[\x00-\x1f]') { throw 'Expected an absolute local path.' }
  $full = [IO.Path]::GetFullPath($Value).TrimEnd([char]92)
  if ($full.Length -le 3) { throw 'Refusing a volume root.' }
  return $full
}

function Existing-Attributes([string]$Value) {
  return [NuwaxUninstallPaths]::ExistingAttributes($Value)
}

function Assert-NoReparseAncestors([string]$Value) {
  [NuwaxUninstallPaths]::AssertNoReparseAncestors($Value)
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

$files = [NuwaxUninstallPaths]::PayloadPaths($root, [string[]]$manifest.files)
$directories = [NuwaxUninstallPaths]::PayloadPaths($root, [string[]]$manifest.directories)
if ($files.Count -eq 0 -or $manifest.executable -notin $manifest.files) { throw 'Incomplete payload inventory.' }
# Preflight every owned file before deleting any. Unknown entries, including
# files added inside resources, are never enumerated as removal candidates.
[NuwaxUninstallPaths]::PreflightFiles($files)

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
[NuwaxUninstallPaths]::RemoveFiles($files)
foreach ($directory in ($directories | Sort-Object Length -Descending)) {
  Assert-NoReparseAncestors $directory
  if ([IO.Directory]::Exists($directory) -and [IO.Directory]::GetFileSystemEntries($directory).Length -eq 0) {
    [IO.Directory]::Delete($directory, $false)
  }
}
foreach ($target in $dataTargets) { Remove-OwnedData $target }
Write-Output ('Removed owned program files. Local data deletion requested: ' + [bool]$DeleteLocalData + '. Unknown installation files are retained.')
