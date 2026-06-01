<#
  patch-agent-souls.ps1
  ──────────────────────────────────────────────────────────────────────────────
  Appends a standardized Exa.ai Web Research Protocol block to every agent's
  SOUL instructions across all 3 Paperclip companies (29 agents total).

  Architecture: Instance-level MCP (backbone) + per-agent SOUL instructions
  (explicit invocation rules). Both layers together = most reliable Exa usage.

  USAGE:
    .\patch-agent-souls.ps1

  Dry-run mode (no changes, just preview):
    .\patch-agent-souls.ps1 -DryRun

  Force re-patch even if Exa block already exists:
    .\patch-agent-souls.ps1 -Force
  ──────────────────────────────────────────────────────────────────────────────
#>

param(
  [switch]$DryRun,
  [switch]$Force
)

$PAPERCLIP_URL  = "https://rxfit-paperclip-11747747730.us-central1.run.app"
$DANNY_EMAIL    = "Danny@rxfitatx.com"
$DANNY_PASSWORD = "Paperclip2026!"

$COMPANY_IDS = @(
  "829b2493-97ed-4cb9-8775-ff8298dcf650",  # RxFit Enterprise
  "05ca9da4-5ea1-4dc3-8a17-be9faa821dfb",  # NotebookRx
  "fe281b7a-23c7-4b10-883c-997eebc841dc"   # FridgeSnap
)

# ── The Exa block appended to every agent SOUL ────────────────────────────────
# This sentinel string is used to detect if the block already exists.
$EXA_SENTINEL = "## Web Research Protocol (Exa MCP)"

$EXA_BLOCK = @"


---

## Web Research Protocol (Exa MCP)

You have access to real-time web search via the **exa_search** MCP tool, which is registered at the Paperclip instance level.

### When to use Exa:
- Any question requiring **current market data, pricing, or industry news**
- **Competitor research** — features, positioning, pricing changes
- **Trend analysis** — what's happening in your domain right now
- **Validation** — confirming statistics or claims before including them in reports
- **Content research** — sourcing for SEO/marketing agents

### How to use Exa:
1. Call `exa_search` with a specific, targeted query (not vague)
2. Always cite your sources in the output — include the URL and publication date
3. If a search returns no useful results, try rephrasing with different keywords
4. For time-sensitive data (prices, stock, rankings), always note the date retrieved

### When NOT to use Exa:
- Internal company data you already have in context
- Decisions that don't require external validation
- Simple math, logic, or formatting tasks

### Reporting standard:
When you use Exa in a heartbeat or task output, include a **Sources Used** section at the bottom listing each URL cited.
"@

# ── Authenticate ──────────────────────────────────────────────────────────────
Write-Host "`n🔐 Authenticating to Paperclip..." -ForegroundColor Cyan
if ($DryRun) { Write-Host "  🔵 DRY RUN MODE — no changes will be made" -ForegroundColor Blue }

try {
  $authBody = @{ email = $DANNY_EMAIL; password = $DANNY_PASSWORD } | ConvertTo-Json
  $authResp = Invoke-WebRequest `
    -Uri "$PAPERCLIP_URL/api/auth/sign-in/email" `
    -Method POST `
    -ContentType "application/json" `
    -Body $authBody `
    -SessionVariable paperclipSession `
    -ErrorAction Stop
  Write-Host "  ✅ Authenticated" -ForegroundColor Green
} catch {
  Write-Error "❌ Authentication failed: $_"
  exit 1
}

# ── Counters ──────────────────────────────────────────────────────────────────
$totalAgents    = 0
$patchedAgents  = 0
$skippedAgents  = 0
$failedAgents   = 0

