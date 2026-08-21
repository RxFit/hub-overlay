# AgyWorkerUpdate — nightly rebuild from freshly-pulled master (no babysitting).
# Fast-forwards ONLY to origin/master: the exact artifact CI gated and Jules
# merged. Stamps the image with the git SHA so /api/admin/dispatch-health can
# show worker-vs-Hub drift. Rollback = run with -Sha <known-good>.
#
# Hardened (review 2026-08-20, move 4): this script used to be 17 lines with
# no error handling and no log — a nightly task that failed SILENTLY, leaving
# the worker on a stale build with nothing anywhere saying so. Now every run
# transcribes to %USERPROFILE%\agy-worker\update.log, every external command
# is exit-code-checked, and image + builder caches are pruned so nightly
# rebuilds stop growing the WSL2 vhdx until the disk chokes.
param(
  [string]$RepoPath = 'C:\hub-overlay',
  [string]$Sha = ''
)

$ErrorActionPreference = 'Stop'

$logDir = Join-Path $env:USERPROFILE 'agy-worker'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$transcript = Join-Path $logDir 'update.log'
# Rotate at ~1MB: keep one predecessor (same policy as watchdog.log).
if ((Test-Path $transcript) -and ((Get-Item $transcript).Length -gt 1MB)) {
  Move-Item -Force $transcript "$transcript.1"
}
Start-Transcript -Path $transcript -Append | Out-Null

function Invoke-Checked {
  param([string]$What, [scriptblock]$Cmd)
  Write-Host ">> $What"
  & $Cmd
  if ($LASTEXITCODE -ne 0) {
    throw "$What failed (exit $LASTEXITCODE)"
  }
}

try {
  Set-Location $RepoPath

  Invoke-Checked 'git fetch' { git fetch origin }
  if ($Sha) {
    Invoke-Checked "git reset --hard $Sha (rollback)" { git reset --hard $Sha }
  } else {
    Invoke-Checked 'git reset --hard origin/master' { git reset --hard origin/master }
  }

  $env:WORKER_GIT_SHA = (git rev-parse --short=12 HEAD)
  if ($LASTEXITCODE -ne 0 -or -not $env:WORKER_GIT_SHA) {
    throw 'git rev-parse produced no SHA'
  }

  $compose = Join-Path $RepoPath 'scripts\agy-worker\docker-compose.yml'
  Invoke-Checked 'docker compose build' { docker compose -f $compose build }
  Invoke-Checked 'docker compose up -d' { docker compose -f $compose up -d }

  # Verify the container actually came up on the new build before declaring
  # success — `up -d` exits 0 even when the container then crash-loops.
  Start-Sleep -Seconds 10
  $running = docker inspect -f '{{.State.Running}}' agy-worker 2>$null
  if ($running -ne 'true') {
    throw 'agy-worker container is not running after up -d — check `docker logs agy-worker`'
  }

  # Reclaim what the nightly rebuild leaves behind. Dangling images are
  # yesterday's build layers; the builder cache is bounded rather than purged
  # so tomorrow's rebuild stays incremental.
  Invoke-Checked 'docker image prune' { docker image prune -f }
  Invoke-Checked 'docker builder prune (keep 10GB)' { docker builder prune -f --keep-storage 10GB }

  $free = [math]::Round((Get-PSDrive C).Free / 1GB, 1)
  Write-Host "agy-worker updated to $env:WORKER_GIT_SHA (C: free ${free}GB)"
} catch {
  Write-Host "UPDATE FAILED: $_"
  # Non-zero exit so Task Scheduler records the failure (Last Run Result).
  Stop-Transcript | Out-Null
  exit 1
}

Stop-Transcript | Out-Null
