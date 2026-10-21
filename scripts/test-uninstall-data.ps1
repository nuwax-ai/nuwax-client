param([Parameter(Mandatory = $true)][string]$ScriptPath)
$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ('nuwax-uninstall-data-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
[IO.File]::WriteAllText((Join-Path $root 'owner.txt'), 'Generated uninstall-data test only')
$rows = @()
function Assert($Value, [string]$Message) { if (!$Value) { throw $Message } }
function Put([string]$Path, [string]$Text = 'fixture') {
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path)) | Out-Null
  [IO.File]::WriteAllText($Path, $Text)
}
function Fixture([string]$Name) {
  $base = Join-Path $root $Name
  $install = Join-Path $base 'installation with spaces'
  $profile = Join-Path $base 'profile'
  $roaming = Join-Path $base 'Roaming'
  $local = Join-Path $base 'Local'
  foreach ($file in @('NuwaxU1QA.exe', 'resources/app.asar', 'workspace/personal.txt', 'resources/user-added.txt')) { Put (Join-Path $install $file) }
  foreach ($path in @("$profile\.nuwax-u1-qa\workspace\user.txt", "$roaming\NuwaxU1QA\config.txt", "$local\nuwax-u1-qa-updater\cache.txt", "$base\outside\sentinel.txt")) { Put $path }
  $manifest = Join-Path $base 'embedded.json'
  @{schemaVersion=1;executable='NuwaxU1QA.exe';files=@('NuwaxU1QA.exe','resources/app.asar');directories=@('resources');dataDirectoryName='.nuwax-u1-qa';appDataName='NuwaxU1QA';updaterCacheName='nuwax-u1-qa-updater'}|ConvertTo-Json -Depth 4|Set-Content -Encoding UTF8 $manifest
  return @{base=$base;install=$install;profile=$profile;roaming=$roaming;local=$local;manifest=$manifest}
}
function Invoke-Uninstall($f, [bool]$Delete = $false, [string]$WorkingDirectory = '') {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
  $psi.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $ScriptPath + '" -InstallDir "' + $f.install + '" -ManifestPath "' + $f.manifest + '" -ProfileDir "' + $f.profile + '" -RoamingDir "' + $f.roaming + '" -LocalDir "' + $f.local + '"' + $(if ($Delete) { ' -DeleteLocalData' } else { '' })
  $psi.UseShellExecute=$false; $psi.CreateNoWindow=$true; $psi.RedirectStandardError=$true; $psi.RedirectStandardOutput=$true
  if ($WorkingDirectory) { $psi.WorkingDirectory = $WorkingDirectory }
  $p=[Diagnostics.Process]::Start($psi)
  if (!$p.WaitForExit(90000)) { $p.Kill(); throw 'Uninstall fixture exceeded 90 seconds.' }
  $stdout=$p.StandardOutput.ReadToEnd(); $stderr=$p.StandardError.ReadToEnd(); $p.WaitForExit()
  [IO.File]::WriteAllText((Join-Path $f.base 'result.log'), $stdout + $stderr)
  return $p.ExitCode
}
foreach ($delete in @($false,$true)) {
  $name=if($delete){'checked'}else{'default-keeps-data'};$f=Fixture $name
  Assert ((Invoke-Uninstall $f $delete) -eq 0) "$name failed"
  Assert (!(Test-Path "$($f.install)\NuwaxU1QA.exe")) 'Program executable retained'
  Assert (Test-Path "$($f.install)\workspace\personal.txt") 'Workspace lost'
  Assert (Test-Path "$($f.install)\resources\user-added.txt") 'Unknown nested resource lost'
  Assert ((Test-Path "$($f.profile)\.nuwax-u1-qa\workspace\user.txt") -eq !$delete) 'Unexpected local data result'
  Assert ((Test-Path "$($f.roaming)\NuwaxU1QA") -eq !$delete) 'Unexpected Electron data result'
  Assert ((Test-Path "$($f.local)\nuwax-u1-qa-updater") -eq !$delete) 'Unexpected updater cache result'
  Assert ([IO.File]::ReadAllText("$($f.base)\outside\sentinel.txt") -eq 'fixture') 'External data lost'
  $rows+=@{case=$name;passed=$true}
}
$f=Fixture 'nsis-system-dll-shadow'
Put (Join-Path $f.base 'System.dll') 'Native NSIS plugin, not a managed assembly'
Assert ((Invoke-Uninstall $f $false $f.base) -eq 0) 'NSIS System.dll shadowed framework compiler references'
Assert (Test-Path "$($f.install)\workspace\personal.txt") 'Plugin-directory uninstall removed workspace'
$rows+=@{case='nsis-system-dll-shadow';passed=$true}
$f=Fixture 'locked-preflight'
$lock=[IO.File]::Open("$($f.install)\resources\app.asar",[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
try { Assert ((Invoke-Uninstall $f $true) -ne 0) 'Locked payload accepted' } finally { $lock.Dispose() }
Assert (Test-Path "$($f.install)\NuwaxU1QA.exe") 'Preflight partly removed program'
Assert (Test-Path "$($f.profile)\.nuwax-u1-qa\workspace\user.txt") 'Failed uninstall deleted data'
Assert ((Invoke-Uninstall $f) -eq 0) 'Unlocked retry failed'
$rows+=@{case='locked-preflight-and-retry';passed=$true}
$f=Fixture 'escaping-inventory'
$m=[IO.File]::ReadAllText($f.manifest)|ConvertFrom-Json;$m.files=@('NuwaxU1QA.exe','../outside/sentinel.txt');$m|ConvertTo-Json|Set-Content -Encoding UTF8 $f.manifest
Assert ((Invoke-Uninstall $f) -ne 0) 'Path traversal accepted'
Assert (Test-Path "$($f.install)\NuwaxU1QA.exe") 'Invalid inventory partly removed program'
$rows+=@{case='escaping-inventory';passed=$true}
$f=Fixture 'linked-program-directory'
Rename-Item "$($f.install)\resources" 'original-resources'
New-Item -ItemType Junction -Path "$($f.install)\resources" -Target "$($f.base)\outside"|Out-Null
Assert ((Invoke-Uninstall $f) -ne 0) 'Redirected program directory accepted'
Assert ([IO.File]::ReadAllText("$($f.base)\outside\sentinel.txt") -eq 'fixture') 'Redirected destination touched'
$rows+=@{case='linked-program-directory';passed=$true}
$f=Fixture 'linked-data-root'
Rename-Item "$($f.profile)\.nuwax-u1-qa" '.saved-data'
New-Item -ItemType Junction -Path "$($f.profile)\.nuwax-u1-qa" -Target "$($f.base)\outside"|Out-Null
Assert ((Invoke-Uninstall $f $true) -ne 0) 'Redirected data root accepted'
Assert (Test-Path "$($f.install)\NuwaxU1QA.exe") 'Unsafe data path partly removed program'
$rows+=@{case='linked-data-root';passed=$true}
$f=Fixture 'nested-data-link'
New-Item -ItemType Junction -Path "$($f.profile)\.nuwax-u1-qa\linked-project" -Target "$($f.base)\outside"|Out-Null
Assert ((Invoke-Uninstall $f $true) -eq 0) 'Nested data-link removal failed'
Assert ([IO.File]::ReadAllText("$($f.base)\outside\sentinel.txt") -eq 'fixture') 'Nested link followed to external project'
$rows+=@{case='nested-data-link';passed=$true}
$f=Fixture 'overlapping-install-data'
$overlap="$($f.profile)\.nuwax-u1-qa\application"
Move-Item $f.install $overlap
$f.install=$overlap
Assert ((Invoke-Uninstall $f $true) -ne 0) 'Overlapping install/data directories accepted'
Assert (Test-Path "$overlap\NuwaxU1QA.exe") 'Overlap partly removed program'
Assert (Test-Path "$overlap\workspace\personal.txt") 'Overlap deleted unknown install data'
$rows+=@{case='overlapping-install-data';passed=$true}
$f=Fixture 'large-inventory'
$files=New-Object 'System.Collections.Generic.List[string]'
$files.Add('NuwaxU1QA.exe');$files.Add('resources/app.asar')
$directories=New-Object 'System.Collections.Generic.List[string]'
$directories.Add('resources')
for($group=0;$group -lt 60;$group++) {
  $directory='resources/dependencies/group-'+$group
  $directories.Add($directory)
  for($item=0;$item -lt 100;$item++) {
    $relative=$directory+'/file-'+$item+'.txt'
    Put (Join-Path $f.install $relative)
    $files.Add($relative)
  }
}
$directories.Add('resources/dependencies')
$m=[IO.File]::ReadAllText($f.manifest)|ConvertFrom-Json
$m.files=$files.ToArray();$m.directories=$directories.ToArray()
$m|ConvertTo-Json -Depth 4|Set-Content -Encoding UTF8 $f.manifest
$watch=[Diagnostics.Stopwatch]::StartNew()
Assert ((Invoke-Uninstall $f) -eq 0) 'Large inventory uninstall failed'
$watch.Stop()
Assert ($watch.Elapsed.TotalSeconds -lt 60) 'Large inventory uninstall took over 60 seconds'
Assert (!(Test-Path "$($f.install)\resources\dependencies")) 'Large payload retained'
Assert (Test-Path "$($f.install)\workspace\personal.txt") 'Large uninstall removed workspace'
Assert (Test-Path "$($f.install)\resources\user-added.txt") 'Large uninstall removed unknown resource'
Assert (Test-Path "$($f.profile)\.nuwax-u1-qa\workspace\user.txt") 'Large uninstall removed unchecked local data'
$rows+=@{case='large-inventory';passed=$true;files=$files.Count;elapsedSeconds=$watch.Elapsed.TotalSeconds}
@{passed=$true;fixtureRoot=$root;cases=$rows;realUserDataTouched=$false;fixtureRetained=$true}|ConvertTo-Json -Depth 4
