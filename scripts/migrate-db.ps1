<#
.SYNOPSIS
    Migrates local Paperclip Postgres database to Railway Postgres.
    
.DESCRIPTION
    Exports the local embedded Postgres database using pg_dump,
    then restores it to the Railway Postgres instance.
    
.PARAMETER RailwayDatabaseUrl
    The full DATABASE_URL from Railway Postgres plugin.
    Example: postgresql://user:pass@host:port/railway
    
.PARAMETER BackupFile
    Optional: path to an existing .sql.gz backup file.
    If not provided, performs a live pg_dump from the local instance.
    
.NOTES
    TEMPORARY: Uses local Paperclip Postgres credentials.
    Author: Antigravity (automated)
    Date: 2026-05-28
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$RailwayDatabaseUrl,
    
    [Parameter(Mandatory = $false)]
    [string]$BackupFile
)

$ErrorActionPreference = "Stop"

$LocalPgPort = 54329
$LocalPgUser = "postgres"
$LocalPgDb = "paperclip"

# ── Step 1: Get the backup ──

if ($BackupFile -and (Test-Path $BackupFile)) {
    Write-Host "Using existing backup: $BackupFile" -ForegroundColor Cyan
    $SqlFile = $BackupFile
} else {
    Write-Host "Performing live pg_dump from local Paperclip instance..." -ForegroundColor Cyan
    
    # Check if local Postgres is running
    $pgCheck = Test-NetConnection -ComputerName localhost -Port $LocalPgPort -InformationLevel Quiet
    if (-not $pgCheck) {
        Write-Error "Local Paperclip Postgres is not running on port $LocalPgPort. Start Paperclip first."
        exit 1
    }
    
    $timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
    $dumpDir = "$env:USERPROFILE\.paperclip\instances\default\data\backups"
    if (-not (Test-Path $dumpDir)) { New-Item -ItemType Directory -Path $dumpDir -Force | Out-Null }
    $SqlFile = Join-Path $dumpDir "migration_$timestamp.sql.gz"
    
    Write-Host "Dumping to: $SqlFile"
    
    # Find pg_dump in the Paperclip embedded postgres
    $pgBinPaths = @(
        "$env:USERPROFILE\.paperclip\instances\default\db\bin",
        "C:\Program Files\PostgreSQL\16\bin",
        "C:\Program Files\PostgreSQL\15\bin"
    )
    
    $pgDump = $null
    foreach ($p in $pgBinPaths) {
        $candidate = Join-Path $p "pg_dump.exe"
        if (Test-Path $candidate) {
            $pgDump = $candidate
            break
        }
    }
    
    if (-not $pgDump) {
        Write-Error "pg_dump.exe not found. Install PostgreSQL or ensure Paperclip's embedded postgres is accessible."
        exit 1
    }
    
    $env:PGPASSWORD = ""  # Paperclip embedded postgres typically has no password in local_trusted mode
    & $pgDump -h localhost -p $LocalPgPort -U $LocalPgUser -d $LocalPgDb --no-owner --no-privileges --format=plain | 
        Compress-Archive -DestinationPath $SqlFile -Force
    
    Write-Host "Dump complete: $SqlFile ($('{0:N2}' -f ((Get-Item $SqlFile).Length / 1MB)) MB)" -ForegroundColor Green
}

# ── Step 2: Parse Railway DATABASE_URL ──

Write-Host "`nConnecting to Railway Postgres..." -ForegroundColor Cyan

$uri = [System.Uri]$RailwayDatabaseUrl
$RemoteHost = $uri.Host
$RemotePort = if ($uri.Port -gt 0) { $uri.Port } else { 5432 }
$RemoteUser = $uri.UserInfo.Split(':')[0]
$RemotePass = $uri.UserInfo.Split(':')[1]
$RemoteDb = $uri.AbsolutePath.TrimStart('/')

Write-Host "Host: ${RemoteHost}:${RemotePort} | DB: ${RemoteDb} | User: ${RemoteUser}"

# ── Step 3: Restore to Railway ──

Write-Host "`nRestoring database..." -ForegroundColor Cyan

$env:PGPASSWORD = $RemotePass

# Find psql
$psql = $null
foreach ($p in $pgBinPaths) {
    $candidate = Join-Path $p "psql.exe"
    if (Test-Path $candidate) {
        $psql = $candidate
        break
    }
}

if (-not $psql) {
    Write-Warning "psql.exe not found locally. Use Railway CLI instead:"
    Write-Host "  railway run psql `$DATABASE_URL < dump.sql" -ForegroundColor Yellow
    exit 1
}

# Decompress if .gz
if ($SqlFile -match '\.gz$') {
    $decompressed = $SqlFile -replace '\.gz$', ''
    Write-Host "Decompressing..."
    [System.IO.Compression.GZipStream]::new(
        [System.IO.File]::OpenRead($SqlFile),
        [System.IO.Compression.CompressionMode]::Decompress
    ).CopyTo([System.IO.File]::Create($decompressed))
    $SqlFile = $decompressed
}

& $psql -h $RemoteHost -p $RemotePort -U $RemoteUser -d $RemoteDb -f $SqlFile 2>&1 | 
    Tee-Object -Variable restoreOutput

$errors = $restoreOutput | Where-Object { $_ -match 'ERROR' }
if ($errors.Count -gt 0) {
    Write-Warning "$($errors.Count) errors during restore (often harmless role/schema conflicts):"
    $errors | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
}

# ── Step 4: Verify ──

Write-Host "`nVerifying migration..." -ForegroundColor Cyan

$verifyQuery = @"
SELECT 
    schemaname || '.' || tablename AS table_name,
    n_live_tup AS row_count
FROM pg_stat_user_tables 
WHERE n_live_tup > 0
ORDER BY n_live_tup DESC
LIMIT 20;
"@

& $psql -h $RemoteHost -p $RemotePort -U $RemoteUser -d $RemoteDb -c $verifyQuery

Write-Host "`n✅ Migration complete!" -ForegroundColor Green
Write-Host "Railway Postgres: ${RemoteHost}:${RemotePort}/${RemoteDb}" -ForegroundColor Cyan

# Cleanup
$env:PGPASSWORD = ""
