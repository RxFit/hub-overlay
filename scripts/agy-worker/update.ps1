# AgyWorkerUpdate — nightly rebuild from freshly-pulled master (no babysitting).
# Fast-forwards ONLY to origin/master: the exact artifact CI gated and Jules
# merged. Stamps the image with the git SHA so /api/admin/dispatch-health can
# show worker-vs-Hub drift. Rollback = run with -Sha <known-good>.
param(
  [string]$RepoPath = 'C:\hub-overlay',
  [string]$Sha = ''
)

Set-Location $RepoPath
git fetch origin
if ($Sha) { git reset --hard $Sha } else { git reset --hard origin/master }
$env:WORKER_GIT_SHA = (git rev-parse --short=12 HEAD)

docker compose -f scripts\agy-worker\docker-compose.yml build
docker compose -f scripts\agy-worker\docker-compose.yml up -d
Write-Host "agy-worker updated to $env:WORKER_GIT_SHA"
