# HZN Bot Auto - Windows supervisor.
# Restarts the bot after a crash (exit code != 0) with exponential back-off.
# A clean stop (npm run stop, Ctrl+C -> exit code 0) ends the supervisor.
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\run-bot.ps1
param(
  [int]$MaxBackoffSeconds = 300
)
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
New-Item -ItemType Directory -Force -Path (Join-Path $root "logs") | Out-Null
$supLog = Join-Path $root "logs\supervisor.log"
$backoff = 5
$node = (Get-Command node -ErrorAction Stop).Source

function Log($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
  Write-Host $line
  Add-Content -Path $supLog -Value $line
}

Log "supervisor started (node: $node)"
while ($true) {
  $started = Get-Date
  & $node "src/index.js"
  $code = $LASTEXITCODE
  $ran = ((Get-Date) - $started).TotalSeconds
  if ($code -eq 0) { Log "bot exited cleanly (code 0) - supervisor stopping"; break }
  if ($code -eq 2) { Log "invalid configuration (code 2) - fix .env, supervisor stopping"; break }
  if ($code -eq 3) { Log "another instance is running (code 3) - supervisor stopping"; break }
  if ($ran -gt 600) { $backoff = 5 }
  Log "bot exited with code $code after $([int]$ran)s - restarting in $backoff s"
  Start-Sleep -Seconds $backoff
  $backoff = [Math]::Min($MaxBackoffSeconds, $backoff * 2)
}
