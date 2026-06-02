<#
  restore-heartbeats.ps1
  ──────────────────────────────────────────────────────────────────────────────
  Recreates all heartbeat routines for C-Suite agents across all 3 Paperclip
  companies (RxFit, NotebookRx, FridgeSnap) after the migration DB wipe.

  Cadences (from .paperclip.yaml):
    CEO  -> Weekly (604800s)
    CMO  -> Daily  (86400s)
    CTO  -> Daily  (86400s)
    CFO  -> Weekly (604800s)
    COO  -> Weekly (604800s)

  USAGE:
    .\restore-heartbeats.ps1

  NOTE: Run inject-company-secrets.ps1 first to ensure EXA_API_KEY is set
  ──────────────────────────────────────────────────────────────────────────────
#>

$PAPERCLIP_URL  = "https://rxfit-paperclip-11747747730.us-central1.run.app"
$DANNY_EMAIL    = "Danny@rxfitatx.com"
$DANNY_PASSWORD = "Paperclip2026!"

# ── Agent UUIDs by Company (from migration payload) ───────────────────────────

$COMPANIES = @{
  "RxFit Enterprise" = @{
    Id     = "829b2493-97ed-4cb9-8775-ff8298dcf650"
    Agents = @{
      CEO = "82984f59-0000-0000-0000-000000000000"  # PARTIAL - script fetches real IDs
      CMO = "360e4642-0000-0000-0000-000000000000"
      CTO = "91873c35-0000-0000-0000-000000000000"
      CFO = "4f4548b7-0000-0000-0000-000000000000"
      COO = "002a8e1c-0000-0000-0000-000000000000"
    }
  }
  "NotebookRx" = @{
    Id     = "05ca9da4-5ea1-4dc3-8a17-be9faa821dfb"
    Agents = @{
      CEO = "ea5c66ff-0000-0000-0000-000000000000"
      CMO = "517b01f3-0000-0000-0000-000000000000"
      CTO = "089b1965-0000-0000-0000-000000000000"
      CFO = "fb6211da-0000-0000-0000-000000000000"
      COO = "ce37b65a-0000-0000-0000-000000000000"
    }
  }
  "FridgeSnap" = @{
    Id     = "fe281b7a-23c7-4b10-883c-997eebc841dc"
    Agents = @{
      CEO = "81f22332-0000-0000-0000-000000000000"
      CMO = "a8b620e3-0000-0000-0000-000000000000"
      CTO = "d24f9384-0000-0000-0000-000000000000"
      CFO = "c7936618-0000-0000-0000-000000000000"
      COO = $null   # FridgeSnap has no COO
    }
  }
}

# Heartbeat cadences in seconds
$CADENCES = @{
  CEO = 604800  # weekly
  CMO = 86400   # daily
  CTO = 86400   # daily
  CFO = 604800  # weekly
  COO = 604800  # weekly
}

# Heartbeat prompts - what each agent runs autonomously
$HEARTBEAT_PROMPTS = @{
  CEO = "Conduct your weekly executive review. Check all C-Suite agent activity from the past week. Identify any critical issues, flag blockers, and set priorities for the coming week. Use exa_search if you need market context or news about our industry."
  CMO = "Conduct your daily marketing review. Audit all marketing KPIs, check campaign performance, review SEO/AEO/GEO metrics, and identify the top 3 marketing actions needed today. Use exa_search for competitor intelligence and industry trends."
  CTO = "Conduct your daily technical review. Check system health, audit any open GitHub issues or PRs, review QA status, assess DevOps pipeline state, and flag any technical debt or blockers. Use exa_search for relevant technology updates if needed."
  CFO = "Conduct your weekly financial review. Audit all Stripe data, track revenue vs. projections, flag any billing anomalies, and prepare a financial summary. Escalate any variances >15% to the CEO immediately."
  COO = "Conduct your weekly operations review. Check all operational workflows, team communications, and process efficiency. Identify any bottlenecks and coordinate with relevant C-Suite agents to resolve them."
}

# ── Authenticate ──────────────────────────────────────────────────────────────
Write-Host "`n🔐 Authenticating to Paperclip..." -ForegroundColor Cyan

try {
  $authBody = @{ email = $DANNY_EMAIL; password = $DANNY_PASSWORD } | ConvertTo-Json
  $authResp = Invoke-WebRequest `
    -Uri "$PAPERCLIP_URL/api/auth/sign-in/email" `
    -Method POST `
    -ContentType "application/json" `
    -Body $authBody `
    -SessionVariable paperclipSession `
    -ErrorAction Stop
  Write-Host "  [OK] Authenticated (HTTP $($authResp.StatusCode))" -ForegroundColor Green
} catch {
  Write-Error "[ERR] Authentication failed: $_"
  exit 1
}

