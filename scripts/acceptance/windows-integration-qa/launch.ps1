param([ValidateSet('Install1','Install2','App','Uninstall')][string]$Action)
$ErrorActionPreference = 'Stop'
$r = 'C:\nuwax-qa\integration-20261018'
if ((Get-Content "$r\owner.json" -Raw | ConvertFrom-Json).kind -ne 'Owned integrated Windows QA') { throw 'Missing owner' }
$exe = "$r\NuwaxIntegrationQA\NuwaxIntegrationQA.exe"
$arguments = ''
if ($Action -like 'Install*') {
  $number = $Action.Substring(7)
  $exe = "$r\installers\NuwaxIntegrationQA-3.0.17-qa.integration.$number.exe"
  $arguments = "/D=$r\NuwaxIntegrationQA"
} elseif ($Action -eq 'Uninstall') { $exe = "$r\NuwaxIntegrationQA\Uninstall NuwaxIntegrationQA.exe" }
if (!(Test-Path -LiteralPath $exe)) { throw 'Missing QA executable' }
$name = "NuwaxIntegrationQA-$Action-20261018"
$description = 'Owned integrated Windows QA 20261018'
$old = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($old -and ($old.Description -ne $description -or $old.State -eq 'Running')) { throw 'Refuse replacing task' }
if ($arguments) { $a = New-ScheduledTaskAction -Execute $exe -Argument $arguments } else { $a = New-ScheduledTaskAction -Execute $exe }
$principal = New-ScheduledTaskPrincipal -UserId 'WIN-UTM\Louis' -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $a -Principal $principal -Description $description -Force | Out-Null
Start-ScheduledTask -TaskName $name
"Launched $Action in logged-in QA desktop"
