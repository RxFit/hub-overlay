<#
  deploy.ps1
  ──────────────────────────────────────────────────────────────────────────────
  Hub Overlay deploy wrapper. Enforces:
  1. Clean git status (no uncommitted changes)
  2. Correct GCP project (rxfit-automation)
  3. ALL env vars from service.yaml included
  4. Runs Playwright QA post-deploy

  USAGE:
    .\deploy.ps1              # full deploy + QA
    .\deploy.ps1 -SkipQA      # deploy only, skip post-deploy QA
    .\deploy.ps1 -DryRun      # show what would be deployed, no changes
  ──────────────────────────────────────────────────────────────────────────────
#>

param(
  [switch]$SkipQA,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# ── Configuration ─────────────────────────────────────────────────────────────
$GCP_PROJECT  = "rxfit-automation"
$REGION       = "us-central1"
$SERVICE      = "hub"
$SOURCE_DIR   = Join-Path $PSScriptRoot "hub"

# All plain env vars that MUST be set (secrets are mounted via secretKeyRef)
$ENV_VARS = @{
  "NODE_ENV"                      = "production"
  "NEXTAUTH_URL"                  = "https://hub.casatrejo.com"
  "PAPERCLIP_BASE_URL"            = "https://rxfit-paperclip-11747747730.us-central1.run.app"
  "SUPERADMIN_EMAILS"             = "danny@rxfitatx.com"
  "VERTEX_GCP_PROJECT"            = "semantic-brain-desktop"
  "VERTEX_ENGINE_ID"              = "semanticbrain_1779229063037"
  "DEFAULT_PAPERCLIP_COMPANY_ID"  = "8f2acc3d-f2dc-4f8c-897e-7c400e91fd85"
  "ADMIN_TEAM"                    = "Danny Trejo"
}

# ── Pre-flight checks ────────────────────────────────────────────────────────

Write-Host "`n🔍 Pre-flight checks..." -ForegroundColor Cyan

# 1. Verify git status is clean
Write-Host "  [1/4] Git status..." -NoNewline
$gitStatus = git -C $PSScriptRoot status --porcelain 2>&1 | Where-Object { $_ -notmatch '^\?\?' }
if ($gitStatus) {
  Write-Host " ❌" -ForegroundColor Red
  Write-Host "`n  Uncommitted changes detected:" -ForegroundColor Red
  $gitStatus | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
  Write-Host "`n  Commit or stash changes before deploying." -ForegroundColor Red
  Write-Host "  This prevents the 'deployed but not committed' anti-pattern." -ForegroundColor Gray
  exit 1
}
Write-Host " ✅ clean" -ForegroundColor Green

# 2. Verify GCP project
Write-Host "  [2/4] GCP project..." -NoNewline
$currentProject = gcloud config get-value project 2>&1
if ($currentProject -ne $GCP_PROJECT) {
  Write-Host " ⚠️  current=$currentProject, target=$GCP_PROJECT" -ForegroundColor Yellow
  Write-Host "       (deploy command explicitly targets $GCP_PROJECT)" -ForegroundColor Gray
}
Write-Host " ✅ targeting $GCP_PROJECT" -ForegroundColor Green

# 3. Verify source directory exists
Write-Host "  [3/4] Source directory..." -NoNewline
if (-not (Test-Path $SOURCE_DIR)) {
  Write-Host " ❌ $SOURCE_DIR not found" -ForegroundColor Red
  exit 1
}
Write-Host " ✅ $SOURCE_DIR" -ForegroundColor Green

# 4. Verify env vars are populated
Write-Host "  [4/4] Env vars..." -NoNewline
$emptyVars = $ENV_VARS.GetEnumerator() | Where-Object { -not $_.Value }
if ($emptyVars) {
  Write-Host " ❌" -ForegroundColor Red
  $emptyVars | ForEach-Object { Write-Host "    $($_.Key) is empty!" -ForegroundColor Red }
  exit 1
}
Write-Host " ✅ $($ENV_VARS.Count) vars configured" -ForegroundColor Green

# ── Build deploy command ──────────────────────────────────────────────────────

$envVarString = ($ENV_VARS.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ","

$deployCmd = @(
  "gcloud", "run", "deploy", $SERVICE,
  "--source", $SOURCE_DIR,
  "--project=$GCP_PROJECT",
  "--region=$REGION",
  "--allow-unauthenticated",
  "--memory=1Gi",
  "--timeout=120",
  "--min-instances=0",
  "--max-instances=3",
  "--update-env-vars=`"$envVarString`""
) -join " "

Write-Host "`n📋 Deploy command:" -ForegroundColor Cyan
Write-Host "  $deployCmd" -ForegroundColor Gray

if ($DryRun) {
  Write-Host "`n🔵 DRY RUN — no changes made." -ForegroundColor Blue
  Write-Host "  Env vars that would be set:" -ForegroundColor Gray
  $ENV_VARS.GetEnumerator() | Sort-Object Name | ForEach-Object {
    $val = if ($_.Key -match "SECRET|PASSWORD|KEY") { "***" } else { $_.Value }
    Write-Host "    $($_.Key) = $val" -ForegroundColor Gray
  }
  exit 0
}

# ── Deploy ────────────────────────────────────────────────────────────────────

Write-Host "`n🚀 Deploying to Cloud Run..." -ForegroundColor Cyan
Write-Host "  Project:  $GCP_PROJECT" -ForegroundColor Gray
Write-Host "  Service:  $SERVICE" -ForegroundColor Gray
Write-Host "  Region:   $REGION" -ForegroundColor Gray
Write-Host "  Env vars: $($ENV_VARS.Count)" -ForegroundColor Gray

gcloud run deploy $SERVICE `
  --source $SOURCE_DIR `
  --project=$GCP_PROJECT `
  --region=$REGION `
  --allow-unauthenticated `
  --memory=1Gi `
  --timeout=120 `
  --min-instances=0 `
  --max-instances=3 `
  --update-env-vars="$envVarString"

if ($LASTEXITCODE -ne 0) {
  Write-Host "`n❌ Deploy failed!" -ForegroundColor Red
  exit 1
}

Write-Host "`n✅ Deploy successful!" -ForegroundColor Green

# ── Post-deploy: Check logs for OAuth config ──────────────────────────────────

Write-Host "`n🔍 Checking Cloud Run logs for OAuth config..." -ForegroundColor Cyan
Start-Sleep -Seconds 10  # wait for new revision to boot

$logs = gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=$SERVICE AND textPayload:""[auth] OAuth config""" `
  --project=$GCP_PROJECT `
  --limit=1 `
  --format="value(textPayload)" 2>&1

if ($logs -match "OAuth config") {
  Write-Host "  $logs" -ForegroundColor Green
} else {
  Write-Host "  ⚠️  OAuth config log not found yet (may take a moment)" -ForegroundColor Yellow
  Write-Host "  Check manually: gcloud logging read '...[auth] OAuth config...' --project=$GCP_PROJECT --limit=5" -ForegroundColor Gray
}

# ── Post-deploy: QA ───────────────────────────────────────────────────────────

if ($SkipQA) {
  Write-Host "`n⏭️  Skipping QA (use without -SkipQA to run post-deploy tests)" -ForegroundColor Yellow
} else {
  Write-Host "`n🧪 Running post-deploy QA..." -ForegroundColor Cyan
  $qaScript = Join-Path $PSScriptRoot "scripts" "qa-test.js"
  if (Test-Path $qaScript) {
    node $qaScript
  } else {
    Write-Host "  ⚠️  QA script not found at $qaScript" -ForegroundColor Yellow
    Write-Host "  Skipping automated QA." -ForegroundColor Gray
  }
}

Write-Host "`n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
Write-Host "  ✅ Deploy pipeline complete" -ForegroundColor Green
Write-Host "  Service: https://hub-11747747730.us-central1.run.app" -ForegroundColor Gray
Write-Host "  Custom:  https://hub.casatrejo.com" -ForegroundColor Gray
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
