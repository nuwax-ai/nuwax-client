# Dot-sourced by normalize-old-install.ps1. Ownership comes from the old
# uninstaller's recorded build inventory or byte-identical files in the new
# installer's embedded inventory. Completed preservation archives are
# disposable once their transaction and installation path are verified.
function Assert-RecoveryCleanupMayContinue {
  if ($Action -ne 'Cleanup') { return }
  $held = $false
  try {
    try { $held = $script:recoveryForegroundMutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $held = $true }
    if (-not $held) { throw [OperationCanceledException]::new('An installation operation is waiting for backup cleanup.') }
  } finally { if ($held) { $script:recoveryForegroundMutex.ReleaseMutex() } }
}

function Stop-LegacyRecoveryRetention([string]$InstallRoot) {
  # Older releases cannot yield. Match only the detached runtime created by
  # Start-RecoveryRetention, including its owner, exact arguments and process
  # identity. Interrupting this worker can only leave old backups unfinished.
  $pattern = '^"?(?<exe>[A-Za-z]:\\[^"\r\n]*?\\powershell\.exe)"?\s+-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "(?<script>[^"\r\n]+)" -Action Cleanup -CleanupRuntime -StatePath "(?<state>[^"\r\n]+)" -InstallDir "(?<root>[^"\r\n]+)"\s*$'
  $tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([char]92)
  $executables = @("$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe", "$env:WINDIR\SysWOW64\WindowsPowerShell\v1.0\powershell.exe")
  foreach ($candidate in @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue)) {
    $match = [regex]::Match([string]$candidate.CommandLine, $pattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $match.Success -or -not [string]::Equals($match.Groups['root'].Value, $InstallRoot, $pathComparison)) { continue }
    $process = $null
    try {
      $scriptPath = [IO.Path]::GetFullPath($match.Groups['script'].Value)
      $runtime = [IO.Path]::GetDirectoryName($scriptPath)
      if (-not [string]::Equals([IO.Path]::GetDirectoryName($runtime), $tempParent, $pathComparison) -or
          [IO.Path]::GetFileName($runtime) -notmatch '^Nuwax-backup-cleanup-[0-9a-f]{32}$' -or
          [IO.Path]::GetFileName($scriptPath) -ine 'normalize-old-install.ps1' -or
          -not [string]::Equals($match.Groups['state'].Value, (Join-Path $runtime 'state.txt'), $pathComparison) -or
          $match.Groups['exe'].Value -notin $executables -or $candidate.ExecutablePath -notin $executables) { continue }
      Assert-NoRecoveryRedirect $scriptPath
      $ownerPath = Join-Path $runtime 'owner.json'
      Assert-NoRecoveryRedirect $ownerPath
      $owner = [IO.File]::ReadAllText($ownerPath, $utf8) | ConvertFrom-Json
      if ($owner.kind -ne 'Nuwax backup cleanup' -or -not [string]::Equals([string]$owner.installDir, $InstallRoot, $pathComparison) -or
          [IO.File]::ReadAllText($scriptPath, $utf8).Contains('recoveryForegroundMutex')) { continue }
      $process = [Diagnostics.Process]::GetProcessById($candidate.ProcessId)
      $null = $process.Handle
      # CIM supports both bitnesses. MainModule cannot inspect a 64-bit worker
      # from NSIS's 32-bit PowerShell, and System32 can redirect to SysWOW64.
      # WMI truncates FILETIME's 100 ns precision to microseconds.
      if ([Math]::Abs(($process.StartTime.ToUniversalTime() - $candidate.CreationDate.ToUniversalTime()).Ticks) -ge 10) { continue }
      $process.Kill()
      if (-not $process.WaitForExit(5000)) { throw 'Legacy cleanup did not exit.' }
      # Stdout is the NSIS Inspect/Prepare protocol. Keep diagnostics separate.
      $event = @{ atUtc = [DateTime]::UtcNow.ToString('o'); action = 'LegacyCleanupInterrupted'; installDir = $InstallRoot; processId = $candidate.ProcessId }
      try { [IO.File]::AppendAllText((Join-Path ([IO.Path]::GetTempPath()) 'Nuwax-installer-recovery-events.jsonl'), ($event | ConvertTo-Json -Compress) + [Environment]::NewLine) } catch { }
    } catch {
      $event = @{ atUtc = [DateTime]::UtcNow.ToString('o'); action = 'LegacyCleanupRetained'; installDir = $InstallRoot; error = $_.Exception.Message }
      try { [IO.File]::AppendAllText((Join-Path ([IO.Path]::GetTempPath()) 'Nuwax-installer-recovery-events.jsonl'), ($event | ConvertTo-Json -Compress) + [Environment]::NewLine) } catch { }
    }
    finally { if ($process) { $process.Dispose() } }
  }
}

