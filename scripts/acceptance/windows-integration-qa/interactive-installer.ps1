param([ValidateSet('1','2')][string]$Number)
$ErrorActionPreference = 'Stop'
$r = 'C:\nuwax-qa\integration-20261018'
if ((Get-Content "$r\owner.json" -Raw | ConvertFrom-Json).kind -ne 'Owned integrated Windows QA') { throw 'Missing owner' }
$file = "$r\installers\NuwaxIntegrationQA-3.0.17-qa.integration.$Number.exe"
if (!(Test-Path -LiteralPath $file)) { throw 'Missing QA package' }
# Direct Task Scheduler launch crashed in NSIS System.dll in this ARM VM.
# Preserve the normal process context and working directory used in acceptance.
$child = Start-Process -FilePath $file -ArgumentList "/D=$r\NuwaxIntegrationQA" -WorkingDirectory "$r\installers" -PassThru -Wait
@{ exitCode = $child.ExitCode; number = $Number; method = 'Interactive PowerShell Start-Process'; artifact = $file } | ConvertTo-Json | Set-Content -Encoding UTF8 "$r\interactive-install-$Number-result.json"
exit $child.ExitCode
