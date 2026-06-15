<#
  inject-company-secrets.ps1
  ──────────────────────────────────────────────────────────────────────────────
  Injects API secrets into all 3 Paperclip companies (RxFit, NotebookRx, FridgeSnap)
  via the Paperclip Cloud Run API.

  USAGE:
    .\inject-company-secrets.ps1

  PREREQUISITES:
    - Set the env vars below OR the script will prompt for them
    - Paperclip Cloud Run must be reachable
  ──────────────────────────────────────────────────────────────────────────────
#>

# ── Configuration ─────────────────────────────────────────────────────────────

$PAPERCLIP_URL  = "https://rxfit-paperclip-11747747730.us-central1.run.app"
$DANNY_EMAIL    = "Danny@rxfitatx.com"
# SECURITY: plaintext password removed 2026-06-12 (was committed to the repo — change it).
$DANNY_PASSWORD = $env:PAPERCLIP_BOARD_PASSWORD
if (-not $DANNY_PASSWORD) { Write-Error "Set PAPERCLIP_BOARD_PASSWORD env var"; exit 1 }

# Company IDs (restored from migration — do not change)
$COMPANIES = @{
  "RxFit Enterprise" = "829b2493-97ed-4cb9-8775-ff8298dcf650"
  "NotebookRx"       = "05ca9da4-5ea1-4dc3-8a17-be9faa821dfb"
  "FridgeSnap"       = "fe281b7a-23c7-4b10-883c-997eebc841dc"
}

# ── Secret Sources ────────────────────────────────────────────────────────────
# Edit these paths to point at your local .env files.
# The script will read keys from them automatically.

$EXA_ENV_PATH    = "C:\Users\danie\OneDrive\HQ Desktop\Master .ENV\exa.env"
$RXFIT_ENV_PATH  = "C:\Users\danie\OneDrive\HQ Desktop\RxFit Command Center\.env"
$MASTER_ENV_PATH = "C:\Users\danie\OneDrive\HQ Desktop\Master .ENV\.env"

# ── Helper: Parse .env file into hashtable ────────────────────────────────────
function Read-EnvFile {
  param([string]$Path)
  $result = @{}
  if (-not (Test-Path $Path)) {
    Write-Warning "  [SKIP] File not found: $Path"
    return $result
  }
  Get-Content $Path | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line -match '^([^=]+)=(.*)$') {
      $key   = $Matches[1].Trim()
      $value = $Matches[2].Trim().Trim('"').Trim("'")
      $result[$key] = $value
    }
  }
  return $result
}

# ── Load secrets from local env files ────────────────────────────────────────
Write-Host "`n📂 Loading secrets from local .env files..." -ForegroundColor Cyan

$exaEnv    = Read-EnvFile $EXA_ENV_PATH
$rxfitEnv  = Read-EnvFile $RXFIT_ENV_PATH
$masterEnv = Read-EnvFile $MASTER_ENV_PATH

# Merge all envs (master > rxfit > exa precedence)
$allEnv = @{}
foreach ($h in @($exaEnv, $rxfitEnv, $masterEnv)) {
  foreach ($kv in $h.GetEnumerator()) { $allEnv[$kv.Key] = $kv.Value }
}

# Resolve each secret key (try multiple possible names)
function Get-Secret {
  param([string[]]$Keys, [string]$FriendlyName)
  foreach ($k in $Keys) {
    if ($allEnv.ContainsKey($k) -and $allEnv[$k]) {
      Write-Host "  ✅ Found $FriendlyName ($k)" -ForegroundColor Green
      return $allEnv[$k]
    }
  }
  Write-Warning "  ⚠️  $FriendlyName not found in any env file — will prompt"
  return $null
}

$EXA_API_KEY         = Get-Secret @("EXA_API_KEY", "EXA_KEY", "EXAAI_API_KEY") "EXA_API_KEY"
$GITHUB_TOKEN        = Get-Secret @("GITHUB_TOKEN", "GH_TOKEN", "GITHUB_PAT") "GITHUB_TOKEN"
$STRIPE_API_KEY      = Get-Secret @("STRIPE_API_KEY", "STRIPE_SECRET_KEY", "STRIPE_KEY") "STRIPE_API_KEY"
$GOOGLE_CHAT_WEBHOOK = Get-Secret @("GOOGLE_CHAT_WEBHOOK", "CHAT_WEBHOOK", "GCHAT_WEBHOOK") "GOOGLE_CHAT_WEBHOOK"

