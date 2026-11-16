param(
  [Parameter(Mandatory=$true)][string]$FilesJson,
  [Parameter(Mandatory=$true)][string]$SignTool,
  [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'
$plan = Get-Content -LiteralPath $FilesJson -Raw | ConvertFrom-Json
$timestamp = if ($env:WINDOWS_TIMESTAMP_URL) { $env:WINDOWS_TIMESTAMP_URL } else { 'http://timestamp.sectigo.com' }
$sha1 = if ($env:WINDOWS_CERTIFICATE_SHA1) { $env:WINDOWS_CERTIFICATE_SHA1 } else { $env:CS_CERT_SHA1 }
$certPath = if ($env:WINDOWS_CERTIFICATE_PATH) { $env:WINDOWS_CERTIFICATE_PATH } else { $env:CS_CERT_PATH }
$password = if ($env:WINDOWS_CERTIFICATE_PASSWORD) { $env:WINDOWS_CERTIFICATE_PASSWORD } else { $env:CS_CERT_PASSWORD }
$count = 0
foreach ($file in $plan.files) {
  if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing code file: $file" }
  $signature = Get-AuthenticodeSignature -LiteralPath $file
  if (!$VerifyOnly -and ($signature.Status -eq 'NotSigned' -or $plan.force -contains $file)) {
    $arguments = @('sign', '/fd', 'sha256', '/tr', $timestamp, '/td', 'sha256')
    if ($sha1) { $arguments += @('/sha1', $sha1) }
    elseif ($certPath) {
      $arguments += @('/f', $certPath)
      if ($password) { $arguments += @('/p', $password) }
    } else { throw 'A Windows signing certificate is required' }
    # signtool supports PE and PowerShell on the ARM64 signing machine. Do not
    # use Set-AuthenticodeSignature, whose provider may be unavailable there.
    & $SignTool @arguments $file | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Signing failed: $file" }
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    if (!$signature.TimeStamperCertificate) { throw "Missing signing timestamp: $file" }
  }
  # Preserve trusted vendor signatures; never replace a corrupt/untrusted one
  # simply to hide a verification failure.
  if ($signature.Status -ne 'Valid') { throw "Invalid signature ($($signature.Status)): $file" }
  if ($plan.force -contains $file) {
    if (!$signature.TimeStamperCertificate) { throw "Missing signing timestamp: $file" }
    if ($sha1 -and $signature.SignerCertificate.Thumbprint -ne $sha1) { throw "Unexpected product signer: $file" }
    & $SignTool verify /pa /all $file | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "signtool verification failed: $file" }
  }
  $count++
}
Write-Host "Verified $count packaged code signatures."
