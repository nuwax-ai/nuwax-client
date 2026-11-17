param(
  [string]$InstallDir,
  [string]$TempPath,
  [string]$CachePath,
  [string]$InstallerPath,
  [long]$UnpackedSizeKB,
  [string]$ReportPath,
  [switch]$SevenZip,
  [switch]$FunctionsOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-InstallSpaceBudget {
  param([object[]]$Requests, [scriptblock]$ResolveVolume)
  $volumes = @{}
  foreach ($request in $Requests) {
    if ([decimal]$request.Bytes -le 0 -or [decimal]$request.Bytes -gt [long]::MaxValue) { throw 'Invalid payload size.' }
    $volume = & $ResolveVolume ([string]$request.Path)
    if (-not $volume.Id -or [decimal]$volume.Available -lt 0) { throw 'Invalid volume information.' }
    if (-not $volumes.ContainsKey($volume.Id)) {
      $volumes[$volume.Id] = [pscustomobject]@{ Id = $volume.Id; Display = $volume.Display; Available = [long]$volume.Available; Payload = [decimal]0; Roles = @() }
    }
    $entry = $volumes[$volume.Id]
    $entry.Available = [Math]::Min($entry.Available, [long]$volume.Available)
    $entry.Payload += [decimal]$request.Bytes
    $entry.Roles += [string]$request.Role
  }
  foreach ($entry in @($volumes.Values | Sort-Object Display)) {
    # Do not count the already-downloaded source EXE again, or assume that an
    # existing installation/cache/backup can be deleted to make space.
    $margin = [Math]::Max([decimal](256MB), [Math]::Ceiling($entry.Payload / 20))
    $required = $entry.Payload + $margin
    if ($required -gt [long]::MaxValue) { throw 'Space budget exceeds the supported range.' }
    [pscustomobject]@{ Volume = $entry.Display; Roles = ($entry.Roles -join '、'); Required = [long]$required; Available = $entry.Available; Shortfall = [long][Math]::Max([decimal]0, $required - $entry.Available) }
  }
}

function Format-InstallSpaceBudget {
  param([object[]]$Budget)
  foreach ($entry in $Budget) {
    '{0}（{1}）：需要 {2:N2} GiB，可用 {3:N2} GiB，缺少 {4:N2} GiB。' -f $entry.Volume, $entry.Roles, ([Math]::Ceiling($entry.Required / 1GB * 100) / 100), ([Math]::Floor($entry.Available / 1GB * 100) / 100), ([Math]::Ceiling($entry.Shortfall / 1GB * 100) / 100)
  }
}

function Get-InstallSpaceVolume {
  param([string]$Path)
  if (-not ('Nuwax.InstallSpaceNative' -as [type])) {
    # Absolute framework references avoid the installer's System.dll plugin
    # being mistaken for the framework assembly by Windows PowerShell 5.1.
    Add-Type -ReferencedAssemblies @([Uri].Assembly.Location, [Collections.Generic.HashSet[string]].Assembly.Location) -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
namespace Nuwax {
  public static class InstallSpaceNative {
    [DllImport("kernel32.dll", EntryPoint="CreateFileW", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern Microsoft.Win32.SafeHandles.SafeFileHandle OpenDirectory(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    public static void RequireDirectoryWriteAccess(string path) {
      // FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY. No delete-on-close for this
      // existing directory; this checks the current token without changing ACLs.
      using (var h = OpenDirectory(path, 6, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
        if (h.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      }
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool GetVolumePathName(string path, StringBuilder volume, uint length);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool GetVolumeNameForVolumeMountPoint(string path, StringBuilder name, uint length);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool GetDiskFreeSpaceEx(string path, out ulong available, out ulong total, out ulong free);
  }
}
'@
  }
  if ([string]::IsNullOrWhiteSpace($Path) -or $Path -notmatch '^[A-Za-z]:[\\/]') { throw 'A local absolute path is required.' }
  $existing = [IO.Path]::GetFullPath($Path)
  while (-not [IO.Directory]::Exists($existing)) {
    $parent = [IO.Path]::GetDirectoryName($existing.TrimEnd([char]92))
    if (-not $parent -or $parent -eq $existing) { throw 'The path has no accessible parent directory.' }
    $existing = $parent
  }
  $mount = [Text.StringBuilder]::new(32768)
  $identity = [Text.StringBuilder]::new(1024)
  [uint64]$available = 0; [uint64]$total = 0; [uint64]$free = 0
  if (-not [Nuwax.InstallSpaceNative]::GetVolumePathName($existing, $mount, $mount.Capacity) -or
      -not [Nuwax.InstallSpaceNative]::GetVolumeNameForVolumeMountPoint($mount.ToString(), $identity, $identity.Capacity) -or
      -not [Nuwax.InstallSpaceNative]::GetDiskFreeSpaceEx($existing, [ref]$available, [ref]$total, [ref]$free)) {
    throw ('Cannot query volume space. Win32=' + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
  }
  if ($available -gt [long]::MaxValue) { throw 'Volume size exceeds the supported range.' }
  [pscustomobject]@{ Id = $identity.ToString(); Display = $mount.ToString(); Available = [long]$available }
}

function Invoke-InstallSpaceCheck {
  try {
    if ($UnpackedSizeKB -le 0 -or [decimal]$UnpackedSizeKB * 1024 -gt [long]::MaxValue) { throw 'Missing or invalid build-time payload size.' }
    $installer = Get-Item -LiteralPath $InstallerPath -Force
    if ($installer -isnot [IO.FileInfo] -or $installer.Length -le 0) { throw 'The installer is not a regular file.' }
    $unpacked = [long]([decimal]$UnpackedSizeKB * 1024)
    $requests = @(
      [pscustomobject]@{ Path = $InstallDir; Bytes = $unpacked; Role = '程序文件' },
      # The embedded archive is smaller than the complete EXE. Using the EXE
      # length is an intentional upper bound, independent of compression.
      [pscustomobject]@{ Path = $TempPath; Bytes = $installer.Length; Role = '临时安装文件' },
      [pscustomobject]@{ Path = $CachePath; Bytes = $installer.Length; Role = '更新缓存' }
    )
    if ($SevenZip) { $requests += [pscustomobject]@{ Path = $TempPath; Bytes = $unpacked; Role = '临时解压文件' } }
    $budget = @(Get-InstallSpaceBudget $requests { param($p) Get-InstallSpaceVolume $p })
    Assert-InstallWriteAccess $InstallDir '程序目录'
    Assert-InstallWriteAccess $TempPath '临时目录'
    Assert-InstallWriteAccess ([IO.Path]::GetDirectoryName($CachePath)) '更新缓存目录'
    $lines = @(Format-InstallSpaceBudget $budget)
    $code = 0
    if (@($budget | Where-Object { $_.Shortfall -gt 0 }).Count -gt 0) { $code = 112 }
    [IO.File]::WriteAllText($ReportPath, ($lines -join "`r`n"), [Text.Encoding]::Unicode)
    Write-Output ('SPACE_CHECK ' + $code)
    return $code
  } catch {
    $detail = $_.Exception.Message
    try { [IO.File]::WriteAllText($ReportPath, ('安装目录、写入权限或磁盘空间检查失败。请选择当前账户可写的目录，或使用原安装账户检查目录权限后重试。' + "`r`n" + $detail), [Text.Encoding]::Unicode) } catch { }
    Write-Output ('SPACE_QUERY_FAILED ' + $detail)
    return 2
  }
}

function Assert-InstallWriteAccess([string]$Path, [string]$Role) {
  $stream = $null
  try {
    if ($Path -notmatch '^[A-Za-z]:[\\/]') { throw 'A local absolute directory is required.' }
    $full = [IO.Path]::GetFullPath($Path)
    $ancestors = [Collections.Generic.List[string]]::new()
    for ($p=$full; $p; $p=[IO.Path]::GetDirectoryName($p)) { $ancestors.Add($p) }
    for ($i=$ancestors.Count-1; $i -ge 0; $i--) {
      try { $attributes=[IO.File]::GetAttributes($ancestors[$i]) }
      catch [IO.FileNotFoundException] { break }
      catch [IO.DirectoryNotFoundException] { break }
      if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('Redirected directory: ' + $ancestors[$i]) }
      if (-not ($attributes -band [IO.FileAttributes]::Directory)) { throw ('Expected a directory: ' + $ancestors[$i]) }
    }
    $parent=$full
    while (-not [IO.Directory]::Exists($parent)) {
      $parent=[IO.Path]::GetDirectoryName($parent)
      if (-not $parent) { throw 'No accessible parent directory.' }
    }
    [Nuwax.InstallSpaceNative]::RequireDirectoryWriteAccess($parent)
    # Exercise actual creation and writing under the installer token. The
    # random CreateNew file is removed by the OS even when a write fails.
    # Never create the chosen installation directory or touch existing files.
    $probe=Join-Path $parent ('nuwax-write-probe-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    $stream=[IO.FileStream]::new($probe,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::DeleteOnClose)
    $stream.WriteByte(0); $stream.Flush()
  } catch { throw ($Role + ': ' + $Path + "`r`n" + $_.Exception.Message) }
  finally { if ($stream) { $stream.Dispose() } }
}

if (-not $FunctionsOnly) {
  # Keep status output separate from the process exit code.
  $result = @(Invoke-InstallSpaceCheck)
  if ($result.Count -gt 1) { $result[0..($result.Count - 2)] | Write-Output }
  exit ([int]$result[-1])
}
