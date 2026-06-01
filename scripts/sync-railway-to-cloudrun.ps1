<#
  sync-railway-to-cloudrun.ps1
  ──────────────────────────────────────────────────────────────────────────────
  Reads the full Paperclip config from the live Railway instance (source of truth)
  and rebuilds it on Cloud Run (target). Covers:
    - All 3 companies
    - All agents (with full SOUL instructions)
    - Company secrets (EXA, GitHub, Stripe, Webhook)
    - Heartbeat routines

  USAGE:
    .\sync-railway-to-cloudrun.ps1

  Dry-run (no writes to Cloud Run):
    .\sync-railway-to-cloudrun.ps1 -DryRun

  PREREQUISITES:
    - Railway Paperclip must be accessible
    - Cloud Run Paperclip must be accessible
    - Danny's credentials must be correct below
  ──────────────────────────────────────────────────────────────────────────────
#>

param([switch]$DryRun)

# ── Source: Railway (live working instance) ────────────────────────────────────
$RAILWAY_URL      = "https://paperclip-production-4394.up.railway.app"
$DANNY_EMAIL      = "Danny@rxfitatx.com"
$DANNY_PASSWORD   = "Paperclip2026!"

# ── Target: Cloud Run (rebuild destination) ────────────────────────────────────
$CLOUDRUN_URL     = "https://rxfit-paperclip-11747747730.us-central1.run.app"

# ── Secret values to inject (reads from local env files) ─────────────────────
$EXA_ENV_PATH    = "C:\Users\danie\OneDrive\HQ Desktop\Master .ENV\exa.env"
$RXFIT_ENV_PATH  = "C:\Users\danie\OneDrive\HQ Desktop\RxFit Command Center\.env"
$MASTER_ENV_PATH = "C:\Users\danie\OneDrive\HQ Desktop\Master .ENV\.env"

if ($DryRun) { Write-Host "`n🔵 DRY RUN MODE — Cloud Run will NOT be modified" -ForegroundColor Blue }

# ── Helper: Parse .env file ───────────────────────────────────────────────────
function Read-EnvFile {
  param([string]$Path)
  $result = @{}
  if (-not (Test-Path $Path)) { Write-Warning "  [SKIP] Not found: $Path"; return $result }
  Get-Content $Path | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line -match '^([^=]+)=(.*)$') {
      $result[$Matches[1].Trim()] = $Matches[2].Trim().Trim('"').Trim("'")
    }
  }
  return $result
}

# ── Load secrets ──────────────────────────────────────────────────────────────
Write-Host "`n📂 Loading secrets from local .env files..." -ForegroundColor Cyan
$allEnv = @{}
foreach ($h in @((Read-EnvFile $EXA_ENV_PATH), (Read-EnvFile $RXFIT_ENV_PATH), (Read-EnvFile $MASTER_ENV_PATH))) {
  foreach ($kv in $h.GetEnumerator()) { $allEnv[$kv.Key] = $kv.Value }
}

function Get-Secret { param([string[]]$Keys, [string]$Name)
  foreach ($k in $Keys) { if ($allEnv[$k]) { Write-Host "  ✅ $Name ($k)" -ForegroundColor Green; return $allEnv[$k] } }
  Write-Warning "  ⚠️  $Name not found — will prompt"
  return $null
}

$EXA_API_KEY         = Get-Secret @("EXA_API_KEY","EXA_KEY","EXAAI_API_KEY") "EXA_API_KEY"
$GITHUB_TOKEN        = Get-Secret @("GITHUB_TOKEN","GH_TOKEN","GITHUB_PAT") "GITHUB_TOKEN"
$STRIPE_API_KEY      = Get-Secret @("STRIPE_API_KEY","STRIPE_SECRET_KEY","STRIPE_KEY") "STRIPE_API_KEY"
$GOOGLE_CHAT_WEBHOOK = Get-Secret @("GOOGLE_CHAT_WEBHOOK","CHAT_WEBHOOK","GCHAT_WEBHOOK") "GOOGLE_CHAT_WEBHOOK"

