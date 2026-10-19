$ErrorActionPreference = 'Stop'
$r = 'C:\nuwax-qa\integration-20261018'
if ((Get-Content "$r\owner.json" -Raw | ConvertFrom-Json).kind -ne 'Owned integrated Windows QA') { throw 'Missing owner' }
$installed = "$r\NuwaxIntegrationQA"
if (Get-Process NuwaxIntegrationQA -ErrorAction SilentlyContinue) { throw 'Quit QA app before boundary checks' }
$uninstaller = "$installed\Uninstall NuwaxIntegrationQA.exe"
$runner = "$r\boundary-uninstaller.exe"
Copy-Item -LiteralPath $uninstaller -Destination $runner -Force
function Invoke-Uninstaller([string]$extra) {
  (Start-Process -FilePath $runner -ArgumentList "/S $extra _?=$installed" -Wait -PassThru).ExitCode
}
function Assert-Retained {
  if (!(Test-Path -LiteralPath $uninstaller) -or !(Test-Path "$installed\NuwaxIntegrationQA.exe")) { throw 'Program/entry lost' }
  $registration = Get-ChildItem HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall | Get-ItemProperty | Where-Object DisplayName -like 'NuwaxIntegrationQA *'
  if (!$registration) { throw 'Missing QA uninstall registration' }
  foreach ($target in (Get-Content "$r\isolation.json" -Raw | ConvertFrom-Json).realQaDataTargets) { if (!(Test-Path -LiteralPath $target)) { throw 'QA local data lost' } }
}
$flagCode = Invoke-Uninstaller '--delete-app-data'
if ($flagCode -ne 2) { throw "Delete-data bypass returned $flagCode" }
Assert-Retained
$lock = [IO.File]::Open("$installed\resources\app.asar", 'Open', 'Read', 'None')
try {
  $lockCode = Invoke-Uninstaller ''
  if ($lockCode -ne 2) { throw "Locked uninstall returned $lockCode" }
  Assert-Retained
} finally { $lock.Dispose() }
@{ passed = $true; unsafeFlagExit = $flagCode; lockedExit = $lockCode; programAndRegistrationRetained = $true; retry = 'GUI default uninstall after releasing lock' } | ConvertTo-Json | Set-Content -Encoding UTF8 "$r\boundary-result.json"
Get-Content "$r\boundary-result.json" -Raw
