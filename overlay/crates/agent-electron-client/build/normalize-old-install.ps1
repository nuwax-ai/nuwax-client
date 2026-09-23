param([Parameter(Mandatory = $true)][string]$InstallDir)

# electron-builder's old NSIS uninstaller renames every entry before an update.
# Win32 normalizes names ending in a dot or space, so Rename fails on files such
# as `._.` even though they can be enumerated. Move those entries out of the
# installation directory with extended-length paths before running it.
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($InstallDir)
$volumeRoot = [System.IO.Path]::GetPathRoot($root)
if ($root.TrimEnd('\') -eq $volumeRoot.TrimEnd('\')) {
  throw 'Refusing to inspect a volume root as an application directory.'
}
$root = $root.TrimEnd('\')
$extendedRoot = '\\?\' + $root
if (-not [System.IO.Directory]::Exists($extendedRoot)) {
  exit 0
}

$stack = New-Object 'System.Collections.Generic.Stack[string]'
$stack.Push($extendedRoot)
$recoveryDir = $null
$moved = 0

while ($stack.Count -gt 0) {
  $dir = $stack.Pop()
  foreach ($entry in [System.IO.Directory]::EnumerateFileSystemEntries($dir)) {
    $name = [System.IO.Path]::GetFileName($entry)
    $attributes = [System.IO.File]::GetAttributes($entry)
    $isDirectory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0

    if ($name.EndsWith('.') -or $name.EndsWith(' ')) {
      if ($null -eq $recoveryDir) {
        $suffix = [System.Guid]::NewGuid().ToString('N').Substring(0, 8)
        $folder = 'Nuwax-installer-recovery-{0}-{1}' -f [System.DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'), $suffix
        $recoveryDir = [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName($root), $folder)
        [System.IO.Directory]::CreateDirectory($recoveryDir) | Out-Null
      }

      $destination = [System.IO.Path]::Combine($recoveryDir, ('entry-{0:D6}' -f $moved))
      $extendedDestination = '\\?\' + $destination
      if ($isDirectory) {
        [System.IO.Directory]::Move($entry, $extendedDestination)
      } else {
        [System.IO.File]::Move($entry, $extendedDestination)
      }
      # Keep the original name and location for manual recovery. The backup is
      # deliberately outside InstallDir, which the old uninstaller removes.
      $record = @{ original = $entry.Substring(4); backup = $destination }
      $record | ConvertTo-Json -Compress | Out-File -FilePath ([System.IO.Path]::Combine($recoveryDir, 'manifest.jsonl')) -Append -Encoding UTF8
      $moved++
    } elseif ($isDirectory -and (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0)) {
      $stack.Push($entry)
    }
  }
}

if ($moved -gt 0) {
  Write-Output "Moved $moved incompatible entries to $recoveryDir"
}
