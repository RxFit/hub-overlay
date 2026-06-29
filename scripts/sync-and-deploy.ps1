<#
  sync-and-deploy.ps1
  ------------------------------------------------------------------------------
  Convenience wrapper around deploy.ps1 that automates the full deploy cycle:
  1. Verifies you're on the master branch (prompts to switch if not)
  2. Pulls latest from origin (fast-forward only)
  3. Stashes any tracked changes (so deploy.ps1's git-clean check passes)
  4. Invokes deploy.ps1 with passthrough flags
  5. Pops the stash after deploy (or on failure, via try/finally)

  USAGE:
    .\scripts\sync-and-deploy.ps1                # full sync + deploy + QA
    .\scripts\sync-and-deploy.ps1 -SkipQA        # sync + deploy, skip QA
    .\scripts\sync-and-deploy.ps1 -DryRun        # sync + show what would deploy
  ------------------------------------------------------------------------------
#>

param(
  [switch]$SkipQA,
  [switch]$DryRun
)

$ErrorActionPreference = "Continue"

$REPO_ROOT   = Join-Path $PSScriptRoot ".."  | Resolve-Path
$DEPLOY_SCRIPT = Join-Path $REPO_ROOT "deploy.ps1"

# -- Helpers -------------------------------------------------------------------

function Write-Step {
  param([string]$Number, [string]$Label)
  Write-Host "  [$Number] $Label" -NoNewline
}

function Write-Ok {
  param([string]$Detail = "")
  if ($Detail) {
    Write-Host " [OK] $Detail" -ForegroundColor Green
  } else {
    Write-Host " [OK]" -ForegroundColor Green
  }
}

function Write-Fail {
  param([string]$Detail)
  Write-Host " [FAILED] $Detail" -ForegroundColor Red
}

# -- Pre-flight checks --------------------------------------------------------

Write-Host "`n==============================================" -ForegroundColor DarkGray
Write-Host "  * sync-and-deploy - Hub Overlay" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor DarkGray

Write-Host "`n* Pre-flight checks..." -ForegroundColor Cyan

# 1. Verify deploy.ps1 exists
Write-Step "1/3" "Deploy script..."
if (-not (Test-Path $DEPLOY_SCRIPT)) {
  Write-Fail "deploy.ps1 not found at $DEPLOY_SCRIPT"
  exit 1
}
Write-Ok "found"

# 2. Verify we're on master
Write-Step "2/3" "Git branch..."
$currentBranch = git -C $REPO_ROOT rev-parse --abbrev-ref HEAD 2>&1
if ($currentBranch -ne "master") {
  Write-Host " WARNING: on '$currentBranch'" -ForegroundColor Yellow
  $response = Read-Host "  Switch to master? (y/N)"
  if ($response -match "^[Yy]") {
    git -C $REPO_ROOT checkout master
    if ($LASTEXITCODE -ne 0) {
      Write-Fail "Could not switch to master"
      exit 1
    }
    Write-Host "  Switched to master" -ForegroundColor Green
  } else {
    Write-Host "  Aborting - deploy should run from master." -ForegroundColor Red
    exit 1
  }
} else {
  Write-Ok "master"
}

# 3. Pull latest
Write-Step "3/3" "Pulling latest..."
$pullOutput = git -C $REPO_ROOT pull origin master --ff-only 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Fail "git pull failed"
  Write-Host "  $pullOutput" -ForegroundColor Yellow
  Write-Host "  Resolve diverged history before deploying." -ForegroundColor Red
  exit 1
}
if ($pullOutput -match "Already up to date") {
  Write-Ok "already up to date"
} else {
  Write-Ok "updated"
}

# -- Stash tracked changes ----------------------------------------------------

$stashCreated = $false
$trackedChanges = git -C $REPO_ROOT status --porcelain 2>&1 | Where-Object { $_ -notmatch '^\?\?' }

if ($trackedChanges) {
  Write-Host "`n* Stashing tracked changes..." -ForegroundColor Cyan
  $trackedChanges | ForEach-Object { Write-Host "    $_" -ForegroundColor Gray }

  git -C $REPO_ROOT stash push -m "pre-deploy stash (sync-and-deploy)" --include-untracked 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  ❌ git stash failed" -ForegroundColor Red
    exit 1
  }
  $stashCreated = $true
  Write-Host "  [OK] Changes stashed" -ForegroundColor Green
} else {
  Write-Host "`n* No tracked changes to stash" -ForegroundColor Gray
}

# -- Deploy (with stash-pop in finally) ----------------------------------------

try {
  Write-Host "`n* Invoking deploy.ps1..." -ForegroundColor Cyan

  $deployArgs = @()
  if ($SkipQA)  { $deployArgs += "-SkipQA" }
  if ($DryRun)  { $deployArgs += "-DryRun" }

  & $DEPLOY_SCRIPT @deployArgs

  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
    throw "deploy.ps1 exited with code $LASTEXITCODE"
  }
}
catch {
  Write-Host "`n[FAILED] Deploy failed: $_" -ForegroundColor Red
  # Stash pop happens in finally block
  exit 1
}
finally {
  # -- Restore stash ----------------------------------------------------------
  if ($stashCreated) {
    Write-Host "`n* Restoring stashed changes..." -ForegroundColor Cyan
    git -C $REPO_ROOT stash pop 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Write-Host "  WARNING: Stash pop failed - your changes are still in the stash." -ForegroundColor Yellow
      Write-Host "  Run 'git stash pop' manually to restore them." -ForegroundColor Yellow
    } else {
      Write-Host "  [OK] Stash restored" -ForegroundColor Green
    }
  }
}

Write-Host "`n==============================================" -ForegroundColor DarkGray
Write-Host "  [SUCCESS] sync-and-deploy complete" -ForegroundColor Green
Write-Host "==============================================" -ForegroundColor DarkGray
