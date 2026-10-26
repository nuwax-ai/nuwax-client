param([Parameter(Mandatory=$true)][string]$FixtureDir)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = [IO.Path]::GetFullPath($FixtureDir)
if (-not $root.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture must be in this account TEMP.' }
$meta = Get-Content -LiteralPath (Join-Path $root 'space-fixture.json') -Raw | ConvertFrom-Json
if ($meta.kind -ne 'Synthetic Nuwax disk space QA' -or $meta.identity -notmatch '^NuwaxSpaceQA-[0-9a-f-]{36}$') { throw 'Unexpected fixture identity.' }
function Check($Value, [string]$Message) { if (-not $Value) { throw $Message } }
function File-For([string]$Kind) {
  $entry = $meta.files.$Kind
  Check ($entry.name -eq ($meta.identity + '-' + $Kind + '.exe')) 'Unexpected fixture filename.'
  $file = Join-Path $root $entry.name
  Check ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -eq $entry.sha256) 'Fixture checksum mismatch.'
  return $file
}
foreach ($kind in @('good', 'low', 'invalid')) {
  $p = Start-Process (File-For $kind) -ArgumentList '/S' -PassThru
  $null = $p.Handle
  Check ($p.WaitForExit(60000)) 'Silent space fixture timed out.'
  $code = $p.ExitCode; $p.Dispose()
  Check (($kind -eq 'good' -and $code -eq 0) -or ($kind -ne 'good' -and $code -ne 0)) ('Unexpected silent exit for ' + $kind + ': ' + $code)
  foreach ($action in @('shutdown', 'prepare', 'uninstall')) {
    Check (([IO.File]::Exists((Join-Path $root ($kind + '-' + $action + '.marker')))) -eq ($kind -eq 'good')) ('Unsafe action after failed preflight: ' + $kind + '/' + $action)
  }
  Write-Output ('PASS silent-' + $kind + '-action-boundary exit=' + $code)
}
Add-Type -ReferencedAssemblies @([Uri].Assembly.Location, [Collections.Generic.List[string]].Assembly.Location) -TypeDefinition @'
using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public static class SpaceQAUI {
 public delegate bool Walk(IntPtr h,IntPtr l);
 [DllImport("user32.dll")]static extern bool EnumWindows(Walk cb,IntPtr l);
 [DllImport("user32.dll")]static extern bool EnumChildWindows(IntPtr h,Walk cb,IntPtr l);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr h,StringBuilder b,int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr h,StringBuilder b,int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr SendMessageTimeout(IntPtr h,uint m,UIntPtr w,StringBuilder b,uint flags,uint timeout,out UIntPtr result);
 [DllImport("user32.dll")]static extern int GetDlgCtrlID(IntPtr h);
 [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")]static extern bool IsWindowEnabled(IntPtr h);
 [DllImport("user32.dll")]static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 public class Item {public long Handle; public int Id; public string Text; public bool Enabled;}
 public static Item[] Read(int target) {
  var items=new List<Item>();Walk capture=(h,l)=>{uint p;GetWindowThreadProcessId(h,out p);if(p==(uint)target&&IsWindowVisible(h)){var b=new StringBuilder(4096);GetWindowText(h,b,b.Capacity);var cls=new StringBuilder(128);GetClassName(h,cls,cls.Capacity);if(cls.ToString()=="Edit"){UIntPtr result;SendMessageTimeout(h,0xd,(UIntPtr)b.Capacity,b,2,1000,out result);}items.Add(new Item{Handle=h.ToInt64(),Id=GetDlgCtrlID(h),Text=b.ToString(),Enabled=IsWindowEnabled(h)});}return true;};
  EnumWindows((h,l)=>{uint p;GetWindowThreadProcessId(h,out p);if(p==(uint)target){capture(h,l);EnumChildWindows(h,capture,IntPtr.Zero);}return true;},IntPtr.Zero);return items.ToArray();
 }
 public static bool Click(long handle,int target){var h=new IntPtr(handle);uint p;GetWindowThreadProcessId(h,out p);return p==(uint)target&&IsWindowVisible(h)&&IsWindowEnabled(h)&&PostMessage(h,0xf5,IntPtr.Zero,IntPtr.Zero);}
}
'@
$p = Start-Process (File-For 'low') -PassThru
try {
  $lowPage = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 200
    Check (-not $p.HasExited) 'Own interactive fixture exited before the space page.'
    $items = @([SpaceQAUI]::Read($p.Id))
    if (@($items | Where-Object { $_.Text -eq '重新检查' }).Count -gt 0) { $lowPage = $true; break }
    $next = @($items | Where-Object { $_.Id -eq 1 -and $_.Enabled })
    if ($next.Count -gt 0) { [SpaceQAUI]::Click($next[0].Handle, $p.Id) | Out-Null }
  }
  if (-not $lowPage) { Write-Output ('SPACE_UI_LAST ' + ($items | ConvertTo-Json -Compress)) }
  Check $lowPage 'Space error page was not shown.'
  Check (@($items | Where-Object { $_.Text.Contains('GiB') }).Count -gt 0) 'Per-volume budget was not visible.'
  $next = @($items | Where-Object Id -eq 1)
  Check ($next.Count -gt 0 -and -not $next[0].Enabled) 'Insufficient space must disable installation.'
  $retry = @($items | Where-Object { $_.Text -eq '重新检查' })[0]
  Check ([SpaceQAUI]::Click($retry.Handle, $p.Id)) 'Cannot click owned retry button.'
  Start-Sleep -Seconds 2
  $items = @([SpaceQAUI]::Read($p.Id)); $next = @($items | Where-Object Id -eq 1)
  Check (-not $next[0].Enabled) 'Retry must not bypass a remaining deficit.'
  $back = @($items | Where-Object { $_.Id -eq 3 -and $_.Enabled })
  Check ($back.Count -gt 0 -and [SpaceQAUI]::Click($back[0].Handle, $p.Id)) 'Cannot return to installation directory.'
  Start-Sleep -Milliseconds 500
  $items = @([SpaceQAUI]::Read($p.Id))
  Check (@($items | Where-Object { $_.Text.EndsWith('target-low') }).Count -gt 0) 'Back did not return to the directory page.'
  $next = @($items | Where-Object { $_.Id -eq 1 -and $_.Enabled })
  Check ($next.Count -gt 0 -and [SpaceQAUI]::Click($next[0].Handle, $p.Id)) 'Cannot confirm directory after going back.'
  $returned = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 200
    $items = @([SpaceQAUI]::Read($p.Id))
    if (@($items | Where-Object { $_.Text -eq '重新检查' }).Count -gt 0) { $returned = $true; break }
  }
  Check $returned 'Directory confirmation did not recheck space.'
  $next = @($items | Where-Object Id -eq 1)
  Check (-not $next[0].Enabled) 'Returning from the directory must not bypass space checks.'
  Check (-not [IO.File]::Exists((Join-Path $root 'low-prepare.marker'))) 'Interactive failure ran preservation.'
  Write-Output 'PASS interactive-budget-retry-and-back'
} finally { if (-not $p.HasExited) { $p.Kill(); $p.WaitForExit() }; $p.Dispose() }
Write-Output 'SPACE_UI_FIXTURES_OK 4'
