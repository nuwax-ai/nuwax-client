$ErrorActionPreference = 'Stop'
$r = 'C:\nuwax-qa\integration-20261018'
if ((Get-Content "$r\owner.json" -Raw | ConvertFrom-Json).kind -ne 'Owned integrated Windows QA') { throw 'Missing owner' }
$deadline = (Get-Date).AddMinutes(12)
$after = $null
while (!$after) {
  if ((Get-Date) -gt $deadline) { throw 'Timed out waiting for QA .2 restart' }
  if (Test-Path "$r\runtime-ready-3.0.17-qa.integration.2.json") {
    try { $after = Get-Content "$r\runtime-ready-3.0.17-qa.integration.2.json" -Raw | ConvertFrom-Json } catch { $after = $null }
  }
  if (!$after) { Start-Sleep 2 }
}
$before = Get-Content "$r\update-before.json" -Raw | ConvertFrom-Json
if ($after.version -ne '3.0.17-qa.integration.2' -or $after.pid -eq $before.before.pid) { throw 'Wrong restarted application' }
if (Get-Process -Id $before.before.pid -ErrorAction SilentlyContinue) { throw 'Old process still present' }
foreach ($marker in $before.markers) { if ((Get-FileHash -LiteralPath $marker.Path).Hash -ne $marker.Hash) { throw 'QA local data marker lost' } }
& 'C:\Program Files\nodejs\node.exe' "$r\source\inspect.cjs" verify after-upgrade
if ($LASTEXITCODE) { throw 'Payload differs after upgrade' }
& 'C:\Program Files\nodejs\node.exe' "$r\source\inspect.cjs" unknown after-upgrade
if ($LASTEXITCODE) { throw 'Unknown files not restored in place' }
@{ passed = $true; started = $before.started; observed = (Get-Date).ToUniversalTime().ToString('o'); before = $before.before; after = $after; localDataMarkersRetained = $true; oldProcessExited = $true; input = 'Actual About-page immediate-update button; no installer clicks during upgrade' } | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 "$r\update-result.json"
[IO.File]::ReadAllText("$r\update-result.json")
