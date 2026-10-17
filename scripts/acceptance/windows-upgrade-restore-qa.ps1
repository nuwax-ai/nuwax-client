# Full NSIS upgrade acceptance, confined to this task's generated QA identity.
param([switch]$ResumeSeed)
$ErrorActionPreference = 'Stop'
$r = 'C:\nuwax-qa\upgrade-restore-20261018'
$install = "$r\installed"
$identity = 'NuwaxRestoreQA'
if (([IO.File]::ReadAllText("$r\owner.json") | ConvertFrom-Json).kind -ne 'Owned upgrade nested-restore QA') { throw 'Wrong QA owner' }
if ((Test-Path $install) -and -not $ResumeSeed) { throw 'Refuse existing QA installation' }
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Registration { @(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' | Where-Object { $_.DisplayName -like 'NuwaxRestoreQA*' }) }
if (-not $ResumeSeed) { Assert (@(Registration).Count -eq 0) 'Refuse existing QA registration' }
$hash = [Security.Cryptography.SHA256]::Create()
function FileHash([string]$Path) {
  $stream = [IO.File]::OpenRead(('\\?\' + $Path))
  try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose() }
}
function Write-QA([string]$Relative, [string]$Content) {
  # GetFullPath treats a DOS device basename as \\.\nul. Validate these
  # generated relative names lexically, then use the extended local path.
  Assert ($Relative -and -not [IO.Path]::IsPathRooted($Relative) -and $Relative -notmatch '[/:\x00-\x1f]' -and @($Relative.Split([char]92) | Where-Object { $_ -in @('', '.', '..') }).Count -eq 0) 'QA path escaped installation'
  $path = "$install\$Relative"
  if ($Relative -ne 'resources\icon.png' -and [IO.File]::Exists(('\\?\' + $path))) {
    Assert ([IO.File]::ReadAllText(('\\?\' + $path)) -eq $Content) 'Refuse unrelated pre-existing QA sentinel'
  }
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName(('\\?\' + $path))) | Out-Null
  [IO.File]::WriteAllText(('\\?\' + $path), $Content)
}
function Install-QA([string]$Version, [bool]$Updated) {
  $exe = "$r\installers\$identity-$Version.exe"
  $installArgs = @('/S', '/currentuser')
  if ($Updated) { $installArgs += '--updated' }
  $installArgs += "/D=$install"
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = Start-Process $exe -ArgumentList $installArgs -Wait -PassThru
  Assert ($p.ExitCode -eq 0) "NSIS QA install failed: $($p.ExitCode)"
  return [ordered]@{ version = $Version; exitCode = $p.ExitCode; seconds = $sw.Elapsed.TotalSeconds; sha256 = FileHash $exe; bytes = (Get-Item -LiteralPath $exe).Length }
}

try {
  $originalBeta5 = 'C:\nuwax-qa\beta5-20261017\installed\resources\app.asar'
  $originalBeta5Hash = FileHash $originalBeta5
  if ($ResumeSeed) {
    Assert (!(Test-Path "$r\seeded.json")) 'Seed continuation is only allowed before completed seeding'
    Assert (@(Registration).Count -eq 1 -and (Registration)[0].DisplayVersion -eq '3.0.17-qa.restore.1') 'Continuation requires own initial QA version'
    Assert ((Registration)[0].UninstallString.Contains($install)) 'QA registration points elsewhere'
    Assert (@(Get-ChildItem $r -Directory -Filter 'Nuwax-installer-recovery-*').Count -eq 0) 'Upgrade already started; refuse seed continuation'
    $firstExe = "$r\installers\$identity-3.0.17-qa.restore.1.exe"
    $first = [ordered]@{ version = '3.0.17-qa.restore.1'; sha256 = FileHash $firstExe; bytes = (Get-Item -LiteralPath $firstExe).Length; resumedBeforeUpgrade = $true; note = 'Initial NSIS install completed before fixture device-name path validation stopped seeding; first-install timing not retained' }
  } else {
    $first = Install-QA '3.0.17-qa.restore.1' $false
  }
  Assert (@(Registration).Count -eq 1) 'Missing initial QA registration'
  Assert ((Registration)[0].DisplayVersion -eq '3.0.17-qa.restore.1') 'Wrong initial QA version'
  $unicodeName = -join ([char[]]@(0x7528, 0x6237))
  $relativeFiles = @(
    'personal-workspace\keep.txt',
    'resources\user-added.txt',
    'resources\app.asar.unpacked\node_modules\qa-user-added.txt',
    'resources\qa-private\workspace\notes.txt',
    'resources\qa-private\nul',
    'resources\qa-private\trailing.',
    "resources\$unicodeName\keep.txt",
    'locales\user-note.txt'
  )
  $sentinels = @()
  foreach ($relative in $relativeFiles) {
    Write-QA $relative ('Generated QA user bytes: ' + $relative)
    $sentinels += [ordered]@{ path = $relative; sha256 = FileHash "$install\$relative" }
  }
  Write-QA 'resources\icon.png' 'Old modified QA payload; new payload must win and this copy must remain in recovery'
  $oldConflictHash = FileHash "$install\resources\icon.png"
  $data = @("$env:USERPROFILE\.nuwax-restore-qa", "$env:APPDATA\NuwaxRestoreQA", "$env:LOCALAPPDATA\nuwax-restore-qa-updater")
  foreach ($target in $data) {
    if (Test-Path -LiteralPath $target) {
      Assert (([IO.File]::GetAttributes($target) -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'Refuse redirected QA data namespace'
      # NSIS caches its installer during first installation. A seed retry may
      # also encounter our own sentinel. Validate both before reusing them.
      foreach ($entry in Get-ChildItem -LiteralPath $target -Force) {
        Assert (!$entry.PSIsContainer -and ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'Refuse unrelated QA data entry'
        if ($entry.Name -eq 'qa.txt') {
          Assert ([IO.File]::ReadAllText($entry.FullName) -eq 'Generated QA local data only') 'Refuse unrelated QA data sentinel'
        } else {
          Assert ($target -eq $data[2] -and $entry.Name -eq 'installer.exe') 'Refuse unrelated QA data file'
          Assert ((FileHash $entry.FullName) -eq $first.sha256) 'QA installer cache does not match initial installer'
        }
      }
    }
    [IO.Directory]::CreateDirectory($target) | Out-Null
    [IO.File]::WriteAllText("$target\qa.txt", 'Generated QA local data only')
  }
  [IO.File]::WriteAllText("$r\outside.txt", 'Outside QA install is retained')
  $outsideHash = FileHash "$r\outside.txt"
  [ordered]@{ firstInstall = $first; sentinels = $sentinels; oldConflictHash = $oldConflictHash; data = $data; outsideHash = $outsideHash } | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 "$r\seeded.json"

  $upgrade = Install-QA '3.0.17-qa.restore.2' $true
  foreach ($sentinel in $sentinels) {
    Assert ((FileHash "$install\$($sentinel.path)") -eq $sentinel.sha256) "Unknown file not restored in place: $($sentinel.path)"
  }
  foreach ($target in $data) { Assert ([IO.File]::ReadAllText("$target\qa.txt") -eq 'Generated QA local data only') 'QA local data changed' }
  Assert ((FileHash "$r\outside.txt") -eq $outsideHash) 'Outside file changed'
  Assert ((FileHash $originalBeta5) -eq $originalBeta5Hash) 'Original beta.5 was changed'
  Assert ((Registration)[0].DisplayVersion -eq '3.0.17-qa.restore.2') 'Wrong upgraded QA version'
  Assert (@(Get-Process -Name NuwaxRestoreQA -ErrorAction SilentlyContinue).Count -eq 0) 'QA client unexpectedly started'

  $inventory = [IO.File]::ReadAllText('C:\nuwax-qa\u1-20261018-offload\payload-files.json') | ConvertFrom-Json
  $verified = 0
  foreach ($entry in $inventory.PSObject.Properties) {
    $relative = $entry.Name
    if ($relative -eq 'NuwaxU1QA.exe') { $relative = 'NuwaxRestoreQA.exe' }
    $file = "$install\$relative"
    Assert (([IO.FileInfo]::new(('\\?\' + $file))).Length -eq $entry.Value.bytes) "Payload size changed: $relative"
    Assert ((FileHash $file) -eq $entry.Value.sha256.ToLowerInvariant()) "New payload overwritten: $relative"
    $verified++
  }
  $recoveries = @(Get-ChildItem $r -Directory -Filter 'Nuwax-installer-recovery-*')
  Assert ($recoveries.Count -eq 1) 'Unexpected QA recovery count'
  $records = @([IO.File]::ReadAllLines("$($recoveries[0].FullName)\manifest.jsonl") | ForEach-Object { $_ | ConvertFrom-Json })
  $resourcePlan = @($records | Where-Object { $_.status -eq 'planned' -and $_.original -eq "$install\resources" })[0]
  Assert ((FileHash "$($resourcePlan.backup)\icon.png") -eq $oldConflictHash) 'Old collision backup was lost'
  Assert ($records[-1].status -eq 'restore-complete' -and $records[-1].payloadExtrasRestored -gt 0) 'Missing completed nested restore record'
  Assert (@(Get-ChildItem $r -File -Filter 'Nuwax-installer-recovery-active-*.txt').Count -eq 0) 'Recovery marker was not cleared'
  $result = [ordered]@{
    passed = $true; host = $env:COMPUTERNAME; firstInstall = $first; upgrade = $upgrade
    unknownFilesRestoredInPlace = $sentinels; allCleanPayloadFileHashesVerified = $verified
    localDataPreserved = $true; outsideFilePreserved = $true; oldCollisionBackupPreserved = $true
    finalRecoveryRecord = $records[-1]; originalBeta5Unchanged = $true; clientStarted = $false
    scope = 'Real x64 NSIS installers in UTM Windows ARM64; installer hooks changed, runtime payload reused from beta.5'
  }
  $result | ConvertTo-Json -Depth 7 | Set-Content -Encoding UTF8 "$r\package-results.json"
  $result | ConvertTo-Json -Depth 7
} finally { $hash.Dispose() }
