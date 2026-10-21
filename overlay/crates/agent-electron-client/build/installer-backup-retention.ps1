# Dot-sourced by normalize-old-install.ps1. Ownership comes from the old
# uninstaller's embedded build inventory, never from the newly installed app.
function Remove-RecoveryRetentionRuntime([string]$RuntimeDirectory, [string]$InstallRoot) {
  $tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([char]92)
  if (-not [string]::Equals([IO.Path]::GetDirectoryName($RuntimeDirectory), $tempParent, $pathComparison) -or
      [IO.Path]::GetFileName($RuntimeDirectory) -notmatch '^Nuwax-backup-cleanup-[0-9a-f]{32}$' -or
      ([IO.File]::GetAttributes($RuntimeDirectory) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Invalid cleanup runtime directory.' }
  $owner = [IO.File]::ReadAllText((Join-Path $RuntimeDirectory 'owner.json'), $utf8) | ConvertFrom-Json
  if ($owner.kind -ne 'Nuwax backup cleanup' -or -not [string]::Equals($owner.installDir, $InstallRoot, $pathComparison)) { throw 'Cleanup runtime ownership mismatch.' }
  foreach ($file in @('normalize-old-install.ps1', 'installer-backup-retention.ps1', 'owner.json')) {
    [IO.File]::Delete((Join-Path $RuntimeDirectory $file))
  }
  [IO.Directory]::Delete($RuntimeDirectory, $false)
}

function Start-RecoveryRetention([string]$InstallRoot) {
  # NSIS deletes PLUGINSDIR on exit. Give the detached worker its own small,
  # self-cleaning runtime so scanning old backups cannot hold up the new app.
  $runtime = Join-Path ([IO.Path]::GetTempPath()) ('Nuwax-backup-cleanup-' + [Guid]::NewGuid().ToString('N'))
  [IO.Directory]::CreateDirectory($runtime) | Out-Null
  [IO.File]::WriteAllText((Join-Path $runtime 'owner.json'), ((@{ kind = 'Nuwax backup cleanup'; installDir = $InstallRoot } | ConvertTo-Json -Compress)), $utf8)
  try {
    [IO.File]::Copy($script:recoveryRuntimePath, (Join-Path $runtime 'normalize-old-install.ps1'))
    [IO.File]::Copy((Join-Path ([IO.Path]::GetDirectoryName($script:recoveryRuntimePath)) 'installer-backup-retention.ps1'), (Join-Path $runtime 'installer-backup-retention.ps1'))
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path $runtime 'normalize-old-install.ps1') + '" -Action Cleanup -CleanupRuntime -StatePath "' + (Join-Path $runtime 'state.txt') + '" -InstallDir "' + $InstallRoot + '"'
    $log = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetFileNameWithoutExtension((Get-MarkerPath $InstallRoot)) + '-cleanup')
    Start-Process -FilePath "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList $arguments -WindowStyle Hidden -RedirectStandardOutput ($log + '.log') -RedirectStandardError ($log + '-errors.log')
    Write-Output 'Backup retention scheduled in background.'
  } catch {
    Remove-RecoveryRetentionRuntime $runtime $InstallRoot
    throw
  }
}

function Save-RecoveryPayloadInventory([string]$InventoryPath) {
  $bytes = [IO.File]::ReadAllBytes($InventoryPath)
  $inventory = $utf8.GetString($bytes) | ConvertFrom-Json
  if ($inventory.schemaVersion -ne 1 -or -not $inventory.fileHashes -or
      $inventory.executable -ne $appEntryNames[0] -or $inventory.files.Count -eq 0) {
    throw 'Recovery ownership requires an embedded inventory with file hashes.'
  }
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $digest = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
  $destination = [IO.Path]::Combine((Get-ExtendedPath $recoveryDir), 'payload-inventory.json')
  if ([IO.File]::Exists($destination)) {
    $existing = [IO.File]::ReadAllBytes($destination)
    if ([Convert]::ToBase64String($existing) -ne [Convert]::ToBase64String($bytes)) {
      throw 'Recovery ownership was already recorded with a different inventory.'
    }
  } else {
    $temporary = $destination + '.tmp-' + [Guid]::NewGuid().ToString('N')
    try { [IO.File]::WriteAllBytes($temporary, $bytes); [IO.File]::Move($temporary, $destination) }
    finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
  }
  $stream = [IO.File]::OpenRead([IO.Path]::Combine((Get-ExtendedPath $recoveryDir), 'uninstaller-backup.exe'))
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $uninstallerHash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $sha.Dispose() }
  Add-ManifestRecord $manifestPath ([ordered]@{ status = 'payload-inventory-recorded'; sha256 = $digest; uninstallerSha256 = $uninstallerHash })
}