function Remove-RecoveryRetentionRuntime([string]$RuntimeDirectory, [string]$InstallRoot) {
  $tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([char]92)
  if (-not [string]::Equals([IO.Path]::GetDirectoryName($RuntimeDirectory), $tempParent, $pathComparison) -or
      [IO.Path]::GetFileName($RuntimeDirectory) -notmatch '^Nuwax-backup-cleanup-[0-9a-f]{32}$' -or
      ([IO.File]::GetAttributes($RuntimeDirectory) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Invalid cleanup runtime directory.' }
  $owner = [IO.File]::ReadAllText((Join-Path $RuntimeDirectory 'owner.json'), $utf8) | ConvertFrom-Json
  if ($owner.kind -ne 'Nuwax backup cleanup' -or -not [string]::Equals($owner.installDir, $InstallRoot, $pathComparison)) { throw 'Cleanup runtime ownership mismatch.' }
  foreach ($file in @('normalize-old-install.ps1', 'installer-backup-retention.ps1', 'installed-payload.json', 'owner.json')) {
    [IO.File]::Delete((Join-Path $RuntimeDirectory $file))
  }
  [IO.Directory]::Delete($RuntimeDirectory, $false)
}

function Start-RecoveryRetention([string]$InstallRoot, [string]$InventoryPath) {
  # NSIS deletes PLUGINSDIR on exit. Give the detached worker its own small,
  # self-cleaning runtime so scanning old backups cannot hold up the new app.
  $runtime = Join-Path ([IO.Path]::GetTempPath()) ('Nuwax-backup-cleanup-' + [Guid]::NewGuid().ToString('N'))
  [IO.Directory]::CreateDirectory($runtime) | Out-Null
  [IO.File]::WriteAllText((Join-Path $runtime 'owner.json'), ((@{ kind = 'Nuwax backup cleanup'; installDir = $InstallRoot } | ConvertTo-Json -Compress)), $utf8)
  try {
    [IO.File]::Copy($script:recoveryRuntimePath, (Join-Path $runtime 'normalize-old-install.ps1'))
    [IO.File]::Copy((Join-Path ([IO.Path]::GetDirectoryName($script:recoveryRuntimePath)) 'installer-backup-retention.ps1'), (Join-Path $runtime 'installer-backup-retention.ps1'))
    [IO.File]::Copy($InventoryPath, (Join-Path $runtime 'installed-payload.json'))
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path $runtime 'normalize-old-install.ps1') + '" -Action Cleanup -CleanupRuntime -StatePath "' + (Join-Path $runtime 'state.txt') + '" -InstallDir "' + $InstallRoot + '" -PayloadInventoryPath "' + (Join-Path $runtime 'installed-payload.json') + '"'
    # ShellExecute detaches the worker's handles. Redirecting streams here uses
    # CreateProcess handle inheritance and can keep NSIS's output pipe open
    # until cleanup exits. The worker writes its own log instead.
    Start-Process -FilePath "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList $arguments -WindowStyle Hidden
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
  if ('NuwaxRecoveryRetentionIO' -as [type]) {
    [NuwaxRecoveryRetentionIO]::ForegroundMutex = $script:recoveryForegroundMutex
    return
  }
  Add-Type -ReferencedAssemblies @([Uri].Assembly.Location, [Collections.Generic.HashSet[string]].Assembly.Location) -TypeDefinition @'
using System;
using System.IO;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Threading;

public static class NuwaxRecoveryRetentionIO {
  public static Mutex ForegroundMutex;
  static void CheckForeground() {
    if (ForegroundMutex == null) return;
    bool held = false;
    try {
      try { held = ForegroundMutex.WaitOne(0); }
      catch (AbandonedMutexException) { held = true; }
      if (!held) throw new OperationCanceledException("An installation operation is waiting for backup cleanup.");
    } finally { if (held) ForegroundMutex.ReleaseMutex(); }
  }
  static readonly HashSet<string> Controls = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
    "manifest.jsonl", "payload-inventory.json", "uninstaller-backup.exe", "registration.json"
  };
  static void Guard(string path) {
    CheckForeground();
    for (string p = path; !String.IsNullOrEmpty(p); p = Path.GetDirectoryName(p)) {
      if ((File.GetAttributes(p) & FileAttributes.ReparsePoint) != 0)
        throw new IOException("Recovery path is redirected.");
      if (String.Equals(p.TrimEnd('\\'), Path.GetPathRoot(p).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) break;
    }
  }
  public static string Hash(string path) {
    Guard(path);
    using (var sha = SHA256.Create())
    using (var stream = File.OpenRead(path)) {
      var buffer = new byte[1024 * 1024];
      int count;
      while ((count = stream.Read(buffer, 0, buffer.Length)) != 0) {
        CheckForeground();
        sha.TransformBlock(buffer, 0, count, buffer, 0);
      }
      sha.TransformFinalBlock(buffer, 0, 0);
      return BitConverter.ToString(sha.Hash).Replace("-", "").ToLowerInvariant();
    }
  }
  public static bool ValidRelative(string path) {
    if (String.IsNullOrEmpty(path) || path.IndexOfAny(new char[] {'\\', ':'}) >= 0) return false;
    foreach (char c in path) if (c < 32) return false;
    foreach (string segment in path.Split('/'))
      if (segment == "" || segment == "." || segment == ".." || segment.EndsWith(".") || segment.EndsWith(" ")) return false;
    return true;
  }
  public sealed class CleanupResult {
    public long DeletedBytes;
    public int PreservedFiles;
  }
  static void GuardDestination(string path) {
    Guard(Path.GetDirectoryName(path));
    try { File.GetAttributes(path); }
    catch (FileNotFoundException) { return; }
    catch (DirectoryNotFoundException) { return; }
    Guard(path); // Includes dangling reparse entries which File.Exists hides.
  }
  static void CreatePreservationDirectory(string path) {
    string existing = path;
    while (true) {
      FileAttributes attributes;
      try { attributes = File.GetAttributes(existing); }
      catch (FileNotFoundException) { existing = Path.GetDirectoryName(existing); continue; }
      catch (DirectoryNotFoundException) { existing = Path.GetDirectoryName(existing); continue; }
      Guard(existing);
      if ((attributes & FileAttributes.Directory) == 0) throw new IOException("Preservation path conflicts with a file.");
      break;
    }
    Directory.CreateDirectory(path);
    Guard(path);
  }
  static void CopyMetadata(string source, string destination) {
    Guard(source);
    GuardDestination(destination);
    if (File.Exists(destination)) {
      if (Hash(source) != Hash(destination)) throw new IOException("Preserved transaction metadata conflicts.");
      return;
    }
    File.Copy(source, destination, false);
  }
  static void RemoveVerified(string file, string expected) {
    if (Hash(file) != expected) throw new IOException("Recovery file changed during cleanup.");
    RemoveFile(file);
  }
  static void RemoveFile(string file) {
    Guard(file);
    var attributes = File.GetAttributes(file);
    try {
      if ((attributes & FileAttributes.ReadOnly) != 0) File.SetAttributes(file, attributes & ~FileAttributes.ReadOnly);
      File.Delete(file);
    } catch {
      if (File.Exists(file)) File.SetAttributes(file, attributes);
      throw;
    }
  }
  public sealed class PreservedCleanupResult {
    public long DeletedBytes;
    public long RemainingBytes;
    public int InaccessibleEntries;
    public string FirstError;
    public bool Removed;
    public void RecordError(Exception error) {
      InaccessibleEntries++;
      if (FirstError == null) FirstError = error.Message;
    }
  }
  static void RemoveArchivedFile(string file) {
    for (int attempt = 0; ; attempt++) {
      try { RemoveFile(file); return; }
      catch (IOException error) {
        int code = error.HResult & 0xffff;
        if (attempt == 2 || (code != 32 && code != 33)) throw;
        CheckForeground();
        Thread.Sleep(200);
      }
    }
  }
  public static PreservedCleanupResult PrunePreserved(string root, string manifest, string manifestHash) {
    Guard(root);
    Guard(manifest);
    string transaction = Path.GetDirectoryName(manifest);
    long manifestLength = new FileInfo(manifest).Length;
    var result = new PreservedCleanupResult { RemainingBytes = manifestLength };
    var pending = new Stack<string>();
    var directories = new Stack<string>();
    pending.Push(root);
    while (pending.Count != 0) {
      string entry = pending.Pop();
      long length = 0;
      try {
        Guard(entry);
        if ((File.GetAttributes(entry) & FileAttributes.Directory) != 0) {
          if (!String.Equals(entry, root, StringComparison.OrdinalIgnoreCase) &&
              !String.Equals(entry, transaction, StringComparison.OrdinalIgnoreCase)) directories.Push(entry);
          foreach (string child in Directory.GetFileSystemEntries(entry))
            if (!String.Equals(child, manifest, StringComparison.OrdinalIgnoreCase)) pending.Push(child);
          continue;
        }
        length = new FileInfo(entry).Length;
        RemoveArchivedFile(entry);
        result.DeletedBytes += length;
      } catch (IOException error) { result.RecordError(error); result.RemainingBytes += length; }
        catch (UnauthorizedAccessException error) { result.RecordError(error); result.RemainingBytes += length; }
    }
    foreach (string directory in directories) {
      try {
        Guard(directory);
        if (Directory.GetFileSystemEntries(directory).Length == 0) Directory.Delete(directory, false);
      } catch (IOException error) { result.RecordError(error); }
        catch (UnauthorizedAccessException error) { result.RecordError(error); }
    }
    if (result.InaccessibleEntries != 0) return result;

    // Keep the manifest while files are inaccessible or a foreground install
    // needs the lock. The next successful install can resume the same archive.
    bool finishing = false;
    try {
      if (ForegroundMutex != null) {
        try { finishing = ForegroundMutex.WaitOne(0); }
        catch (AbandonedMutexException) { finishing = true; }
        if (!finishing) throw new OperationCanceledException("An installation operation is waiting for backup cleanup.");
      }
      Guard(root);
      Guard(transaction);
      var rootEntries = Directory.GetFileSystemEntries(root);
      var transactionEntries = Directory.GetFileSystemEntries(transaction);
      if (rootEntries.Length != 1 || !String.Equals(rootEntries[0], transaction, StringComparison.OrdinalIgnoreCase) ||
          transactionEntries.Length != 1 || !String.Equals(transactionEntries[0], manifest, StringComparison.OrdinalIgnoreCase))
        throw new IOException("Preserved archive contents changed during cleanup.");
      RemoveVerified(manifest, manifestHash);
      result.DeletedBytes += manifestLength;
      result.RemainingBytes -= manifestLength;
      Directory.Delete(transaction, false);
      Directory.Delete(root, false);
      result.Removed = true;
    } catch (IOException error) { result.RecordError(error); }
      catch (UnauthorizedAccessException error) { result.RecordError(error); }
    finally { if (finishing) ForegroundMutex.ReleaseMutex(); }
    return result;
  }
  public static CleanupResult Prune(string root, Dictionary<string,string> moves,
      Dictionary<string,HashSet<string>> hashes, HashSet<string> ownedDirectories,
      Dictionary<string,string> controlHashes, string preservedRoot) {
    Guard(root);
    var result = new CleanupResult();
    var verified = new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
    var controls = new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
    var preserved = new List<string>();
    var directories = new List<string>();
    var pending = new Stack<KeyValuePair<string,string>>();
    foreach (string entry in Directory.GetFileSystemEntries(root)) {
      Guard(entry);
      string name = Path.GetFileName(entry);
      if (Controls.Contains(name)) {
        if ((File.GetAttributes(entry) & FileAttributes.Directory) != 0) throw new IOException("Recovery metadata is not a regular file.");
        string expected;
        if (controlHashes.TryGetValue(name, out expected) && Hash(entry) == expected) controls.Add(entry, expected);
        else preserved.Add(entry);
      } else {
        string original;
        moves.TryGetValue(name, out original);
        pending.Push(new KeyValuePair<string,string>(entry, original));
      }
    }
    // Inspect program entries before mutating them. Unknown subtrees move as
    // opaque directories, preserving their structure, attributes and ACLs.
    // Redirected program paths protect the transaction; no deletion follows links.
    while (pending.Count != 0) {
      var entry = pending.Pop();
      Guard(entry.Key);
      if ((File.GetAttributes(entry.Key) & FileAttributes.Directory) != 0) {
        if (entry.Value == null || !ownedDirectories.Contains(entry.Value)) {
          preserved.Add(entry.Key);
          continue;
        }
        directories.Add(entry.Key);
        foreach (string child in Directory.GetFileSystemEntries(entry.Key))
          pending.Push(new KeyValuePair<string,string>(child, entry.Value == null ? null : entry.Value + "/" + Path.GetFileName(child)));
      } else {
        HashSet<string> expected;
        string actual = null;
        if (entry.Value != null && hashes.TryGetValue(entry.Value, out expected)) {
          actual = Hash(entry.Key);
          if (!expected.Contains(actual)) actual = null;
        }
        if (actual == null) preserved.Add(entry.Key);
        else verified.Add(entry.Key, actual);
      }
    }
    if (preserved.Count != 0) {
      // A sibling on the same volume allows atomic moves without copying large
      // personal files. Keep the original entry names plus the path manifest.
      CreatePreservationDirectory(preservedRoot);
      string metadata = Path.Combine(preservedRoot, "transaction");
      CreatePreservationDirectory(metadata);
      foreach (string name in Controls) {
        string source = Path.Combine(root, name);
        if (File.Exists(source)) CopyMetadata(source, Path.Combine(metadata, name));
      }
      foreach (string file in preserved) {
        Guard(file);
        string destination = Path.Combine(preservedRoot, "files", file.Substring(root.Length + 1));
        string parent = Path.GetDirectoryName(destination);
        CreatePreservationDirectory(parent);
        GuardDestination(destination);
        CheckForeground();
        bool directory = (File.GetAttributes(file) & FileAttributes.Directory) != 0;
        if (directory) Directory.Move(file, destination);
        else File.Move(file, destination); // Never overwrite an earlier preserved file.
        result.PreservedFiles++;
      }
    }
    foreach (var file in verified) {
      long length = new FileInfo(file.Key).Length;
      RemoveVerified(file.Key, file.Value);
      result.DeletedBytes += length;
    }
    directories.Sort((a,b) => b.Length.CompareTo(a.Length));
    foreach (string directory in directories) { Guard(directory); Directory.Delete(directory, false); }
    // A concurrently added entry prevents removal. Metadata stays until every
    // payload/user entry has either been verified and deleted or moved safely.
    foreach (string entry in Directory.GetFileSystemEntries(root)) {
      Guard(entry);
      if (!controls.ContainsKey(entry)) throw new IOException("Recovery content changed during cleanup.");
    }
    // Final metadata removal is short and must not yield halfway through,
    // otherwise a new foreground operation could leave a backup with no path
    // manifest to resume. Keep the manifest until the other controls are gone.
    bool finishing = false;
    try {
      if (ForegroundMutex != null) {
        try { finishing = ForegroundMutex.WaitOne(0); }
        catch (AbandonedMutexException) { finishing = true; }
        if (!finishing) throw new OperationCanceledException("An installation operation is waiting for backup cleanup.");
      }
      string manifest = Path.Combine(root, "manifest.jsonl");
      foreach (var control in controls)
        if (!String.Equals(control.Key, manifest, StringComparison.OrdinalIgnoreCase)) RemoveVerified(control.Key, control.Value);
      RemoveVerified(manifest, controls[manifest]);
      Guard(root);
      Directory.Delete(root, false);
    } finally { if (finishing) ForegroundMutex.ReleaseMutex(); }
    return result;
  }
}
'@
  [NuwaxRecoveryRetentionIO]::ForegroundMutex = $script:recoveryForegroundMutex
}

function Add-RecoveryInventoryHashes($Inventory, $Hashes, $Directories) {
  if ($Inventory.schemaVersion -ne 1 -or $Inventory.executable -ne $appEntryNames[0] -or -not $Inventory.fileHashes -or
      $appEntryNames[0] -notin $Inventory.files) { throw 'Invalid embedded recovery ownership inventory.' }
  foreach ($file in $Inventory.files) {
    Assert-RecoveryCleanupMayContinue
    $digest = [string]$Inventory.fileHashes.$file
    if (-not [NuwaxRecoveryRetentionIO]::ValidRelative($file) -or $digest -notmatch '^[a-f0-9]{64}$') { throw 'Invalid recovery payload hash.' }
    if (-not $Hashes.ContainsKey($file)) { $Hashes.Add($file, [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)) }
    $null = $Hashes[$file].Add($digest)
  }
  foreach ($directory in $Inventory.directories) {
    if (-not [NuwaxRecoveryRetentionIO]::ValidRelative($directory)) { throw 'Invalid recovery payload directory.' }
    $null = $Directories.Add($directory)
  }
}

function Invoke-RecoveryRetention([string]$InstallRoot) {
  Assert-RecoveryCleanupMayContinue
  $recoveryParent = [IO.Path]::GetDirectoryName($InstallRoot)
  if (Test-EntryExists (Get-ExtendedPath (Get-MarkerPath $InstallRoot))) {
    Write-Output 'Backup retention skipped: an upgrade recovery is active.'
    return
  }
  Initialize-RecoveryRetentionIO
  Assert-NoRecoveryRedirect $PayloadInventoryPath
  $currentInventory = [IO.File]::ReadAllText($PayloadInventoryPath, $utf8) | ConvertFrom-Json
  $backup = @{ deleted = 0; retained = 0; deletedBytes = [long]0 }
  $archive = @{ deleted = 0; retained = 0; deletedBytes = [long]0; remainingBytes = [long]0; inaccessibleEntries = 0 }
  Invoke-RecoveryRetentionPass $InstallRoot $recoveryParent $currentInventory $backup
  # Enumerate after the backup pass so this also processes newly created archives.
  Invoke-RecoveryRetentionPass $InstallRoot $recoveryParent $currentInventory $archive -Preserved
  Write-Output "Preserved cleanup: deleted=$($archive.deleted) retained=$($archive.retained) deletedBytes=$($archive.deletedBytes) measuredRemainingBytes=$($archive.remainingBytes) inaccessibleEntries=$($archive.inaccessibleEntries)"
  Write-Output "Backup retention: deleted=$($backup.deleted) protected=$($backup.retained) deletedBytes=$($backup.deletedBytes); all completed backups eligible, including the latest."
}

function Invoke-RecoveryRetentionPass([string]$InstallRoot, [string]$RecoveryParent, $CurrentInventory, $Totals, [switch]$Preserved) {
  $prefix = if ($Preserved) { 'Nuwax-preserved-install-files-' } else { 'Nuwax-installer-recovery-' }
  $label = if ($Preserved) { 'Preserved archive' } else { 'Backup' }
  foreach ($folder in [IO.Directory]::GetDirectories((Get-ExtendedPath $RecoveryParent), ($prefix + '*'))) {
    Assert-RecoveryCleanupMayContinue
    $plainFolder = $folder.Substring(4)
    try {
      $name = [IO.Path]::GetFileName($folder)
      if ($name -notmatch ('^' + $prefix + '(?<id>\d{8}T\d{6}Z-[0-9a-f]{32})$')) { continue }
      $id = $Matches['id']
      Assert-NoRecoveryRedirect $folder
      $recovery = [IO.Path]::Combine($RecoveryParent, ('Nuwax-installer-recovery-' + $id))
      $metadata = if ($Preserved) { [IO.Path]::Combine($folder, 'transaction') } else { $folder }
      $manifest = [IO.Path]::Combine($metadata, 'manifest.jsonl')
      Assert-NoRecoveryRedirect $manifest
      # Other products/installation paths may share this parent. Their long
      # histories must not delay cleanup or be parsed as our recovery work.
      $reader = [IO.StreamReader]::new($manifest, $utf8)
      try {
        do { $firstLine = $reader.ReadLine() } while ($null -ne $firstLine -and [string]::IsNullOrWhiteSpace($firstLine))
      } finally { $reader.Dispose() }
      if (-not $firstLine) { throw 'Empty recovery manifest.' }
      $start = $firstLine | ConvertFrom-Json
      if ($start.status -ne 'start' -or
          -not [string]::Equals([string]$start.installDir, $InstallRoot, $pathComparison) -or
          -not [string]::Equals([string]$start.recoveryDir, $recovery, $pathComparison)) { continue }
      if ($Preserved -and (Test-EntryExists (Get-ExtendedPath $recovery))) {
        $Totals.retained++; Write-Output "$label retained: $plainFolder; reason=recovery-backup-still-present"; continue
      }
      $manifestHash = [NuwaxRecoveryRetentionIO]::Hash($manifest)
      $history = Read-Manifest $manifest
      if ([NuwaxRecoveryRetentionIO]::Hash($manifest) -ne $manifestHash) { throw 'Recovery manifest changed during inspection.' }
      if ($history.Count -eq 0 -or $history[0].status -ne 'start' -or
          -not [string]::Equals([string]$history[0].installDir, $InstallRoot, $pathComparison) -or
          -not [string]::Equals([string]$history[0].recoveryDir, $recovery, $pathComparison)) { throw 'Recovery manifest changed during inspection.' }
      if ($history[$history.Count - 1].status -notin @('restore-complete', 'rollback-complete') -or
          @($history | Where-Object { $_.status -eq 'complete' }).Count -eq 0) {
        $Totals.retained++; Write-Output "$label retained: $plainFolder; reason=unfinished-transaction"; continue
      }
      $moves = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
      $originals = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
      foreach ($record in $history) {
        Assert-RecoveryCleanupMayContinue
        if ($record.status -ne 'planned') { continue }
        $originalName = [IO.Path]::GetFileName([string]$record.original)
        if (-not [string]::Equals([IO.Path]::GetDirectoryName([string]$record.original), $InstallRoot, $pathComparison) -or
            -not [string]::Equals([IO.Path]::GetDirectoryName([string]$record.backup), $recovery, $pathComparison) -or
            [IO.Path]::GetFileName([string]$record.backup) -notmatch '^entry-[0-9]{6,}$' -or
            -not [NuwaxRecoveryRetentionIO]::ValidRelative($originalName) -or -not $originals.Add($originalName)) { throw 'Invalid recovery move.' }
        $moves.Add([IO.Path]::GetFileName([string]$record.backup), $originalName)
      }
      if ($Preserved) {
        $result = [NuwaxRecoveryRetentionIO]::PrunePreserved($folder, $manifest, $manifestHash)
        $Totals.deletedBytes += $result.DeletedBytes
        $Totals.remainingBytes += $result.RemainingBytes
        $Totals.inaccessibleEntries += $result.InaccessibleEntries
        if ($result.Removed) {
          $Totals.deleted++
          Write-Output "Preserved archive deleted: $plainFolder; deletedBytes=$($result.DeletedBytes)"
        } else {
          $Totals.retained++
          Write-Output "Preserved archive retained: $plainFolder; reason=$($result.FirstError); deletedBytes=$($result.DeletedBytes); measuredRemainingBytes=$($result.RemainingBytes); inaccessibleEntries=$($result.InaccessibleEntries)"
        }
        continue
      }
      $hashes = [Collections.Generic.Dictionary[string,Collections.Generic.HashSet[string]]]::new([StringComparer]::OrdinalIgnoreCase)
      $directories = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
      Add-RecoveryInventoryHashes $currentInventory $hashes $directories
      $controls = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
      $controls.Add('manifest.jsonl', $manifestHash)
      $proof = @($history | Where-Object { $_.status -eq 'payload-inventory-recorded' })
      $inventoryPath = [IO.Path]::Combine($metadata, 'payload-inventory.json')
      if ($proof.Count -gt 0) {
        $lastProof = $proof[-1]
        if ($lastProof.uninstallerSha256 -match '^[a-f0-9]{64}$') { $controls.Add('uninstaller-backup.exe', $lastProof.uninstallerSha256) }
        if ((Test-EntryExists $inventoryPath) -and [NuwaxRecoveryRetentionIO]::Hash($inventoryPath) -eq $lastProof.sha256) {
          $oldInventory = [IO.File]::ReadAllText($inventoryPath, $utf8) | ConvertFrom-Json
          Add-RecoveryInventoryHashes $oldInventory $hashes $directories
          $controls.Add('payload-inventory.json', $lastProof.sha256)
        }
      }
      $registrationProof = @($history | Where-Object { $_.status -eq 'registration-snapshot-recorded' })
      if ($registrationProof.Count -gt 0) {
        $digest = [BitConverter]::ToString([Convert]::FromBase64String($registrationProof[-1].sha256)).Replace('-', '').ToLowerInvariant()
        if ($digest -notmatch '^[a-f0-9]{64}$') { throw 'Invalid registration snapshot digest.' }
        $controls.Add('registration.json', $digest)
      }
      $archivePath = [IO.Path]::Combine((Get-ExtendedPath $RecoveryParent), ('Nuwax-preserved-install-files-' + $id))
      $result = [NuwaxRecoveryRetentionIO]::Prune($folder, $moves, $hashes, $directories, $controls, $archivePath)
      $Totals.deleted++
      $Totals.deletedBytes += $result.DeletedBytes
      Write-Output "Backup deleted: $plainFolder; reason=completed-installation; deletedBytes=$($result.DeletedBytes)"
      if ($result.PreservedFiles -gt 0) { Write-Output "Unproven entries transferred: $($archivePath.Substring(4)); entries=$($result.PreservedFiles)" }
    } catch {
      Assert-RecoveryCleanupMayContinue
      $Totals.retained++
      if ($Preserved) { $Totals.inaccessibleEntries++ }
      Write-Output "$label retained: $plainFolder; $($_.Exception.Message)"
    }
  }
}
