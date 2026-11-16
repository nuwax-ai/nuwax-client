# Shared by the NSIS installer and the still-running application. Probe actual
# capabilities: a signed script may be allowed by policy where inline code is not.
$ErrorActionPreference = 'Stop'
try {
  if ($PSVersionTable.PSVersion -lt [version]'5.1') {
    throw 'Windows PowerShell 5.1 or later is required.'
  }
  # Use absolute framework references: NSIS extracts a native System.dll beside
  # this script, which must not be resolved as a managed framework dependency.
  Add-Type -ReferencedAssemblies @([Uri].Assembly.Location, [Collections.Generic.HashSet[string]].Assembly.Location) -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace Nuwax {
  public static class InstallerRuntimeProbe {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool GetDiskFreeSpaceEx(string path, out ulong available, out ulong total, out ulong free);
  }
}
'@
  $temp = [IO.Path]::GetTempPath()
  [uint64]$available = 0; [uint64]$total = 0; [uint64]$free = 0
  if (-not [Nuwax.InstallerRuntimeProbe]::GetDiskFreeSpaceEx($temp, [ref]$available, [ref]$total, [ref]$free)) {
    throw ('Cannot inspect temporary volume. Win32=' + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
  }
  $probe = Join-Path $temp ('Nuwax-installer-probe-' + [Guid]::NewGuid().ToString('N') + '.tmp')
  $stream = $null
  try {
    $stream = [IO.File]::Open($probe, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
      $stream.WriteByte(42)
      $stream.Position = 0
      if ($stream.ReadByte() -ne 42) { throw 'Temporary file verification failed.' }
    } finally { $stream.Dispose() }
  } finally {
    if ($stream) { [IO.File]::Delete($probe) }
  }
  Write-Output 'NUWAX_INSTALL_RUNTIME_OK'
  exit 0
} catch {
  Write-Error ('Windows installer runtime check failed: ' + $_.Exception.Message) -ErrorAction Continue
  exit 2
}
