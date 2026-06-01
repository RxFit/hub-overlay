<#
  bootstrap-roles-sheet.ps1
  ──────────────────────────────────────────────────────────────────────────────
  One-time setup: writes the header row to the Hub Roles Google Sheet.
  Safe to run multiple times — only writes if headers are missing.

  USAGE:
    .\bootstrap-roles-sheet.ps1 -SheetId "1aYOG1Ae8QzIQiWtaoPdxBnU1uq5WXssZP58LlPotNjo"

  PREREQUISITES:
    - Requires a Google OAuth access token from Danny's account
    - The sheet must already be created and shared with Danny's Google account
  ──────────────────────────────────────────────────────────────────────────────
#>

param(
  [string]$SheetId = "1aYOG1Ae8QzIQiWtaoPdxBnU1uq5WXssZP58LlPotNjo",
  [string]$AccessToken = ""
)

$SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets"
$SHEET_NAME  = "Roles"
$HEADERS     = @("email", "role", "assignedProjects", "assignedAt", "assignedBy")

# ── Get Access Token via OAuth device flow ────────────────────────────────────
# If no token provided, guide the user through getting one
if (-not $AccessToken) {
  Write-Host "`n🔑 No access token provided." -ForegroundColor Cyan
  Write-Host "  Option 1: Sign into the Hub at hub.casatrejo.com as Danny, then run:" -ForegroundColor White
  Write-Host "            The Hub will initialize the sheet automatically on first admin page load." -ForegroundColor Gray
  Write-Host ""
  Write-Host "  Option 2: Paste your Google OAuth token below." -ForegroundColor White
  Write-Host "            Get it from: https://developers.google.com/oauthplayground" -ForegroundColor Gray
  Write-Host "            → Authorize: https://www.googleapis.com/auth/spreadsheets" -ForegroundColor Gray
  Write-Host ""
  $AccessToken = Read-Host "  Paste your Google OAuth access_token (or press Enter to skip)"
}

if (-not $AccessToken) {
  Write-Host "`n⚠️  No access token provided. The Hub will auto-initialize the sheet on first admin access." -ForegroundColor Yellow
  Write-Host "   Just sign in as Danny, navigate to /admin, and the sheet headers will be written automatically." -ForegroundColor Gray
  exit 0
}

# ── Check existing headers ────────────────────────────────────────────────────
Write-Host "`n🔍 Checking current sheet headers..." -ForegroundColor Cyan
$range = [System.Uri]::EscapeDataString("${SHEET_NAME}!A1:E1")

try {
  $resp = Invoke-RestMethod `
    -Uri "$SHEETS_BASE/$SheetId/values/$range" `
    -Headers @{ Authorization = "Bearer $AccessToken" } `
    -ErrorAction Stop

  $currentHeaders = $resp.values?[0]
  if ($currentHeaders -and $currentHeaders[0].ToLower() -eq "email") {
    Write-Host "  ✅ Headers already present: $($currentHeaders -join ' | ')" -ForegroundColor Green
    Write-Host "  Sheet is ready — no action needed." -ForegroundColor Gray
    exit 0
  }
} catch {
  Write-Warning "  Could not read current headers — will write fresh"
}

# ── Write headers ─────────────────────────────────────────────────────────────
Write-Host "  Writing header row..." -ForegroundColor Gray
$writeRange = [System.Uri]::EscapeDataString("${SHEET_NAME}!A1:E1")

try {
  Invoke-RestMethod `
    -Uri "$SHEETS_BASE/$SheetId/values/$writeRange?valueInputOption=RAW" `
    -Method PUT `
    -Headers @{
      Authorization  = "Bearer $AccessToken"
      "Content-Type" = "application/json"
    } `
    -Body (@{
      range  = "${SHEET_NAME}!A1:E1"
      values = @(,$HEADERS)
    } | ConvertTo-Json -Depth 5) `
    -ErrorAction Stop | Out-Null

  Write-Host "  ✅ Headers written: $($HEADERS -join ' | ')" -ForegroundColor Green
} catch {
  Write-Error "  ❌ Failed to write headers: $_"
  exit 1
}

Write-Host "`n✅ Hub Roles Sheet initialized!" -ForegroundColor Green
Write-Host "   Sheet URL: https://docs.google.com/spreadsheets/d/$SheetId/edit" -ForegroundColor Gray
Write-Host "`n📋 Set this on Railway Hub service:" -ForegroundColor Cyan
Write-Host "   HUB_ROLES_SHEET_ID = $SheetId" -ForegroundColor White