function Initialize-RecoveryRetentionIO {
  if ('NuwaxRecoveryRetentionIO' -as [type]) { return }
  Add-Type -ReferencedAssemblies @([Uri].Assembly.Location, [Collections.Generic.HashSet[string]].Assembly.Location) -TypeDefinition @'
using System;
using System.IO;
using System.Collections.Generic;
using System.Security.Cryptography;

public static class NuwaxRecoveryRetentionIO {
  static readonly HashSet<string> Controls = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
    "manifest.jsonl", "payload-inventory.json", "uninstaller-backup.exe", "registration.json"
  };
  static void Guard(string path) {
    for (string p = path; !String.IsNullOrEmpty(p); p = Path.GetDirectoryName(p)) {
      if ((File.GetAttributes(p) & FileAttributes.ReparsePoint) != 0)
        throw new IOException("Recovery path is redirected.");
      if (String.Equals(p.TrimEnd('\\'), Path.GetPathRoot(p).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) break;
    }
  }
  public static string Hash(string path) {
    Guard(path);
    using (var sha = SHA256.Create())
    using (var stream = File.OpenRead(path))
      return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
  }
  public static bool ValidRelative(string path) {
    if (String.IsNullOrEmpty(path) || path.IndexOfAny(new char[] {'\\', ':'}) >= 0) return false;
    foreach (char c in path) if (c < 32) return false;
    foreach (string segment in path.Split('/'))
      if (segment == "" || segment == "." || segment == ".." || segment.EndsWith(".") || segment.EndsWith(" ")) return false;
    return true;
  }
  public static bool Prune(string root, Dictionary<string,string> moves,
      Dictionary<string,string> hashes, HashSet<string> ownedDirectories, string uninstallerHash, string registrationHash) {
    Guard(root);
    string uninstaller = Path.Combine(root, "uninstaller-backup.exe");
    if (File.Exists(uninstaller) && Hash(uninstaller) != uninstallerHash) return false;
    string registration = Path.Combine(root, "registration.json");
    if (File.Exists(registration) && Hash(registration) != registrationHash) return false;
    var files = new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
    var directories = new List<string>();
    var pending = new Stack<KeyValuePair<string,string>>();
    foreach (string entry in Directory.GetFileSystemEntries(root)) {
      string name = Path.GetFileName(entry);
      Guard(entry);
      if (Controls.Contains(name)) {
        if ((File.GetAttributes(entry) & FileAttributes.Directory) != 0) return false;
        continue;
      }
      string original;
      if (!moves.TryGetValue(name, out original)) return false;
      pending.Push(new KeyValuePair<string,string>(entry, original));
    }
    while (pending.Count != 0) {
      var entry = pending.Pop();
      Guard(entry.Key);
      if ((File.GetAttributes(entry.Key) & FileAttributes.Directory) != 0) {
        if (!ownedDirectories.Contains(entry.Value)) return false;
        directories.Add(entry.Key);
        foreach (string child in Directory.GetFileSystemEntries(entry.Key))
          pending.Push(new KeyValuePair<string,string>(child, entry.Value + "/" + Path.GetFileName(child)));
      } else {
        string expected;
        if (!hashes.TryGetValue(entry.Value, out expected) || Hash(entry.Key) != expected) return false;
        files.Add(entry.Key, expected);
      }
    }
    // Delete only the verified list. A concurrently added file is never picked
    // up by recursive removal; nonempty directories stop cleanup instead.
    foreach (var file in files) {
      if (Hash(file.Key) != file.Value) throw new IOException("Recovery file changed during cleanup.");
      File.Delete(file.Key);
    }
    directories.Sort((a,b) => b.Length.CompareTo(a.Length));
    foreach (string directory in directories) { Guard(directory); Directory.Delete(directory, false); }
    foreach (string entry in Directory.GetFileSystemEntries(root)) {
      Guard(entry);
      if (!Controls.Contains(Path.GetFileName(entry)) || (File.GetAttributes(entry) & FileAttributes.Directory) != 0) return false;
    }
    foreach (string name in new [] { "uninstaller-backup.exe", "payload-inventory.json", "registration.json", "manifest.jsonl" }) {
      string file = Path.Combine(root, name);
      if (File.Exists(file)) {
        Guard(file);
        if (name == "uninstaller-backup.exe" && Hash(file) != uninstallerHash) throw new IOException("Uninstaller backup changed during cleanup.");
        if (name == "registration.json" && Hash(file) != registrationHash) throw new IOException("Registration snapshot changed during cleanup.");
        File.Delete(file);
      }
    }
    Guard(root);
    Directory.Delete(root, false);
    return true;
  }
}
'@
}

