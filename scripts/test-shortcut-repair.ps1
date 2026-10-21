param(
  [string]$RepairScript = (Join-Path $PSScriptRoot '../overlay/crates/agent-electron-client/build/repair-shortcuts.ps1')
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows is required.' }
. $RepairScript
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('nuwax-shortcut-fixture-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($fixtureRoot) | Out-Null
function Assert($Value, [string]$Message) { if (!$Value) { throw $Message } }
function Hash([string]$Path) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($Path))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}
$wsh = New-Object -ComObject WScript.Shell
$shell = New-Object -ComObject Shell.Application
$appId = 'com.nuwax-ai.nuwax'
$roots = @(Get-NuwaxShortcutRoots 'CurrentUser') + @(Get-NuwaxShortcutRoots 'AllUsers')
$template = @(Get-NuwaxShortcutFiles $roots | Where-Object { [IO.Path]::GetFileName($_) -match 'Nuwax' -and (Get-NuwaxShortcutId $shell $_) -ceq $appId }) | Select-Object -First 1
if (!$template) { throw 'An existing Nuwax shortcut with its application identity is required as a read-only template.' }
$templateHash = Hash $template
$menu = Join-Path $fixtureRoot 'fake-start-menu'
$desktop = Join-Path $fixtureRoot 'fake-desktop'
$newApp = Join-Path $fixtureRoot 'new-install\Nuwax.exe'
$otherApp = Join-Path $fixtureRoot 'other-live-install\Nuwax.exe'
foreach ($directory in @($menu,$desktop,[IO.Path]::GetDirectoryName($newApp),[IO.Path]::GetDirectoryName($otherApp))) { [IO.Directory]::CreateDirectory($directory) | Out-Null }
[IO.File]::WriteAllText($newApp, 'Synthetic executable; never run')
[IO.File]::WriteAllText($otherApp, 'Synthetic other installation; never run')
function Make-Link([string]$Path,[string]$Target) {
  [IO.File]::Copy($template,$Path)
  $link=$wsh.CreateShortcut($Path);$link.TargetPath=$Target;$link.WorkingDirectory=[IO.Path]::GetDirectoryName($Target);$link.IconLocation=(Join-Path $fixtureRoot 'missing-old-icon.ico') + ',0';$link.Save()
  Assert ((Get-NuwaxShortcutId $shell $Path) -ceq $appId) 'Fixture copy lost the original application identity.'
}
$alias=Join-Path $menu 'personal-alias.lnk'
$other=Join-Path $menu 'other-installation.lnk'
Make-Link $alias (Join-Path $fixtureRoot 'removed-old-install\Nuwax.exe')
Make-Link $other $otherApp
$otherHash=Hash $other
$state=Join-Path $fixtureRoot 'captured.json'
$menuRoots=@([pscustomobject]@{Path=$menu;Recurse=$true})
$capture=Invoke-NuwaxShortcutRepair 'Capture' $state $newApp $appId $menuRoots
Assert ($capture.Captured -eq 2) 'The two synthetic aliases were not captured.'
$repair=Invoke-NuwaxShortcutRepair 'Repair' $state $newApp $appId $menuRoots
Assert ($repair.Changed -eq 1 -and $repair.Failed -eq 0) 'The stale shortcut was not repaired.'
$link=$wsh.CreateShortcut($alias)
Assert ($link.TargetPath -ieq $newApp -and $link.IconLocation -ieq ($newApp+',0')) 'Shortcut target or icon did not point to the new installation.'
Assert ($link.WorkingDirectory -ieq [IO.Path]::GetDirectoryName($newApp)) 'Shortcut working directory was not repaired.'
Assert ((Get-NuwaxShortcutId $shell $alias) -ceq $appId) 'Shortcut application identity changed.'
Assert ((Hash $other) -eq $otherHash) 'A different live installation was retargeted.'
$again=Invoke-NuwaxShortcutRepair 'Repair' $state $newApp $appId $menuRoots
Assert ($again.Changed -eq 0 -and $again.Failed -eq 0) 'Repeated repair was not idempotent.'
[IO.File]::Delete($alias)
$restored=Invoke-NuwaxShortcutRepair 'Repair' $state $newApp $appId $menuRoots
Assert ([IO.File]::Exists($alias) -and $restored.Changed -eq 1) 'A captured Start menu alias was not restored.'
$desktopLink=Join-Path $desktop 'optional-desktop.lnk'
Make-Link $desktopLink (Join-Path $fixtureRoot 'removed-old-install\Nuwax.exe')
$desktopState=Join-Path $fixtureRoot 'desktop.json'
$desktopRoots=@([pscustomobject]@{Path=$desktop;Recurse=$false})
$null=Invoke-NuwaxShortcutRepair 'Capture' $desktopState $newApp $appId $desktopRoots
[IO.File]::Delete($desktopLink)
$null=Invoke-NuwaxShortcutRepair 'Repair' $desktopState $newApp $appId $desktopRoots
Assert (![IO.File]::Exists($desktopLink)) 'An opted-out desktop shortcut was recreated.'
$removed=Invoke-NuwaxShortcutRepair 'Remove' $state $newApp $appId $menuRoots
Assert ($removed.Changed -eq 1 -and $removed.Failed -eq 0 -and ![IO.File]::Exists($alias)) 'Exact-target alias was not removed.'
Assert ((Hash $other) -eq $otherHash) 'Removing aliases changed another installation.'
Assert ((Hash $template) -eq $templateHash) 'The real shortcut template was changed.'
@{passed=$true;fixtureRoot=$fixtureRoot;realShortcutModified=$false;syntheticExecutablesRun=$false;cases=@('stale-target-and-icon','working-directory','application-identity','other-live-installation-preserved','idempotent','start-menu-alias-restored','desktop-opt-out-preserved','exact-target-remove','remove-preserves-other-installation')} | ConvertTo-Json -Depth 4
