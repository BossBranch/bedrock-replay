$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

# No trailing slash — Windows quote bug with paths ending in \
$app = $PSScriptRoot.TrimEnd('\')
$ele = Join-Path $app 'node_modules\electron\dist\electron.exe'

Write-Host '=== Bedrock Replay Launcher (PowerShell) ==='
Write-Host "Dir: $app"

if (-not (Test-Path -LiteralPath $ele)) {
  Write-Host 'Electron missing — npm install...'
  npm.cmd install
}

if (-not (Test-Path -LiteralPath $ele)) {
  Write-Host "ERROR: no electron at $ele"
  Read-Host 'Press Enter'
  exit 1
}

Write-Host 'Starting...'
Start-Process -FilePath $ele -ArgumentList $app -WorkingDirectory $app
Write-Host 'OK — GUI should be open.'
Start-Sleep -Seconds 2
