<#
.SYNOPSIS
    Updates all orchestration configs to point to the new Paperclip production URL.
    
.PARAMETER NewUrl
    The new Paperclip base URL (e.g., https://api.paperclip.casatrejo.com)
    
.NOTES
    TEMPORARY: Updates local orchestration files only.
    Author: Antigravity (automated)
    Date: 2026-05-28
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$NewUrl
)

$ErrorActionPreference = "Stop"
$workspace = "C:\Users\danie\Documents\antigravity\vibrant-chandrasekhar"

# ── Update orchestration/.env ──
$envFile = Join-Path $workspace "orchestration\.env"
if (Test-Path $envFile) {
    Write-Host "Updating $envFile..." -ForegroundColor Cyan
    $content = Get-Content $envFile -Raw
    
    # Replace localhost/127.0.0.1 Paperclip URLs
    $content = $content -replace 'PAPERCLIP_BASE_URL=http://127\.0\.0\.1:3100', "PAPERCLIP_BASE_URL=$NewUrl"
    $content = $content -replace 'PAPERCLIP_BASE_URL=http://localhost:3100', "PAPERCLIP_BASE_URL=$NewUrl"
    
    Set-Content $envFile -Value $content
    Write-Host "  ✅ Updated PAPERCLIP_BASE_URL" -ForegroundColor Green
} else {
    Write-Warning "orchestration/.env not found at $envFile"
}

# ── Update any AGENTS.md references ──
$agentFiles = Get-ChildItem $workspace -Filter "AGENTS.md" -Recurse -ErrorAction SilentlyContinue
foreach ($f in $agentFiles) {
    Write-Host "Checking $($f.FullName)..." -ForegroundColor Cyan
    $content = Get-Content $f.FullName -Raw
    if ($content -match '127\.0\.0\.1:3100|localhost:3100') {
        $content = $content -replace 'http://127\.0\.0\.1:3100', $NewUrl
        $content = $content -replace 'http://localhost:3100', $NewUrl
        Set-Content $f.FullName -Value $content
        Write-Host "  ✅ Updated Paperclip URL references" -ForegroundColor Green
    } else {
        Write-Host "  ⏭ No localhost references found" -ForegroundColor Gray
    }
}

# ── Update hub/.env.local if it exists ──
$hubEnv = Join-Path $workspace "hub\.env.local"
if (Test-Path $hubEnv) {
    Write-Host "Updating $hubEnv..." -ForegroundColor Cyan
    $content = Get-Content $hubEnv -Raw
    $content = $content -replace 'PAPERCLIP_BASE_URL=http://127\.0\.0\.1:3100', "PAPERCLIP_BASE_URL=$NewUrl"
    $content = $content -replace 'NEXT_PUBLIC_PAPERCLIP_URL=http://127\.0\.0\.1:3100', "NEXT_PUBLIC_PAPERCLIP_URL=$NewUrl"
    Set-Content $hubEnv -Value $content
    Write-Host "  ✅ Updated hub env" -ForegroundColor Green
}

Write-Host "`n✅ All orchestration configs updated to: $NewUrl" -ForegroundColor Green
Write-Host "⚠  Remember to update PAPERCLIP_API_KEY after running bootstrap-ceo on the new instance" -ForegroundColor Yellow