if (-not $EXA_API_KEY)         { $EXA_API_KEY         = Read-Host "Enter EXA_API_KEY" }
if (-not $GITHUB_TOKEN)        { $GITHUB_TOKEN         = Read-Host "Enter GITHUB_TOKEN" }
if (-not $STRIPE_API_KEY)      { $STRIPE_API_KEY       = Read-Host "Enter STRIPE_API_KEY" }
if (-not $GOOGLE_CHAT_WEBHOOK) { $GOOGLE_CHAT_WEBHOOK  = Read-Host "Enter GOOGLE_CHAT_WEBHOOK" }

# ── Auth helper ───────────────────────────────────────────────────────────────
function Connect-Paperclip {
  param([string]$BaseUrl, [string]$Label)
  Write-Host "`n🔐 Authenticating to $Label ($BaseUrl)..." -ForegroundColor Cyan
  try {
    $body = @{ email = $DANNY_EMAIL; password = $DANNY_PASSWORD } | ConvertTo-Json
    $resp = Invoke-WebRequest -Uri "$BaseUrl/api/auth/sign-in/email" -Method POST `
      -ContentType "application/json" -Body $body -SessionVariable session -ErrorAction Stop
    Write-Host "  ✅ Authenticated (HTTP $($resp.StatusCode))" -ForegroundColor Green
    return $session
  } catch {
    Write-Error "❌ Auth failed for $Label: $_"
    return $null
  }
}

function Invoke-PaperclipAPI {
  param([object]$Session, [string]$BaseUrl, [string]$Path, [string]$Method = "GET", [object]$Body = $null)
  $params = @{
    Uri = "$BaseUrl$Path"
    Method = $Method
    WebSession = $Session
    ErrorAction = "Stop"
  }
  if ($Body) {
    $params.ContentType = "application/json"
    $params.Body = ($Body | ConvertTo-Json -Depth 10 -Compress)
  }
  return Invoke-RestMethod @params
}

# ── Step 1: Connect to both instances ─────────────────────────────────────────
$railwaySession  = Connect-Paperclip -BaseUrl $RAILWAY_URL  -Label "Railway (source)"
$cloudrunSession = Connect-Paperclip -BaseUrl $CLOUDRUN_URL -Label "Cloud Run (target)"

if (-not $railwaySession -or -not $cloudrunSession) { exit 1 }

# ── Step 2: Read all companies from Railway ────────────────────────────────────
Write-Host "`n📦 Reading companies from Railway..." -ForegroundColor Cyan
$railwayCompanies = @()
try {
  $resp = Invoke-PaperclipAPI -Session $railwaySession -BaseUrl $RAILWAY_URL -Path "/api/companies"
  $railwayCompanies = $resp.companies ?? $resp
  Write-Host "  Found $($railwayCompanies.Count) companies" -ForegroundColor Green
} catch {
  Write-Error "❌ Failed to read companies from Railway: $_"
  exit 1
}

# ── Company ID mapping (Railway UUID → Cloud Run UUID) ────────────────────────
# We'll try to preserve the original UUIDs when creating on Cloud Run.
# If Cloud Run doesn't support custom IDs, we'll build a mapping table.
$companyIdMap = @{}  # railwayId → cloudRunId

# ── Step 3: Read existing Cloud Run companies to avoid duplication ─────────────
Write-Host "`n🔍 Reading existing Cloud Run companies..." -ForegroundColor Cyan
$existingCRCompanies = @()
try {
  $resp = Invoke-PaperclipAPI -Session $cloudrunSession -BaseUrl $CLOUDRUN_URL -Path "/api/companies"
  $existingCRCompanies = $resp.companies ?? $resp
  Write-Host "  Found $($existingCRCompanies.Count) existing companies on Cloud Run" -ForegroundColor Yellow
} catch {
  Write-Warning "  Could not read Cloud Run companies — will create fresh"
}

# ── Step 4: Create/map companies on Cloud Run ─────────────────────────────────
Write-Host "`n🏢 Syncing companies to Cloud Run..." -ForegroundColor Cyan

foreach ($company in $railwayCompanies) {
  # Check if already exists by name or identifier
  $existing = $existingCRCompanies | Where-Object {
    $_.name -eq $company.name -or $_.identifier -eq $company.identifier
  } | Select-Object -First 1

  if ($existing) {
    Write-Host "  ♻️  '$($company.name)' already exists on Cloud Run → ID: $($existing.id)" -ForegroundColor Yellow
    $companyIdMap[$company.id] = $existing.id
    continue
  }

  if ($DryRun) {
    Write-Host "  🔵 [DRY RUN] Would create: $($company.name) ($($company.identifier))" -ForegroundColor Blue
    $companyIdMap[$company.id] = "dry-run-id-$($company.identifier)"
    continue
  }

  try {
    $createBody = @{
      name        = $company.name
      identifier  = $company.identifier
      description = $company.description ?? "$($company.name) workspace — synced from Railway"
    }
    $resp = Invoke-PaperclipAPI -Session $cloudrunSession -BaseUrl $CLOUDRUN_URL -Path "/api/companies" -Method "POST" -Body $createBody
    $newCompany = $resp.company ?? $resp
    $companyIdMap[$company.id] = $newCompany.id
    Write-Host "  ✅ Created '$($company.name)' → Cloud Run ID: $($newCompany.id)" -ForegroundColor Green
  } catch {
    Write-Warning "  ❌ Failed to create '$($company.name)': $_"
  }
}

# ── Step 5: Sync agents per company ───────────────────────────────────────────
Write-Host "`n🤖 Syncing agents to Cloud Run..." -ForegroundColor Cyan

$totalAgents    = 0
$syncedAgents   = 0
$skippedAgents  = 0
$failedAgents   = 0

foreach ($company in $railwayCompanies) {
  $crCompanyId = $companyIdMap[$company.id]
  if (-not $crCompanyId) {
    Write-Warning "  No Cloud Run company ID for '$($company.name)' — skipping agents"
    continue
  }

  Write-Host "`n  📦 $($company.name) → CR: $crCompanyId" -ForegroundColor Magenta

  # Read agents from Railway
  try {
    $agentResp = Invoke-PaperclipAPI -Session $railwaySession -BaseUrl $RAILWAY_URL -Path "/api/companies/$($company.id)/agents"
    $railwayAgents = $agentResp.agents ?? $agentResp
    Write-Host "  Reading $($railwayAgents.Count) agents from Railway..." -ForegroundColor Gray
  } catch {
    Write-Warning "  Failed to read agents: $_"
    continue
  }

  # Read existing Cloud Run agents to avoid duplicates
  $existingCRAgents = @()
  try {
    $crAgentResp = Invoke-PaperclipAPI -Session $cloudrunSession -BaseUrl $CLOUDRUN_URL -Path "/api/companies/$crCompanyId/agents"
    $existingCRAgents = $crAgentResp.agents ?? $crAgentResp
  } catch { }

  # Sort: CEOs first so reportsTo relationships can reference them
  $sortedAgents = $railwayAgents | Sort-Object { if ($_.name -match 'CEO|Chief Executive') { 0 } else { 1 } }

  # Agent name → Cloud Run ID map (for reportsTo wiring)
  $agentNameToId = @{}
  foreach ($a in $existingCRAgents) { $agentNameToId[$a.name] = $a.id }

  foreach ($agent in $sortedAgents) {
    $totalAgents++

    # Get full agent details (SOUL/instructions)
    try {
      $detail = Invoke-PaperclipAPI -Session $railwaySession -BaseUrl $RAILWAY_URL -Path "/api/companies/$($company.id)/agents/$($agent.id)"
    } catch {
      Write-Warning "    ❌ Could not fetch details for '$($agent.name)': $_"
      $failedAgents++
      continue
    }

    $soul = $detail.instructions ?? $detail.soul ?? $detail.system_prompt ?? ""

    # Check if already exists
    $exists = $existingCRAgents | Where-Object { $_.name -eq $agent.name } | Select-Object -First 1
    if ($exists) {
      Write-Host "    ♻️  '$($agent.name)' already exists" -ForegroundColor Yellow
      $agentNameToId[$agent.name] = $exists.id
      $skippedAgents++
      continue
    }

    if ($DryRun) {
      Write-Host "    🔵 [DRY RUN] Would create: $($agent.name)" -ForegroundColor Blue
      $syncedAgents++
      continue
    }

    # Resolve reportsTo (find manager's Cloud Run ID)
    $reportsToId = $null
    if ($detail.reportsTo) {
      # Try to find the reporting agent by name lookup in existingCRAgents
      $manager = $existingCRAgents | Where-Object { $_.id -eq $detail.reportsTo } | Select-Object -First 1
      if ($manager) { $reportsToId = $agentNameToId[$manager.name] }
    }

    try {
      $createBody = @{
        name            = $agent.name
        role            = $agent.role ?? "agent"
        instructions    = $soul
        canCreateAgents = $detail.canCreateAgents ?? $false
        adapterType     = "gemini_cli"
        adapterConfig   = @{
          baseUrl = "https://rxfit-llm-proxy-6r2wdzwkoq-uc.a.run.app"
        }
      }
      if ($reportsToId) { $createBody.reportsTo = $reportsToId }

      $resp = Invoke-PaperclipAPI -Session $cloudrunSession -BaseUrl $CLOUDRUN_URL -Path "/api/companies/$crCompanyId/agents" -Method "POST" -Body $createBody
      $newAgent = $resp.agent ?? $resp
      $agentNameToId[$agent.name] = $newAgent.id
      Write-Host "    ✅ Created '$($agent.name)' → $($newAgent.id)" -ForegroundColor Green
      $syncedAgents++
    } catch {
      Write-Warning "    ❌ Failed to create '$($agent.name)': $_"
      $failedAgents++
    }

    Start-Sleep -Milliseconds 200  # Rate limiting
  }
}

# ── Step 6: Inject company secrets ────────────────────────────────────────────
Write-Host "`n🔑 Injecting secrets into Cloud Run companies..." -ForegroundColor Cyan

$secrets = @{
  "EXA_API_KEY"         = $EXA_API_KEY
  "GITHUB_TOKEN"        = $GITHUB_TOKEN
  "STRIPE_API_KEY"      = $STRIPE_API_KEY
  "GOOGLE_CHAT_WEBHOOK" = $GOOGLE_CHAT_WEBHOOK
}

foreach ($company in $railwayCompanies) {
  $crCompanyId = $companyIdMap[$company.id]
  if (-not $crCompanyId -or $crCompanyId.StartsWith("dry-run")) { continue }

  Write-Host "`n  📦 $($company.name)" -ForegroundColor Magenta
  foreach ($secret in $secrets.GetEnumerator()) {
    if (-not $secret.Value) { Write-Warning "    [SKIP] $($secret.Key) is empty"; continue }
    if ($DryRun) { Write-Host "    🔵 [DRY RUN] Would inject $($secret.Key)" -ForegroundColor Blue; continue }
    try {
      Invoke-PaperclipAPI -Session $cloudrunSession -BaseUrl $CLOUDRUN_URL `
        -Path "/api/companies/$crCompanyId/secrets" -Method "POST" `
        -Body @{ key = $secret.Key; value = $secret.Value } | Out-Null
      Write-Host "    ✅ $($secret.Key) injected" -ForegroundColor Green
    } catch {
      $code = $_.Exception.Response.StatusCode.value__
      if ($code -eq 409) {
        Write-Host "    ♻️  $($secret.Key) already exists" -ForegroundColor Yellow
      } else {
        Write-Warning "    ❌ $($secret.Key) failed: $_"
      }
    }
  }
}

# ── Step 7: Recreate heartbeat routines ───────────────────────────────────────
Write-Host "`n💓 Recreating heartbeat routines on Cloud Run..." -ForegroundColor Cyan

$CADENCES = @{ CEO = 604800; CMO = 86400; CTO = 86400; CFO = 604800; COO = 604800 }
$PROMPTS = @{
  CEO = "Conduct your weekly executive review. Check all C-Suite agent activity from the past week. Identify critical issues, flag blockers, and set priorities. Use exa_search for market context and industry news."
  CMO = "Conduct your daily marketing review. Audit all marketing KPIs, campaign performance, and SEO/AEO/GEO metrics. Identify the top 3 marketing actions needed today. Use exa_search for competitor intelligence."
  CTO = "Conduct your daily technical review. Check system health, audit open GitHub issues/PRs, review QA and DevOps status. Flag any technical debt or blockers. Use exa_search for relevant technology updates."
  CFO = "Conduct your weekly financial review. Audit Stripe data, track revenue vs. projections, flag billing anomalies >15% variance. Escalate critical financial issues to the CEO immediately."
  COO = "Conduct your weekly operations review. Check all operational workflows, team communications, and process efficiency. Coordinate with C-Suite to resolve identified bottlenecks."
}

foreach ($company in $railwayCompanies) {
  $crCompanyId = $companyIdMap[$company.id]
  if (-not $crCompanyId -or $crCompanyId.StartsWith("dry-run")) { continue }

  Write-Host "`n  📦 $($company.name)" -ForegroundColor Magenta

  # Get Cloud Run agents for this company
  try {
    $crAgents = (Invoke-PaperclipAPI -Session $cloudrunSession -BaseUrl $CLOUDRUN_URL -Path "/api/companies/$crCompanyId/agents").agents
  } catch { Write-Warning "  Could not fetch CR agents"; continue }

  foreach ($role in $CADENCES.Keys) {
    $agent = $crAgents | Where-Object { $_.name -match $role } | Select-Object -First 1
    if (-not $agent) { continue }

    if ($DryRun) {
      Write-Host "  🔵 [DRY RUN] Would create $role heartbeat for $($company.name)" -ForegroundColor Blue
      continue
    }

    try {
      Invoke-PaperclipAPI -Session $cloudrunSession -BaseUrl $CLOUDRUN_URL `
        -Path "/api/companies/$crCompanyId/routines" -Method "POST" -Body @{
          agentId     = $agent.id
          type        = "heartbeat"
          cadence     = $CADENCES[$role]
          prompt      = $PROMPTS[$role]
          enabled     = $true
          name        = "$($agent.name) Heartbeat"
        } | Out-Null
      $label = if ($CADENCES[$role] -eq 86400) { "Daily" } else { "Weekly" }
      Write-Host "  ✅ $role $label heartbeat created" -ForegroundColor Green
    } catch {
      $code = $_.Exception.Response.StatusCode.value__
      if ($code -eq 409) { Write-Host "  ♻️  $role heartbeat already exists" -ForegroundColor Yellow }
      else { Write-Warning "  ❌ $role heartbeat failed: $_" }
    }
  }
}

# ── Summary ───────────────────────────────────────────────────────────────────
Write-Host "`n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
Write-Host "  📊 Sync Summary" -ForegroundColor Cyan
Write-Host "  Companies mapped: $($companyIdMap.Count)"
Write-Host "  Agents total:     $totalAgents"
Write-Host "  Agents synced:    $syncedAgents"  -ForegroundColor Green
Write-Host "  Agents skipped:   $skippedAgents" -ForegroundColor Yellow
Write-Host "  Agents failed:    $failedAgents"  -ForegroundColor $(if ($failedAgents -gt 0) { "Red" } else { "Gray" })
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray

if ($DryRun) {
  Write-Host "`n🔵 Dry run complete. Re-run without -DryRun to apply." -ForegroundColor Blue
} else {
  Write-Host "`n✅ Sync complete!" -ForegroundColor Green
  Write-Host "`n📋 NEXT STEPS:" -ForegroundColor Cyan
  Write-Host "  1. Login to Cloud Run Paperclip → Settings → API Keys → New Key" -ForegroundColor White
  Write-Host "     URL: $CLOUDRUN_URL" -ForegroundColor Gray
  Write-Host "  2. Set on Railway Hub service:" -ForegroundColor White
  Write-Host "     PAPERCLIP_BASE_URL = $CLOUDRUN_URL" -ForegroundColor Gray
  Write-Host "     PAPERCLIP_API_KEY  = <your new key>" -ForegroundColor Gray
  Write-Host "  3. Redeploy Hub on Railway" -ForegroundColor White
  Write-Host "  4. Verify execution feed shows Cloud Run data" -ForegroundColor White
}
