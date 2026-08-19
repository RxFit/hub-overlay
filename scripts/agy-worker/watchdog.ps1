# AgyWorkerWatchdog — keeps the dispatch worker alive on the desktop.
# Registered by install.ps1 as a Scheduled Task (at logon + every 5 minutes),
# the accepted supervision pattern on this machine (paperclip-suite precedent).
# Docker's own `restart: unless-stopped` covers worker crashes; this covers
# the one thing it can't — Docker Desktop itself not running after a reboot.
# Honest dependency (runbook): Docker Desktop needs a logged-in session; a
# locked screen is fine, a logged-out machine is not. The failure is legible
# either way: dispatch-health shows the worker stale and chat rides metered.
param([string]$RepoPath = 'C:\hub-overlay')

$logDir = Join-Path $env:USERPROFILE 'agy-worker'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'watchdog.log'
function Write-Log($msg) {
  Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
  # Rotate at ~1MB: keep one predecessor.
  if ((Get-Item $log).Length -gt 1MB) { Move-Item -Force $log "$log.1" }
}

docker info *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Log 'docker not responding — starting Docker Desktop'
  Start-Process 'C:\Program Files\Docker\Docker\Docker Desktop.exe' -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 60
}

$running = docker inspect -f '{{.State.Running}}' agy-worker 2>$null
if ($running -ne 'true') {
  Write-Log 'agy-worker not running — compose up -d'
  docker compose -f (Join-Path $RepoPath 'scripts\agy-worker\docker-compose.yml') up -d 2>&1 |
    ForEach-Object { Write-Log "  $_" }
}
