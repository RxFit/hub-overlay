<#
  sync-railway-to-cloudrun.ps1
  Reads the full Paperclip config from Railway (source of truth)
  and rebuilds it on Cloud Run (target).
  Compatible with PowerShell 5.1+

  USAGE:
    .\sync-railway-to-cloudrun.ps1
    .\sync-railway-to-cloudrun.ps1 -DryRun
#>

param([switch]$DryRun)

Set-StrictMode -Off

# Source: Railway
$RAILWAY_URL    = "https://paperclip-production-4394.up.railway.app"
$DANNY_EMAIL    = "Danny@rxfitatx.com"
# SECURITY: plaintext password removed 2026-06-12 (was committed to the repo — change it).
$DANNY_PASSWORD = $env:PAPERCLIP_BOARD_PASSWORD
if (-not $DANNY_PASSWORD) { Write-Error "Set PAPERCLIP_BOARD_PASSWORD env var"; exit 1 }

# Target: Cloud Run
$CLOUDRUN_URL = "https://rxfit-paperclip-11747747730.us-central1.run.app"

# Local secret file paths
$EXA_ENV_PATH    = "C:\Users\danie\OneDrive\HQ Desktop\Master .ENV\exa.env"
$GITHUB_ENV_PATH = "C:\Users\danie\OneDrive\HQ Desktop\Master .ENV\Github.env"
$RXFIT_ENV_PATH  = "C:\Users\danie\OneDrive\HQ Desktop\RxFit Command Center\.env"
$MASTER_ENV_PATH = "C:\Users\danie\OneDrive\HQ Desktop\Master .ENV\.env"

if ($DryRun) { Write-Host "`nDRY RUN MODE - Cloud Run will NOT be modified" -ForegroundColor Blue }

# --- Helper: Parse .env file ---
function Read-EnvFile {
  param([string]$Path)
  $result = @{}
  if (-not (Test-Path $Path)) { Write-Warning "  [SKIP] Not found: $Path"; return $result }
  Get-Content $Path | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line -match '^([^=]+)=(.*)$') {
      $key = $Matches[1].Trim()
      $val = $Matches[2].Trim().Trim('"').Trim("'")
      $result[$key] = $val
    }
  }
  return $result
}

# --- Helper: Null coalesce (PS5.1 compatible) ---
function Coalesce {
  param($a, $b)
  if ($null -ne $a -and $a -ne "") { return $a } else { return $b }
}

# --- Load secrets ---
Write-Host "`nLoading secrets from local .env files..." -ForegroundColor Cyan
$allEnv = @{}
foreach ($h in @((Read-EnvFile $EXA_ENV_PATH), (Read-EnvFile $GITHUB_ENV_PATH), (Read-EnvFile $RXFIT_ENV_PATH), (Read-EnvFile $MASTER_ENV_PATH))) {
  foreach ($kv in $h.GetEnumerator()) { $allEnv[$kv.Key] = $kv.Value }
}

function Get-Secret {
  param([string[]]$Keys, [string]$Name)
  foreach ($k in $Keys) {
    if ($allEnv.ContainsKey($k) -and $allEnv[$k]) {
      Write-Host "  OK: $Name found ($k)" -ForegroundColor Green
      return $allEnv[$k]
    }
  }
  Write-Warning "  WARN: $Name not found - will prompt"
  return $null
}

$EXA_API_KEY         = Get-Secret @("EXA_API_KEY","EXA_KEY","EXAAI_API_KEY") "EXA_API_KEY"
$GITHUB_TOKEN        = Get-Secret @("GITHUB_TOKEN","GH_TOKEN","GITHUB_PAT") "GITHUB_TOKEN"
$STRIPE_API_KEY      = Get-Secret @("STRIPE_API_KEY","STRIPE_SECRET_KEY","STRIPE_KEY") "STRIPE_API_KEY"
$GOOGLE_CHAT_WEBHOOK = Get-Secret @("GOOGLE_CHAT_WEBHOOK_URL","GOOGLE_CHAT_WEBHOOK","CHAT_WEBHOOK","GCHAT_WEBHOOK") "GOOGLE_CHAT_WEBHOOK"