function Invoke-RecoveryRetention([string]$InstallRoot, [string]$KeepDirectory = '') {
  $recoveryParent = [IO.Path]::GetDirectoryName($InstallRoot)
  if (Test-EntryExists (Get-ExtendedPath (Get-MarkerPath $InstallRoot))) {
    Write-Output 'Backup retention skipped: an upgrade recovery is active.'
    return
  }
  $candidates = New-Object 'System.Collections.Generic.List[object]'
  $protected = 0
  foreach ($folder in [IO.Directory]::GetDirectories((Get-ExtendedPath $recoveryParent), 'Nuwax-installer-recovery-*')) {
    try {
      $name = [IO.Path]::GetFileName($folder)
      if ($name -notmatch '^Nuwax-installer-recovery-(\d{8}T\d{6}Z)-[0-9a-f]{32}$') { continue }
      $created = [DateTime]::ParseExact($Matches[1], 'yyyyMMddTHHmmssZ', [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal)
      if (([IO.File]::GetAttributes($folder) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { $protected++; continue }
      $manifest = [IO.Path]::Combine($folder, 'manifest.jsonl')
      if (([IO.File]::GetAttributes($manifest) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { $protected++; continue }
      $history = Read-Manifest $manifest
      $plainFolder = $folder.Substring(4)
      if ($history.Count -eq 0 -or $history[0].status -ne 'start' -or
          -not [string]::Equals([string]$history[0].installDir, $InstallRoot, $pathComparison) -or
          -not [string]::Equals([string]$history[0].recoveryDir, $plainFolder, $pathComparison)) { continue }
      $terminal = $history[$history.Count - 1]
      if ($terminal.status -notin @('restore-complete', 'rollback-complete')) {
        $protected++; Write-Output "Backup retained: $plainFolder; reason=unfinished-transaction"; continue
      }
      $finished = [IO.File]::GetLastWriteTimeUtc($manifest)
      if ($terminal.completedAtUtc) { $finished = [DateTime]::Parse($terminal.completedAtUtc, [Globalization.CultureInfo]::InvariantCulture).ToUniversalTime() }
      if ($finished -lt $created) { $finished = $created }
      $candidates.Add([pscustomobject]@{ path = $plainFolder; extended = $folder; history = $history; finished = $finished })
    } catch { $protected++ }
  }
  $ordered = @($candidates | Sort-Object -Property @{Expression='finished';Descending=$true}, @{Expression='path';Descending=$true})
  $deleted = 0
  for ($i = 0; $i -lt $ordered.Count; $i++) {
    $candidate = $ordered[$i]
    if ($i -eq 0 -or [string]::Equals($candidate.path, $KeepDirectory, $pathComparison) -or
        $candidate.finished -gt [DateTime]::UtcNow.AddDays(-7)) {
      Write-Output ('Backup retained: ' + $candidate.path + '; reason=latest-or-seven-day-window')
      continue
    }
    try {
      Initialize-RecoveryRetentionIO
      $proof = @($candidate.history | Where-Object { $_.status -eq 'payload-inventory-recorded' })
      if ($proof.Count -eq 0 -or $proof[$proof.Count - 1].uninstallerSha256 -notmatch '^[a-f0-9]{64}$') {
        $protected++; Write-Output ('Backup retained: ' + $candidate.path + '; reason=missing-old-payload-ownership'); continue
      }
      $inventoryPath = [IO.Path]::Combine($candidate.extended, 'payload-inventory.json')
      if ([NuwaxRecoveryRetentionIO]::Hash($inventoryPath) -ne $proof[$proof.Count - 1].sha256) { $protected++; continue }
      $inventory = [IO.File]::ReadAllText($inventoryPath, $utf8) | ConvertFrom-Json
      if ($inventory.schemaVersion -ne 1 -or $inventory.executable -ne $appEntryNames[0] -or -not $inventory.fileHashes) { $protected++; continue }
      $hashes = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
      foreach ($file in $inventory.files) {
        $digest = [string]$inventory.fileHashes.$file
        if (-not [NuwaxRecoveryRetentionIO]::ValidRelative($file) -or $digest -notmatch '^[a-f0-9]{64}$') { throw 'Invalid recovery payload hash.' }
        $hashes.Add($file, $digest)
      }
      if (-not $hashes.ContainsKey($appEntryNames[0])) { throw 'Incomplete recovery ownership inventory.' }
      $directories = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
      foreach ($directory in $inventory.directories) {
        if (-not [NuwaxRecoveryRetentionIO]::ValidRelative($directory) -or -not $directories.Add($directory)) { throw 'Invalid recovery payload directory.' }
      }
      $moves = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
      foreach ($record in $candidate.history) {
        if ($record.status -ne 'planned') { continue }
        if (-not [string]::Equals([IO.Path]::GetDirectoryName([string]$record.original), $InstallRoot, $pathComparison) -or
            -not [string]::Equals([IO.Path]::GetDirectoryName([string]$record.backup), $candidate.path, $pathComparison) -or
            [IO.Path]::GetFileName([string]$record.backup) -notmatch '^entry-[0-9]{6,}$') { throw 'Invalid recovery move.' }
        $moves.Add([IO.Path]::GetFileName([string]$record.backup), [IO.Path]::GetFileName([string]$record.original))
      }
      $registrationHash = ''
      $registrationPath = [IO.Path]::Combine($candidate.extended, 'registration.json')
      if (Test-EntryExists $registrationPath) {
        $registrationProof = @($candidate.history | Where-Object { $_.status -eq 'registration-snapshot-recorded' })
        if (-not $registrationProof.Count) { throw 'Registration snapshot ownership is missing.' }
        # The transaction uses base64 digests; the pruning IO uses hex.
        $registrationHash = [BitConverter]::ToString([Convert]::FromBase64String($registrationProof[-1].sha256)).Replace('-', '').ToLowerInvariant()
      }
      if ([NuwaxRecoveryRetentionIO]::Prune($candidate.extended, $moves, $hashes, $directories, $proof[$proof.Count - 1].uninstallerSha256, $registrationHash)) {
        $deleted++; Write-Output ('Backup deleted: ' + $candidate.path + '; reason=verified-expired-payload')
      } else {
        $protected++; Write-Output ('Backup retained: ' + $candidate.path + '; reason=unknown-or-modified-content')
      }
    } catch { $protected++; Write-Output ('Backup retained: ' + $candidate.path + ': ' + $_.Exception.Message) }
  }
  Write-Output "Backup retention: deleted=$deleted protected=$protected; keep latest=1, older backups expire after 7 days."
}
