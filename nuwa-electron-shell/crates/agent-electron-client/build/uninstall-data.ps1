param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$ManifestPath,
  [Parameter(Mandatory = $true)][string]$ProfileDir,
  [Parameter(Mandatory = $true)][string]$RoamingDir,
  [Parameter(Mandatory = $true)][string]$LocalDir,
  [ValidateSet('CurrentUser', 'LocalMachine')][string]$RegistryScope = 'CurrentUser',
  [switch]$DeleteLocalData
)

$ErrorActionPreference = 'Stop'
$comparison = [StringComparison]::OrdinalIgnoreCase
$script:uninstallPhase = 'Preflight'
$script:uninstallTarget = $InstallDir
trap {
  $cause = $_.Exception
  while ($cause.InnerException) { $cause = $cause.InnerException }
  $target = $script:uninstallTarget
  if ($cause.Data.Contains('NuwaxTarget')) { $target = [string]$cause.Data['NuwaxTarget'] }
  $failure = [ordered]@{ atUtc = [DateTime]::UtcNow.ToString('o'); action = 'Uninstall';
    phase = $script:uninstallPhase; installDir = $InstallDir; scope = $RegistryScope;
    target = $target; deleteLocalData = [bool]$DeleteLocalData;
    readOnly = $cause.Data['NuwaxReadOnly']; nativeError = $cause.Data['NuwaxNativeError'];
    error = $cause.Message; exceptionType = $cause.GetType().FullName; errorId = $_.FullyQualifiedErrorId }
  try {
    [IO.File]::AppendAllText((Join-Path ([IO.Path]::GetTempPath()) 'Nuwax-uninstall-events.jsonl'),
      ($failure | ConvertTo-Json -Compress) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
  } catch { }
  [Console]::Error.WriteLine(($failure | ConvertTo-Json -Compress))
  # Program removal has completed at this stage; a partial data cleanup must
  # retain its retry entry without claiming that every user file still exists.
  if ($script:uninstallPhase -eq 'LocalDataRemoval') { exit 3 }
  if ($script:uninstallPhase -eq 'Preflight' -and $cause -is [UnauthorizedAccessException]) { exit 4 }
  exit 1
}

# NSIS runs from a plugin directory containing a native System.dll. Bind
# compiler references to loaded framework assemblies, never that directory.
# The shipped inventory contains tens of thousands of files. Keep repeated path
# walks in .NET to avoid per-ancestor PowerShell invocation overhead. Recheck
# ancestors on every pass: cached attributes could miss a directory replaced
# by a junction during removal.
Add-Type -ReferencedAssemblies @([Uri].Assembly.Location, [Collections.Generic.HashSet[string]].Assembly.Location) -TypeDefinition @'
using System;
using System.IO;
using System.Text.RegularExpressions;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class NuwaxUninstallPaths {
  [DllImport("kernel32.dll", EntryPoint="CreateFileW", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern SafeFileHandle OpenForAccess(string path, uint access, uint sharing,
    IntPtr security, uint disposition, uint flags, IntPtr template);

  private static void CheckRemovalAccess(string file, FileAttributes attributes) {
    // Opening an existing handle with DELETE access checks the actual token's
    // permissions without deleting or marking the file for deletion. Read-only
    // owned files also require permission to clear that one attribute later.
    uint access = 0x00010000;
    if ((attributes & FileAttributes.ReadOnly) != 0) access |= 0x00000100;
    using (SafeFileHandle handle = OpenForAccess(file, access, 7, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero)) {
      if (!handle.IsInvalid) return;
      int code = Marshal.GetLastWin32Error();
      if (code == 2 || code == 3) return; // Another pass may already have removed it.
      Exception error = code == 5
        ? (Exception)new UnauthorizedAccessException("No permission to remove owned program file: " + file)
        : new IOException("Cannot preflight removal of program file: " + file + " (Win32=" + code + ")");
      error.Data["NuwaxNativeError"] = code;
      throw error;
    }
  }

  private static void RecordFileFailure(Exception error, string file, FileAttributes? attributes) {
    while (error.InnerException != null) error = error.InnerException;
    error.Data["NuwaxTarget"] = file;
    if (attributes.HasValue) error.Data["NuwaxReadOnly"] = (attributes.Value & FileAttributes.ReadOnly) != 0;
  }
  public static void Progress(string phase, int count, int total) {
    try {
      File.AppendAllText(Path.Combine(Path.GetTempPath(), "Nuwax-uninstall-progress.log"),
        DateTime.UtcNow.ToString("u") + " " + phase + " " + count + "/" + total + Environment.NewLine);
    } catch { /* Diagnostics must never block removal. */ }
  }

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
    int checkedFiles = 0;
    Progress("preflight-start", 0, files.Length);
    foreach (string file in files) {
      FileAttributes? attributes = null;
      try {
        AssertNoReparseAncestors(file);
        attributes = ExistingAttributes(file);
        if (attributes.HasValue) {
          if ((attributes.Value & FileAttributes.Directory) != 0)
            throw new IOException("Payload file became a directory: " + file);
          using (File.Open(file, FileMode.Open, FileAccess.Read, FileShare.None)) { }
          CheckRemovalAccess(file, attributes.Value);
        }
      } catch (Exception error) { RecordFileFailure(error, file, attributes); throw; }
      if (++checkedFiles % 5000 == 0) Progress("preflight", checkedFiles, files.Length);
    }
    Progress("preflight-complete", checkedFiles, files.Length);
  }

  public static void RemoveFiles(string[] files) {
    int checkedFiles = 0;
    Progress("delete-start", 0, files.Length);
    foreach (string file in files) {
      FileAttributes? attributes = null;
      try {
        AssertNoReparseAncestors(file);
        attributes = ExistingAttributes(file);
        if (attributes.HasValue) RemoveDataEntry(file, false);
      } catch (Exception error) { RecordFileFailure(error, file, attributes); throw; }
      if (++checkedFiles % 5000 == 0) Progress("delete", checkedFiles, files.Length);
    }
    Progress("delete-complete", checkedFiles, files.Length);
  }

  public static void RemoveDataEntry(string path, bool directory) {
    FileAttributes? attributes = ExistingAttributes(path);
    if (!attributes.HasValue) return;
    // Git pack/index files in app-managed workspaces are commonly read-only.
    // Used only for manifest-owned program files or explicitly selected local
    // data. Unknown program files never reach this helper. Links are unlinked
    // without changing attributes on their destination.
    bool readOnly = (attributes.Value & (FileAttributes.ReadOnly | FileAttributes.ReparsePoint)) == FileAttributes.ReadOnly;
    if (readOnly) {
      AssertNoReparseAncestors(path);
      File.SetAttributes(path, attributes.Value & ~FileAttributes.ReadOnly);
    }
    try { if (directory) Directory.Delete(path, false); else File.Delete(path); }
    catch {
      if (readOnly) {
        try {
          AssertNoReparseAncestors(path);
          FileAttributes? remaining = ExistingAttributes(path);
          if (remaining.HasValue && (remaining.Value & FileAttributes.ReparsePoint) == 0)
            File.SetAttributes(path, remaining.Value | FileAttributes.ReadOnly);
        } catch { /* Preserve the original removal error for diagnosis. */ }
      }
      throw;
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
  $script:uninstallTarget = $Target
  $attributes = Existing-Attributes $Target
  if ($null -eq $attributes) { return }
  if ($attributes -band [IO.FileAttributes]::ReparsePoint) {
    # Remove a nested link itself, never its external destination.
    if ($attributes -band [IO.FileAttributes]::Directory) { [IO.Directory]::Delete($Target, $false) }
    else { [IO.File]::Delete($Target) }
  } elseif ($attributes -band [IO.FileAttributes]::Directory) {
    foreach ($entry in [IO.Directory]::GetFileSystemEntries($Target)) { Remove-OwnedData $entry }
    $script:uninstallTarget = $Target
    [NuwaxUninstallPaths]::RemoveDataEntry($Target, $true)
  } else { [NuwaxUninstallPaths]::RemoveDataEntry($Target, $false) }
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
$script:uninstallPhase = 'ProgramRemoval'
[NuwaxUninstallPaths]::RemoveFiles($files)
foreach ($directory in ($directories | Sort-Object Length -Descending)) {
  Assert-NoReparseAncestors $directory
  if ([IO.Directory]::Exists($directory) -and [IO.Directory]::GetFileSystemEntries($directory).Length -eq 0) {
    [IO.Directory]::Delete($directory, $false)
  }
}
$script:uninstallPhase = 'LocalDataRemoval'
foreach ($target in $dataTargets) { Remove-OwnedData $target }
Write-Output ('Removed owned program files. Local data deletion requested: ' + [bool]$DeleteLocalData + '. Unknown installation files are retained.')
