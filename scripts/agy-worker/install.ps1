# One-time desktop setup for the dispatch worker (run as the logged-in user):
#   powershell -ExecutionPolicy Bypass -File scripts\agy-worker\install.ps1
# Creates .env from the example (edit it before the worker can connect),
# registers the watchdog (at logon + every 5 min) and the nightly update task,
# and starts the worker now.
param([string]$RepoPath = 'C:\hub-overlay')

$dir = Join-Path $RepoPath 'scripts\agy-worker'
$envFile = Join-Path $dir '.env'
if (-not (Test-Path $envFile)) {
  Copy-Item (Join-Path $dir '.env.example') $envFile
  Write-Host "Created $envFile — EDIT IT: set AGY_WORKER_SECRET (must match the Hub's Secret Manager value)." -ForegroundColor Yellow
}

$psExe = 'powershell.exe'

$watchdogAction = New-ScheduledTaskAction -Execute $psExe `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$dir\watchdog.ps1`" -RepoPath `"$RepoPath`""
$watchdogTriggers = @(
  (New-ScheduledTaskTrigger -AtLogOn),
  (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5))
)
Register-ScheduledTask -TaskName 'AgyWorkerWatchdog' -Action $watchdogAction -Trigger $watchdogTriggers -Force | Out-Null

$updateAction = New-ScheduledTaskAction -Execute $psExe `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$dir\update.ps1`" -RepoPath `"$RepoPath`""
$updateTrigger = New-ScheduledTaskTrigger -Daily -At '04:00'
Register-ScheduledTask -TaskName 'AgyWorkerUpdate' -Action $updateAction -Trigger $updateTrigger -Force | Out-Null

Write-Host 'Scheduled tasks registered: AgyWorkerWatchdog (logon + 5min), AgyWorkerUpdate (daily 04:00).'
Write-Host 'Starting the worker now...'
& (Join-Path $dir 'update.ps1') -RepoPath $RepoPath