# ── Fetch real agent IDs from API ─────────────────────────────────────────────
Write-Host "`n📋 Fetching agent IDs from Paperclip API..." -ForegroundColor Cyan

function Get-CompanyAgents {
  param([string]$CompanyId)
  try {
    $resp = Invoke-RestMethod `
      -Uri "$PAPERCLIP_URL/api/companies/$CompanyId/agents" `
      -Method GET `
      -WebSession $paperclipSession `
      -ErrorAction Stop
    if ($null -ne $resp.agents) { return $resp.agents } else { return $resp }
  } catch {
    Write-Warning "  Could not fetch agents for company $($CompanyId): $_"
    return @()
  }
}

function Find-AgentByRole {
  param([array]$Agents, [string]$RoleKeyword)
  # Match by name containing the role keyword (CEO, CMO, etc.)
  return $Agents | Where-Object { $_.name -match $RoleKeyword } | Select-Object -First 1
}

# ── Create Heartbeat Routine ──────────────────────────────────────────────────
function New-HeartbeatRoutine {
  param(
    [string]$CompanyId,
    [string]$AgentId,
    [string]$AgentName,
    [string]$Role,
    [string]$CompanyName
  )
  if (-not $AgentId) {
    Write-Warning "  [SKIP] No agent ID for $Role in $CompanyName"
    return
  }

  $cadence = $CADENCES[$Role]
  $prompt  = $HEARTBEAT_PROMPTS[$Role]

  $bodyObj = @{
    agentId     = $AgentId
    type        = "heartbeat"
    cadence     = $cadence
    prompt      = $prompt
    enabled     = $true
    name        = "$AgentName Heartbeat"
    description = "Automated $Role review - $(if ($cadence -eq 86400) { 'Daily' } else { 'Weekly' }) cadence"
  }
  $body = $bodyObj | ConvertTo-Json -Depth 5

  try {
    $resp = Invoke-RestMethod `
      -Uri "$PAPERCLIP_URL/api/companies/$CompanyId/routines" `
      -Method POST `
      -ContentType "application/json" `
      -Body $body `
      -WebSession $paperclipSession `
      -ErrorAction Stop

    if ($cadence -eq 86400) { $cadenceLabel = "Daily" } else { $cadenceLabel = "Weekly" }
    Write-Host "  [OK] [$CompanyName] $Role ($cadenceLabel heartbeat) -> routine ID: $routineId" -ForegroundColor Green
  } catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    if ($statusCode -eq 409) {
      Write-Host "  [SKIP]  [$CompanyName] $Role heartbeat already exists" -ForegroundColor Yellow
    } else {
      Write-Warning "  [ERR] [$CompanyName] $Role heartbeat failed (HTTP $statusCode): $_"
    }
  }
}

# ── Main Loop ─────────────────────────────────────────────────────────────────
Write-Host "`n* Restoring heartbeat routines..." -ForegroundColor Cyan

foreach ($company in $COMPANIES.GetEnumerator()) {
  $companyName = $company.Key
  $companyId   = $company.Value.Id
  
  Write-Host "`n  * $companyName ($companyId)" -ForegroundColor Magenta

  # Fetch live agents to get real IDs
  $liveAgents = Get-CompanyAgents -CompanyId $companyId

  if ($liveAgents.Count -eq 0) {
    Write-Warning "  No agents found for $companyName - skipping"
    continue
  }

  Write-Host "  Found $($liveAgents.Count) agents" -ForegroundColor Gray

  # Map roles to live agent IDs
  foreach ($role in @("CEO", "CMO", "CTO", "CFO", "COO")) {
    $agent = Find-AgentByRole -Agents $liveAgents -RoleKeyword $role
    if (-not $agent) {
      Write-Host "  [SKIP] No $role agent found in $companyName" -ForegroundColor Gray
      continue
    }
    New-HeartbeatRoutine `
      -CompanyId   $companyId `
      -AgentId     $agent.id `
      -AgentName   $agent.name `
      -Role        $role `
      -CompanyName $companyName
  }
}

Write-Host "`n[OK] Heartbeat restoration complete!" -ForegroundColor Green
Write-Host "   Verify in Paperclip UI: $PAPERCLIP_URL -> Company -> Routines" -ForegroundColor Gray
Write-Host "`n! To trigger a manual test heartbeat for the RxFit CEO, run:" -ForegroundColor Cyan
Write-Host "   POST $($PAPERCLIP_URL)/api/companies/829b2493.../routines/{routineId}/trigger" -ForegroundColor Gray