if (-not $EXA_API_KEY)         { $EXA_API_KEY         = Read-Host "Enter EXA_API_KEY" }
if (-not $GITHUB_TOKEN)        { $GITHUB_TOKEN         = Read-Host "Enter GITHUB_TOKEN" }
if (-not $STRIPE_API_KEY)      { Write-Warning "  STRIPE_API_KEY not found - skipping Stripe injection" }
if (-not $GOOGLE_CHAT_WEBHOOK) { $GOOGLE_CHAT_WEBHOOK  = Read-Host "Enter GOOGLE_CHAT_WEBHOOK" }

# --- Auth helper ---
function Connect-Paperclip {
  param([string]$BaseUrl, [string]$Label)
  Write-Host "`nAuthenticating to $Label ($BaseUrl)..." -ForegroundColor Cyan
  try {
    $body = @{ email = $DANNY_EMAIL; password = $DANNY_PASSWORD } | ConvertTo-Json
    $resp = Invoke-WebRequest -Uri "$BaseUrl/api/auth/sign-in/email" -Method POST `
      -ContentType "application/json" -Body $body -SessionVariable session -ErrorAction Stop
    Write-Host "  OK: Authenticated (HTTP $($resp.StatusCode))" -ForegroundColor Green
    return $session
  } catch {
    $errMsg = $_.ToString()
    Write-Error "FAIL: Auth failed for $Label : $errMsg"
    return $null
  }
}

function Invoke-PaperclipAPI {
  param([object]$Session, [string]$BaseUrl, [string]$Path, [string]$Method = "GET", [object]$Body = $null)
  $params = @{
    Uri         = "$BaseUrl$Path"
    Method      = $Method
    WebSession  = $Session
    ErrorAction = "Stop"
  }
  if ($null -ne $Body) {
    $params.ContentType = "application/json"
    $params.Body = ($Body | ConvertTo-Json -Depth 10 -Compress)
  }
  return Invoke-RestMethod @params
}

# --- Step 1: Connect ---
$railwaySession  = Connect-Paperclip -BaseUrl $RAILWAY_URL  -Label "Railway (source)"
$cloudrunSession = Connect-Paperclip -BaseUrl $CLOUDRUN_URL -Label "Cloud Run (target)"

if (-not $railwaySession -or -not $cloudrunSession) { exit 1 }

# --- Step 2: Read Railway companies ---
Write-Host "`nReading companies from Railway..." -ForegroundColor Cyan
$railwayCompanies = @()
try {
  $resp = Invoke-PaperclipAPI -Session $railwaySession -BaseUrl $RAILWAY_URL -Path "/api/companies"
  $railwayCompanies = if ($null -ne $resp.companies) { $resp.companies } else { $resp }
  Write-Host "  Found $($railwayCompanies.Count) companies" -ForegroundColor Green
} catch {
  $errMsg = $_.ToString()
  Write-Error "FAIL: Could not read Railway companies: $errMsg"
  exit 1
}

$companyIdMap = @{}

# --- Step 3: Read existing Cloud Run companies ---
Write-Host "`nReading existing Cloud Run companies..." -ForegroundColor Cyan
$existingCRCompanies = @()
try {
  $resp = Invoke-PaperclipAPI -Session $cloudrunSession -BaseUrl $CLOUDRUN_URL -Path "/api/companies"
  $existingCRCompanies = if ($null -ne $resp.companies) { $resp.companies } else { $resp }
  Write-Host "  Found $($existingCRCompanies.Count) existing on Cloud Run" -ForegroundColor Yellow
} catch {
  Write-Warning "  Could not read Cloud Run companies - will create fresh"
}

# --- Step 4: Create/map companies ---
Write-Host "`nSyncing companies to Cloud Run..." -ForegroundColor Cyan

foreach ($company in $railwayCompanies) {
  $existing = $null
  foreach ($cr in $existingCRCompanies) {
    if ($cr.name -eq $company.name -or $cr.identifier -eq $company.identifier) {
      $existing = $cr
      break
    }
  }

  if ($null -ne $existing) {
    Write-Host "  SKIP: '$($company.name)' already exists on Cloud Run - ID: $($existing.id)" -ForegroundColor Yellow
    $companyIdMap[$company.id] = $existing.id
    continue
  }

  if ($DryRun) {
    Write-Host "  [DRY RUN] Would create: $($company.name) ($($company.identifier))" -ForegroundColor Blue
    $companyIdMap[$company.id] = "dry-run-id-$($company.identifier)"
    continue
  }

  try {
    $desc = if ($null -ne $company.description -and $company.description -ne "") {
      $company.description
    } else {
      "$($company.name) workspace - synced from Railway"
    }
    $createBody = @{
      name        = $company.name
      identifier  = $company.identifier
      description = $desc
    }
    $resp = Invoke-PaperclipAPI -Session $cloudrunSession -BaseUrl $CLOUDRUN_URL -Path "/api/companies" -Method "POST" -Body $createBody
    $newCompany = if ($null -ne $resp.company) { $resp.company } else { $resp }
    $companyIdMap[$company.id] = $newCompany.id
    Write-Host "  OK: Created '$($company.name)' - Cloud Run ID: $($newCompany.id)" -ForegroundColor Green
  } catch {
    Write-Warning "  FAIL: Could not create '$($company.name)': $_"
  }
}

# --- Step 5: Sync agents ---
Write-Host "`nSyncing agents to Cloud Run..." -ForegroundColor Cyan

$totalAgents   = 0
$syncedAgents  = 0
$skippedAgents = 0
$failedAgents  = 0

foreach ($company in $railwayCompanies) {
  $crCompanyId = $companyIdMap[$company.id]
  if (-not $crCompanyId) {
    Write-Warning "  No Cloud Run ID for '$($company.name)' - skipping agents"
    continue
  }

  Write-Host "`n  Company: $($company.name) -> CR: $crCompanyId" -ForegroundColor Magenta

  # Read Railway agents
  try {
    $agentResp = Invoke-PaperclipAPI -Session $railwaySession -BaseUrl $RAILWAY_URL -Path "/api/companies/$($company.id)/agents"
    $railwayAgents = if ($null -ne $agentResp.agents) { $agentResp.agents } else { $agentResp }
    Write-Host "  Reading $($railwayAgents.Count) agents from Railway..." -ForegroundColor Gray
  } catch {
    Write-Warning "  Failed to read agents: $_"
    continue
  }

  # Read existing CR agents
  $existingCRAgents = @()
  try {
    $crAgentResp = Invoke-PaperclipAPI -Session $cloudrunSession -BaseUrl $CLOUDRUN_URL -Path "/api/companies/$crCompanyId/agents"
    $existingCRAgents = if ($null -ne $crAgentResp.agents) { $crAgentResp.agents } else { $crAgentResp }
  } catch { }

  # Sort CEOs first for reportsTo wiring
  $sortedAgents = $railwayAgents | Sort-Object {
    if ($_.name -match 'CEO|Chief Executive') { 0 } else { 1 }
  }

  $agentNameToId = @{}
  foreach ($a in $existingCRAgents) { $agentNameToId[$a.name] = $a.id }

  foreach ($agent in $sortedAgents) {
    $totalAgents++

    # Get full agent details
    try {
      $detail = Invoke-PaperclipAPI -Session $railwaySession -BaseUrl $RAILWAY_URL -Path "/api/companies/$($company.id)/agents/$($agent.id)"
    } catch {
      $errMsg = $_.ToString()
      Write-Warning "    FAIL: Could not fetch '$($agent.name)': $errMsg"
      $failedAgents++
      continue
    }

    # Resolve SOUL field (try multiple possible names)
    $soul = ""
    if ($null -ne $detail.instructions -and $detail.instructions -ne "") { $soul = $detail.instructions }
    elseif ($null -ne $detail.soul -and $detail.soul -ne "") { $soul = $detail.soul }
    elseif ($null -ne $detail.system_prompt -and $detail.system_prompt -ne "") { $soul = $detail.system_prompt }

    # Check if already exists on CR
    $exists = $null
    foreach ($cr in $existingCRAgents) {
      if ($cr.name -eq $agent.name) { $exists = $cr; break }
    }

    if ($null -ne $exists) {
      Write-Host "    SKIP: '$($agent.name)' already exists" -ForegroundColor Yellow
      $agentNameToId[$agent.name] = $exists.id
      $skippedAgents++
      continue
    }

    if ($DryRun) {
      Write-Host "    [DRY RUN] Would create: $($agent.name)" -ForegroundColor Blue
      $syncedAgents++
      continue
    }

    # Resolve reportsTo
    $reportsToId = $null
    if ($null -ne $detail.reportsTo -and $detail.reportsTo -ne "") {
      foreach ($cr in $existingCRAgents) {
        if ($cr.id -eq $detail.reportsTo -and $agentNameToId.ContainsKey($cr.name)) {
          $reportsToId = $agentNameToId[$cr.name]
          break
        }
      }
    }

    # Resolve role field
    $agentRole = "agent"
    if ($null -ne $agent.role -and $agent.role -ne "") { $agentRole = $agent.role }

    # canCreateAgents
    $canCreate = $false
    if ($null -ne $detail.canCreateAgents) { $canCreate = [bool]$detail.canCreateAgents }

    try {
      $createBody = @{
        name            = $agent.name
        role            = $agentRole
        instructions    = $soul
        canCreateAgents = $canCreate
        adapterType     = "gemini_local"
        adapterConfig   = @{
          baseUrl = "https://rxfit-llm-proxy-6r2wdzwkoq-uc.a.run.app"
        }
      }
      if ($null -ne $reportsToId) { $createBody.reportsTo = $reportsToId }

      $resp = Invoke-PaperclipAPI -Session $cloudrunSession -BaseUrl $CLOUDRUN_URL -Path "/api/companies/$crCompanyId/agents" -Method "POST" -Body $createBody
      $newAgent = if ($null -ne $resp.agent) { $resp.agent } else { $resp }
      $agentNameToId[$agent.name] = $newAgent.id
      Write-Host "    OK: Created '$($agent.name)' - $($newAgent.id)" -ForegroundColor Green
      $syncedAgents++
    } catch {
      $errMsg = $_.ToString()
      Write-Warning "    FAIL: '$($agent.name)': $errMsg"
      $failedAgents++
    }

    Start-Sleep -Milliseconds 200
  }
}

# --- Step 6: Inject secrets ---
Write-Host "`nInjecting secrets into Cloud Run companies..." -ForegroundColor Cyan

$secrets = @{
  "EXA_API_KEY"         = $EXA_API_KEY
  "GITHUB_TOKEN"        = $GITHUB_TOKEN
  "STRIPE_API_KEY"      = $STRIPE_API_KEY
  "GOOGLE_CHAT_WEBHOOK" = $GOOGLE_CHAT_WEBHOOK
}

foreach ($company in $railwayCompanies) {
  $crCompanyId = $companyIdMap[$company.id]
  if (-not $crCompanyId) { continue }
  if ($crCompanyId.StartsWith("dry-run")) { continue }

  Write-Host "`n  $($company.name)" -ForegroundColor Magenta
  foreach ($secret in $secrets.GetEnumerator()) {
    if (-not $secret.Value) { Write-Warning "    [SKIP] $($secret.Key) empty"; continue }
    if ($DryRun) { Write-Host "    [DRY RUN] Would inject $($secret.Key)" -ForegroundColor Blue; continue }
    try {
      Invoke-PaperclipAPI -Session $cloudrunSession -BaseUrl $CLOUDRUN_URL `
        -Path "/api/companies/$crCompanyId/secrets" -Method "POST" `
        -Body @{ key = $secret.Key; value = $secret.Value } | Out-Null
      Write-Host "    OK: $($secret.Key) injected" -ForegroundColor Green
    } catch {
      $errCode = $_.Exception.Response.StatusCode.value__
      if ($errCode -eq 409) {
        Write-Host "    SKIP: $($secret.Key) already exists" -ForegroundColor Yellow
      } else {
        $errMsg = $_.ToString()
        Write-Warning "    FAIL: $($secret.Key) - $errMsg"
      }
    }
  }
}

# --- Step 7: Heartbeat routines ---
Write-Host "`nRecreating heartbeat routines on Cloud Run..." -ForegroundColor Cyan

$CADENCES = @{ CEO = 604800; CMO = 86400; CTO = 86400; CFO = 604800; COO = 604800 }
$PROMPTS = @{
  CEO = "Conduct your weekly executive review. Check all C-Suite agent activity from the past week. Identify critical issues, flag blockers, and set priorities. Use exa_search for market context and industry news."
  CMO = "Conduct your daily marketing review. Audit all marketing KPIs, campaign performance, and SEO metrics. Identify the top 3 marketing actions needed today. Use exa_search for competitor intelligence."
  CTO = "Conduct your daily technical review. Check system health, audit open GitHub issues/PRs, review QA and DevOps status. Flag any technical debt or blockers. Use exa_search for technology updates."
  CFO = "Conduct your weekly financial review. Audit Stripe data, track revenue vs projections, flag anomalies over 15% variance. Escalate critical issues to the CEO immediately."
  COO = "Conduct your weekly operations review. Check all operational workflows, team communications, and process efficiency. Coordinate with C-Suite to resolve bottlenecks."
}

foreach ($company in $railwayCompanies) {
  $crCompanyId = $companyIdMap[$company.id]
  if (-not $crCompanyId) { continue }
  if ($crCompanyId.StartsWith("dry-run")) { continue }

  Write-Host "`n  $($company.name)" -ForegroundColor Magenta

  $crAgents = @()
  try {
    $resp = Invoke-PaperclipAPI -Session $cloudrunSession -BaseUrl $CLOUDRUN_URL -Path "/api/companies/$crCompanyId/agents"
    $crAgents = if ($null -ne $resp.agents) { $resp.agents } else { $resp }
  } catch {
    $errMsg = $_.ToString()
    Write-Warning "  Could not fetch CR agents: $errMsg"
    continue
  }

  foreach ($role in $CADENCES.Keys) {
    $agent = $null
    foreach ($a in $crAgents) {
      if ($a.name -match $role) { $agent = $a; break }
    }
    if ($null -eq $agent) { continue }

    if ($DryRun) {
      Write-Host "  [DRY RUN] Would create $role heartbeat for $($company.name)" -ForegroundColor Blue
      continue
    }

    try {
      Invoke-PaperclipAPI -Session $cloudrunSession -BaseUrl $CLOUDRUN_URL `
        -Path "/api/companies/$crCompanyId/routines" -Method "POST" -Body @{
          agentId = $agent.id
          type    = "heartbeat"
          cadence = $CADENCES[$role]
          prompt  = $PROMPTS[$role]
          enabled = $true
          name    = "$($agent.name) Heartbeat"
        } | Out-Null
      $label = if ($CADENCES[$role] -eq 86400) { "Daily" } else { "Weekly" }
      Write-Host "  OK: $role $label heartbeat created" -ForegroundColor Green
    } catch {
      $errCode = $_.Exception.Response.StatusCode.value__
      if ($errCode -eq 409) {
        Write-Host "  SKIP: $role heartbeat already exists" -ForegroundColor Yellow
      } else {
        $errMsg = $_.ToString()
        Write-Warning "  FAIL: $role heartbeat - $errMsg"
      }
    }
  }
}

# --- Summary ---
Write-Host "`n================================================" -ForegroundColor DarkGray
Write-Host "  Sync Summary" -ForegroundColor Cyan
Write-Host "  Companies mapped: $($companyIdMap.Count)"
Write-Host "  Agents total:     $totalAgents"
Write-Host "  Agents synced:    $syncedAgents"  -ForegroundColor Green
Write-Host "  Agents skipped:   $skippedAgents" -ForegroundColor Yellow
$failColor = if ($failedAgents -gt 0) { "Red" } else { "Gray" }
Write-Host "  Agents failed:    $failedAgents"  -ForegroundColor $failColor
Write-Host "================================================" -ForegroundColor DarkGray

if ($DryRun) {
  Write-Host "`nDry run complete. Re-run without -DryRun to apply." -ForegroundColor Blue
} else {
  Write-Host "`nSync complete!" -ForegroundColor Green
  Write-Host "`nNEXT STEPS:" -ForegroundColor Cyan
  Write-Host "  1. Login to Cloud Run Paperclip -> Settings -> API Keys -> New Key"
  Write-Host "     URL: $CLOUDRUN_URL"
  Write-Host "  2. Set on Railway Hub service:"
  Write-Host "     PAPERCLIP_BASE_URL = $CLOUDRUN_URL"
  Write-Host "     PAPERCLIP_API_KEY  = <your new key>"
  Write-Host "  3. Redeploy Hub on Railway"
  Write-Host "  4. Verify execution feed shows Cloud Run data"
}
