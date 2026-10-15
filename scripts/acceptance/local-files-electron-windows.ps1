# Runs the local-files real Electron smoke on a Windows host that has no nuwax-client checkout.
# On the dev machine: node scripts/acceptance/local-files-electron.mjs --bundle-only <dir>
# Copy <dir> and this script to the Windows host, then:
#   powershell -NoProfile -ExecutionPolicy Bypass -File local-files-electron-windows.ps1 -BundleDir <dir>
# Electron comes from -ElectronExe, or the electron-builder cache zip for -ElectronVersion.
param(
  [Parameter(Mandatory = $true)][string]$BundleDir,
  [string]$ElectronVersion = '40.8.2',
  [string]$ElectronExe = '',
  [string]$WorkDir = (Join-Path $env:USERPROFILE 'nuwax-lf-qa')
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$BundleDir = (Resolve-Path $BundleDir).ProviderPath

if (-not $ElectronExe) {
  $electronDir = Join-Path $WorkDir "electron-$ElectronVersion"
  $ElectronExe = Join-Path $electronDir 'electron.exe'
  if (-not (Test-Path $ElectronExe)) {
    $zip = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'electron\Cache') -Recurse `
      -Filter "electron-v$ElectronVersion-win32-x64.zip" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $zip) { throw "electron-v$ElectronVersion-win32-x64.zip not in cache; pass -ElectronExe" }
    Expand-Archive -Path $zip.FullName -DestinationPath $electronDir -Force
  }
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
# %TEMP% may carry 8.3 short segments, which break the feature's real-path containment checks.
$fixture = Join-Path $WorkDir "fixture-$stamp"
New-Item -ItemType Directory -Path $fixture | Out-Null
Copy-Item (Join-Path $BundleDir 'preload.cjs'), (Join-Path $BundleDir 'playback.mp4') $fixture
$report = Join-Path $WorkDir "local-files-electron-$stamp.json"
$stdout = Join-Path $WorkDir "stdout-$stamp.log"
$stderr = Join-Path $WorkDir "stderr-$stamp.log"

$env:NUWAX_LOCAL_FILES_FIXTURE = $fixture
$env:NUWAX_LOCAL_FILES_REPORT = $report
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

try {
  $process = Start-Process -FilePath $ElectronExe -ArgumentList @("`"$(Join-Path $BundleDir 'main.cjs')`"") `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -NoNewWindow
  if (-not $process.WaitForExit(120000)) {
    $process.Kill()
    Write-Output 'LOCAL_FILES_ELECTRON_TIMEOUT'
  }
  Get-Content $stdout -ErrorAction SilentlyContinue
  if (-not (Test-Path $report)) { throw "No report written; see $stderr" }
  $result = Get-Content $report -Raw | ConvertFrom-Json
  Write-Output "Report: $report"
  if (-not $result.success) { Write-Output $result.error; exit 1 }
} finally {
  Remove-Item -Recurse -Force $fixture -ErrorAction SilentlyContinue
}
