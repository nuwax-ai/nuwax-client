param(
  [ValidateSet('Capture', 'Repair')][string]$Action,
  [ValidateSet('CurrentUser', 'AllUsers')][string]$Scope,
  [string]$StatePath,
  [string]$AppExe,
  [string]$AppId = 'com.nuwax-ai.nuwax'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-NuwaxShortcutRoots([string]$Scope) {
  if ($Scope -eq 'AllUsers') {
    @([pscustomobject]@{ Path = [Environment]::GetFolderPath('CommonPrograms'); Recurse = $true },
      [pscustomobject]@{ Path = [Environment]::GetFolderPath('CommonDesktopDirectory'); Recurse = $false })
  } else {
    @([pscustomobject]@{ Path = [Environment]::GetFolderPath('Programs'); Recurse = $true },
      [pscustomobject]@{ Path = [Environment]::GetFolderPath('DesktopDirectory'); Recurse = $false },
      [pscustomobject]@{ Path = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'; Recurse = $false })
  }
}

function Test-NuwaxShortcutPath([string]$Path, [object[]]$Roots) {
  $full = [IO.Path]::GetFullPath($Path)
  if ([IO.Path]::GetExtension($full) -ine '.lnk') { return $false }
  foreach ($root in $Roots) {
    if (-not $root.Path) { continue }
    $base = [IO.Path]::GetFullPath($root.Path).TrimEnd('\')
    if (-not $full.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) { continue }
    if (-not $root.Recurse -and [IO.Path]::GetDirectoryName($full) -ine $base) { continue }
    $part = $full
    while ($part.Length -ge $base.Length) {
      if (([IO.File]::Exists($part) -or [IO.Directory]::Exists($part)) -and
          ([IO.File]::GetAttributes($part) -band [IO.FileAttributes]::ReparsePoint)) { return $false }
      $part = [IO.Path]::GetDirectoryName($part)
      if (-not $part) { break }
    }
    return $true
  }
  return $false
}

function Get-NuwaxShortcutFiles([object[]]$Roots) {
  foreach ($root in $Roots) {
    if (-not $root.Path -or -not [IO.Directory]::Exists($root.Path)) { continue }
    $pending = New-Object 'Collections.Generic.Stack[string]'
    $pending.Push($root.Path)
    while ($pending.Count) {
      $directory = $pending.Pop()
      if ([IO.File]::GetAttributes($directory) -band [IO.FileAttributes]::ReparsePoint) { continue }
      foreach ($file in Get-ChildItem -LiteralPath $directory -Force) {
        if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
        if ($file.PSIsContainer) {
          if ($root.Recurse) { $pending.Push($file.FullName) }
        } elseif ($file.Extension -ieq '.lnk') { $file.FullName }
      }
    }
  }
}

function Get-NuwaxShortcutId($Shell, [string]$Path) {
  $folder = $Shell.Namespace([IO.Path]::GetDirectoryName($Path))
  if ($null -eq $folder) { return '' }
  $item = $folder.ParseName([IO.Path]::GetFileName($Path))
  if ($null -eq $item) { return '' }
  return [string]$item.ExtendedProperty('System.AppUserModel.ID')
}

function Invoke-NuwaxShortcutRepair {
  param([string]$Action, [string]$StatePath, [string]$AppExe, [string]$AppId, [object[]]$Roots)
  $AppExe = [IO.Path]::GetFullPath($AppExe)
  if ([IO.Path]::GetFileName($AppExe) -ine 'Nuwax.exe') { throw 'Unexpected Nuwax executable name.' }
  if ($Action -eq 'Repair' -and -not [IO.File]::Exists($AppExe)) { throw 'Installed Nuwax executable is missing.' }
  $wsh = New-Object -ComObject WScript.Shell
  $shell = New-Object -ComObject Shell.Application
  $saved = @{}
  if ([IO.File]::Exists($StatePath)) {
    $entries = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($StatePath))
    foreach ($entry in $entries) {
      if ($null -ne $entry -and (Test-NuwaxShortcutPath $entry.Path $Roots)) { $saved[$entry.Path] = $entry }
    }
  }
  $paths = @(@(Get-NuwaxShortcutFiles $Roots) + @($saved.Keys) | Sort-Object -Unique)
  $changed = 0
  $failed = 0
  foreach ($path in $paths) {
    $temporary = $null
    try {
      if (-not (Test-NuwaxShortcutPath $path $Roots)) { continue }
      $exists = [IO.File]::Exists($path)
      if ($exists) {
        if ((Get-NuwaxShortcutId $shell $path) -cne $AppId) { continue }
        $bytes = [IO.File]::ReadAllBytes($path)
      } elseif ($Action -eq 'Repair' -and $saved.ContainsKey($path)) {
        # Only restore removed Start menu aliases. Desktop opt-outs and deleted
        # taskbar pins must not be undone by the pre-uninstall snapshot.
        $restore = @($Roots | Where-Object { $_.Recurse -and (Test-NuwaxShortcutPath $path @($_)) }).Count -gt 0
        if (-not $restore) { continue }
        $bytes = [Convert]::FromBase64String($saved[$path].Bytes)
      } else { continue }
      if ($bytes.Length -gt 262144) { throw 'Shortcut is unexpectedly large.' }
      if ($Action -eq 'Capture') {
        # Keep the first copy across NSIS retries; old uninstallers may remove it.
        if (-not $saved.ContainsKey($path)) {
          $link = $wsh.CreateShortcut($path)
          if ([IO.Path]::GetFileName($link.TargetPath) -ine 'Nuwax.exe') { continue }
          $saved[$path] = @{ Path = $path; Bytes = [Convert]::ToBase64String($bytes) }
        }
        continue
      }
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path)) | Out-Null
      $temporary = Join-Path ([IO.Path]::GetDirectoryName($path)) ('.nuwax-shortcut-' + [Guid]::NewGuid().ToString('N') + '.lnk')
      [IO.File]::WriteAllBytes($temporary, $bytes)
      if ((Get-NuwaxShortcutId $shell $temporary) -cne $AppId) { throw 'Shortcut identity changed.' }
      $link = $wsh.CreateShortcut($temporary)
      $target = [string]$link.TargetPath
      # Do not retarget a different live installation or access network targets.
      if ($target -notmatch '^[A-Za-z]:\\' -or [IO.Path]::GetFileName($target) -ine 'Nuwax.exe') { continue }
      if ($target -ine $AppExe -and [IO.File]::Exists($target)) { continue }
      $icon = $AppExe + ',0'
      $working = [IO.Path]::GetDirectoryName($AppExe)
      if ($exists -and $target -ieq $AppExe -and $link.IconLocation -ieq $icon -and $link.WorkingDirectory -ieq $working) { continue }
      $link.TargetPath = $AppExe
      $link.IconLocation = $icon
      $link.WorkingDirectory = $working
      $link.Save()
      if ((Get-NuwaxShortcutId $shell $temporary) -cne $AppId) { throw 'Shortcut save lost its application identity.' }
      if ($exists) { [IO.File]::Replace($temporary, $path, [NullString]::Value) }
      else { [IO.File]::Move($temporary, $path) }
      $temporary = $null
      $changed++
      if (-not ('Nuwax.ShortcutNotify' -as [type])) {
        Add-Type -TypeDefinition 'namespace Nuwax { public static class ShortcutNotify { [System.Runtime.InteropServices.DllImport("shell32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)] public static extern void SHChangeNotify(int e, uint f, string p, System.IntPtr q); } }'
      }
      [Nuwax.ShortcutNotify]::SHChangeNotify(0x2000, 0x1005, $path, [IntPtr]::Zero)
    } catch {
      $failed++
      Write-Warning ('Shortcut repair failed for "' + $path + '": ' + $_.Exception.Message)
    } finally {
      if ($temporary -and [IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
  }
  if ($Action -eq 'Capture') {
    [IO.File]::WriteAllText($StatePath, (ConvertTo-Json -InputObject @($saved.Values) -Depth 4), (New-Object Text.UTF8Encoding($false)))
  } elseif ($changed) {
    [Nuwax.ShortcutNotify]::SHChangeNotify(0x8000000, 0x1000, $null, [IntPtr]::Zero)
  }
  return [pscustomobject]@{ Action = $Action; Changed = $changed; Failed = $failed; Captured = $saved.Count }
}

if ($MyInvocation.InvocationName -ne '.') {
  try {
    if (-not $Action -or -not $Scope -or -not $StatePath -or -not $AppId) { throw 'Missing shortcut repair arguments.' }
    $result = Invoke-NuwaxShortcutRepair $Action $StatePath $AppExe $AppId @(Get-NuwaxShortcutRoots $Scope)
    $result | ConvertTo-Json -Compress
    if ($result.Failed) { exit 1 }
  } catch {
    Write-Error $_
    exit 1
  }
}
