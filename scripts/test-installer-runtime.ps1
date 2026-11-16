# Run the production probe without installing anything or touching registration.
param([string]$RuntimeScript = (Join-Path $PSScriptRoot '../nuwa-electron-shell/crates/agent-electron-client/build/installer-runtime.ps1'))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows runtime verification requires Windows.' }
$source = [IO.Path]::GetFullPath($RuntimeScript)
$root = Join-Path ([IO.Path]::GetTempPath()) ('nuwax-runtime-test-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
try {
  # NSIS's native plugin must not be resolved as the C# framework reference.
  [IO.File]::WriteAllText((Join-Path $root 'System.dll'), 'Synthetic native-plugin name collision; never loaded.')
  foreach ($hostDirectory in @('SysWOW64', 'System32')) {
    $hostExe = Join-Path $env:SystemRoot ($hostDirectory + '\WindowsPowerShell\v1.0\powershell.exe')
    if (-not [IO.File]::Exists($hostExe)) { continue }
    foreach ($constrained in @($false, $true)) {
      $start = [Diagnostics.ProcessStartInfo]::new()
      $start.FileName = $hostExe
      $escaped = $source.Replace("'", "''")
      # A separate script can run with its own trusted language mode. Exercise
      # the capability body in the constrained scope instead of assuming that
      # invoking a file inherits a manually changed caller mode.
      $command = if ($constrained) { '$ExecutionContext.SessionState.LanguageMode = "ConstrainedLanguage"; ' + [IO.File]::ReadAllText($source) } else { "& '" + $escaped + "'" }
      $start.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
      $start.UseShellExecute = $false
      $start.CreateNoWindow = $true
      $start.RedirectStandardOutput = $true
      $start.RedirectStandardError = $true
      $start.WorkingDirectory = $root
      $start.EnvironmentVariables['TEMP'] = $root
      $start.EnvironmentVariables['TMP'] = $root
      $process = [Diagnostics.Process]::Start($start)
      try {
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(45000)) { $process.Kill(); throw 'Runtime probe timed out.' }
        $output = $stdout.Result.Trim()
        $detail = $stderr.Result.Trim()
        if ($constrained) {
          if ($process.ExitCode -eq 0 -or $output -eq 'NUWAX_INSTALL_RUNTIME_OK') { throw 'Constrained runtime was incorrectly accepted.' }
        } elseif ($process.ExitCode -ne 0 -or $output -ne 'NUWAX_INSTALL_RUNTIME_OK') {
          throw ('Normal runtime failed: ' + $detail)
        }
        if (@([IO.Directory]::GetFiles($root, 'Nuwax-installer-probe-*')).Count -ne 0) { throw 'Runtime probe leaked temporary files.' }
        Write-Output ('PASS host=' + $hostDirectory + ' constrained=' + $constrained)
      } finally { $process.Dispose() }
    }
  }
} finally {
  [IO.Directory]::Delete($root, $true)
}