# Prompt for any missing secrets
if (-not $EXA_API_KEY)         { $EXA_API_KEY         = Read-Host "Enter EXA_API_KEY" }
if (-not $GITHUB_TOKEN)        { $GITHUB_TOKEN         = Read-Host "Enter GITHUB_TOKEN" }
if (-not $STRIPE_API_KEY)      { $STRIPE_API_KEY       = Read-Host "Enter STRIPE_API_KEY" }
if (-not $GOOGLE_CHAT_WEBHOOK) { $GOOGLE_CHAT_WEBHOOK  = Read-Host "Enter GOOGLE_CHAT_WEBHOOK URL" }

# ── Authenticate to Paperclip ─────────────────────────────────────────────────
Write-Host "`n🔐 Authenticating to Paperclip as $DANNY_EMAIL..." -ForegroundColor Cyan

try {
  $authBody = @{ email = $DANNY_EMAIL; password = $DANNY_PASSWORD } | ConvertTo-Json
  $authResp = Invoke-WebRequest `
    -Uri "$PAPERCLIP_URL/api/auth/sign-in/email" `
    -Method POST `
    -ContentType "application/json" `
    -Body $authBody `
    -SessionVariable paperclipSession `
    -ErrorAction Stop
  Write-Host "  ✅ Authenticated (HTTP $($authResp.StatusCode))" -ForegroundColor Green
} catch {
  Write-Error "❌ Authentication failed: $_"
  exit 1
}

# ── Helper: Inject secret into a company ─────────────────────────────────────
function Set-CompanySecret {
  param(
    [string]$CompanyName,
    [string]$CompanyId,
    [string]$SecretKey,
    [string]$SecretValue
  )
  if (-not $SecretValue) {
    Write-Warning "  [SKIP] $SecretKey is empty — skipping for $CompanyName"
    return
  }
  try {
    $body = @{ key = $SecretKey; value = $SecretValue } | ConvertTo-Json
    $resp = Invoke-RestMethod `
      -Uri "$PAPERCLIP_URL/api/companies/$CompanyId/secrets" `
      -Method POST `
      -ContentType "application/json" `
      -Body $body `
      -WebSession $paperclipSession `
      -ErrorAction Stop
    Write-Host "  ✅ [$CompanyName] $SecretKey injected" -ForegroundColor Green
  } catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    # 409 = already exists, treat as success
    if ($statusCode -eq 409) {
      Write-Host "  ♻️  [$CompanyName] $SecretKey already exists (upserted)" -ForegroundColor Yellow
      # Try PATCH/PUT to update existing
      try {
        $body = @{ key = $SecretKey; value = $SecretValue } | ConvertTo-Json
        Invoke-RestMethod `
          -Uri "$PAPERCLIP_URL/api/companies/$CompanyId/secrets/$SecretKey" `
          -Method PUT `
          -ContentType "application/json" `
          -Body $body `
          -WebSession $paperclipSession `
          -ErrorAction Stop | Out-Null
        Write-Host "    → Updated via PUT" -ForegroundColor Yellow
      } catch {
        Write-Warning "    → PUT also failed, secret may need manual update"
      }
    } else {
      Write-Warning "  ❌ [$CompanyName] $SecretKey failed (HTTP $statusCode): $_"
    }
  }
}

# ── Inject secrets into all companies ────────────────────────────────────────
Write-Host "`n🔑 Injecting secrets into all 3 companies..." -ForegroundColor Cyan

$secrets = @{
  "EXA_API_KEY"          = $EXA_API_KEY
  "GITHUB_TOKEN"         = $GITHUB_TOKEN
  "STRIPE_API_KEY"       = $STRIPE_API_KEY
  "GOOGLE_CHAT_WEBHOOK"  = $GOOGLE_CHAT_WEBHOOK
}

foreach ($company in $COMPANIES.GetEnumerator()) {
  Write-Host "`n  📦 Company: $($company.Key)" -ForegroundColor Magenta
  foreach ($secret in $secrets.GetEnumerator()) {
    Set-CompanySecret `
      -CompanyName $company.Key `
      -CompanyId   $company.Value `
      -SecretKey   $secret.Key `
      -SecretValue $secret.Value
  }
}

Write-Host "`n✅ Done! All secrets injected." -ForegroundColor Green
Write-Host "   Verify in Paperclip UI: $PAPERCLIP_URL → Company Settings → Secrets" -ForegroundColor Gray
