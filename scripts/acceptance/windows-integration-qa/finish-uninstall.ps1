param([ValidateSet('default','checked')][string]$Mode)
$ErrorActionPreference = 'Stop'
$r = 'C:\nuwax-qa\integration-20261018'
if ((Get-Content "$r\owner.json" -Raw | ConvertFrom-Json).kind -ne 'Owned integrated Windows QA') { throw 'Missing owner' }
$registration = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\72f7d9de-f825-5e29-abc3-e41c33e12118'
$deadline = (Get-Date).AddMinutes(12)
while ((Test-Path $registration) -or (Test-Path "$r\NuwaxIntegrationQA\NuwaxIntegrationQA.exe")) {
  if ((Get-Date) -gt $deadline) { throw 'Timed out waiting for actual GUI uninstall' }
  Start-Sleep 2
}
$node = 'C:\Program Files\nodejs\node.exe'
& $node "$r\source\inspect.cjs" program-deleted $Mode
if ($LASTEXITCODE) { throw 'Owned program files remain' }
& $node "$r\source\inspect.cjs" unknown "after-uninstall-$Mode"
if ($LASTEXITCODE) { throw 'Unknown files were lost' }
if ($Mode -eq 'default') { & $node "$r\source\inspect.cjs" data-verify default }
else { & $node "$r\source\inspect.cjs" data-deleted }
if ($LASTEXITCODE) { throw 'Local data outcome differs from selected option' }
@{ passed = $true; mode = $Mode; observed = (Get-Date).ToUniversalTime().ToString('o'); registrationRemoved = $true; method = 'Actual NSIS GUI option; read-only verification afterwards'; knownProgramFilesRemoved = $true; unknownFilesRetained = $true; dataKept = ($Mode -eq 'default') } | ConvertTo-Json | Set-Content -Encoding UTF8 "$r\uninstall-$Mode-result.json"
[IO.File]::ReadAllText("$r\uninstall-$Mode-result.json")