# ── Process each company ──────────────────────────────────────────────────────
foreach ($companyId in $COMPANY_IDS) {
  Write-Host "`n  📦 Company: $companyId" -ForegroundColor Magenta

  # Fetch agents
  try {
    $agentsResp = Invoke-RestMethod `
      -Uri "$PAPERCLIP_URL/api/companies/$companyId/agents" `
      -Method GET `
      -WebSession $paperclipSession `
      -ErrorAction Stop
    $agents = $agentsResp.agents ?? $agentsResp
  } catch {
    Write-Warning "  ❌ Failed to fetch agents: $_"
    continue
  }

  Write-Host "  Found $($agents.Count) agents" -ForegroundColor Gray

  foreach ($agent in $agents) {
    $totalAgents++
    $agentId   = $agent.id
    $agentName = $agent.name

    # Get full agent details (includes instructions/soul)
    try {
      $agentDetail = Invoke-RestMethod `
        -Uri "$PAPERCLIP_URL/api/companies/$companyId/agents/$agentId" `
        -Method GET `
        -WebSession $paperclipSession `
        -ErrorAction Stop
    } catch {
      Write-Warning "  ❌ Could not fetch details for $agentName ($agentId): $_"
      $failedAgents++
      continue
    }

    # Find the soul/instructions field (try multiple possible field names)
    $currentSoul = $agentDetail.instructions ?? $agentDetail.soul ?? $agentDetail.system_prompt ?? ""

    # Check if Exa block already exists
    if (-not $Force -and $currentSoul -match [regex]::Escape($EXA_SENTINEL)) {
      Write-Host "  ⏭️  [$agentName] Exa block already present — skipping (use -Force to overwrite)" -ForegroundColor Gray
      $skippedAgents++
      continue
    }

    $newSoul = $currentSoul + $EXA_BLOCK

    if ($DryRun) {
      Write-Host "  🔵 [DRY RUN] Would patch: $agentName ($agentId)" -ForegroundColor Blue
      $patchedAgents++
      continue
    }

    # PATCH the agent — try multiple field names the API might accept
    $patchBody = @{
      instructions  = $newSoul
      soul          = $newSoul
      system_prompt = $newSoul
    } | ConvertTo-Json -Depth 5

    $patched = $false
    $patchEndpoints = @(
      "$PAPERCLIP_URL/api/companies/$companyId/agents/$agentId",
      "$PAPERCLIP_URL/api/agents/$agentId"
    )

    foreach ($endpoint in $patchEndpoints) {
      try {
        Invoke-RestMethod `
          -Uri $endpoint `
          -Method PATCH `
          -ContentType "application/json" `
          -Body $patchBody `
          -WebSession $paperclipSession `
          -ErrorAction Stop | Out-Null
        Write-Host "  ✅ [$agentName] Exa block appended" -ForegroundColor Green
        $patchedAgents++
        $patched = $true
        break
      } catch {
        # Try next endpoint
      }
    }

    if (-not $patched) {
      Write-Warning "  ❌ [$agentName] All PATCH attempts failed"
      $failedAgents++
    }
  }
}

# ── Summary ───────────────────────────────────────────────────────────────────
Write-Host "`n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
Write-Host "  📊 SOUL Patch Summary" -ForegroundColor Cyan
Write-Host "  Total agents:   $totalAgents"
Write-Host "  Patched:        $patchedAgents" -ForegroundColor Green
Write-Host "  Skipped:        $skippedAgents" -ForegroundColor Yellow
Write-Host "  Failed:         $failedAgents" -ForegroundColor $(if ($failedAgents -gt 0) { "Red" } else { "Gray" })
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray

if ($DryRun) {
  Write-Host "`n🔵 Dry run complete. Re-run without -DryRun to apply changes." -ForegroundColor Blue
} elseif ($failedAgents -eq 0) {
  Write-Host "`n✅ All agents patched successfully!" -ForegroundColor Green
  Write-Host "   Verify by fetching any agent and checking its instructions end with the Exa block." -ForegroundColor Gray
} else {
  Write-Host "`n⚠️  Some agents failed. Check Paperclip API field names for PATCH." -ForegroundColor Yellow
  Write-Host "   You may need to update the script's field mapping for your Paperclip version." -ForegroundColor Gray
}
