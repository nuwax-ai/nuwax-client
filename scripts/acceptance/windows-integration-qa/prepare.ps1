$ErrorActionPreference = 'Stop'
$r = 'C:\nuwax-qa\integration-20261018'
if (Test-Path $r) { throw 'Refuse existing integration root' }
New-Item -ItemType Directory "$r\source" | Out-Null
@{ kind = 'Owned integrated Windows QA'; baseline = '7503d15c'; appId = 'com.nuwax-ai.nuwax.integrationqa.20261018' } | ConvertTo-Json | Set-Content -Encoding UTF8 "$r\owner.json"
$qaProfile = "$r\profile"
$targets = @("$env:USERPROFILE\.nuwax-integration-qa", "$env:APPDATA\NuwaxIntegrationQA", "$env:LOCALAPPDATA\nuwax-integration-qa-updater")
$links = @("$qaProfile\.nuwax", "$qaProfile\AppData\Roaming\Nuwax", "$qaProfile\AppData\Local\nuwax-integration-qa-updater")
foreach ($target in $targets) { if (Test-Path $target) { throw 'Refuse existing QA data namespace' } }
for ($i = 0; $i -lt $targets.Count; $i++) {
  New-Item -ItemType Directory $targets[$i] | Out-Null
  New-Item -ItemType Directory ([IO.Path]::GetDirectoryName($links[$i])) -Force | Out-Null
  New-Item -ItemType Junction -Path $links[$i] -Target $targets[$i] | Out-Null
}
@{ profile = $qaProfile; realQaDataTargets = $targets; runtimeLinks = $links; processOnlyEnvironment = $true; systemPermissionsChanged = $false } | ConvertTo-Json | Set-Content -Encoding UTF8 "$r\isolation.json"
