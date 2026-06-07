<#
.SYNOPSIS
    Paperclip Emergency Restart — Nuclear recovery when normal restart fails.

.DESCRIPTION
    Force-kills ALL processes on ports 3100 and 54329, cleans stale PG lock files,
    truncates oversized logs, starts a fresh Paperclip instance, and verifies health.

.NOTES
    RxHarden v4.1 — Task 6
    Author: Antigravity (AI)
    Date: 2026-06-07

.PARAMETER SkipVerify
    If specified, starts the server but doesn't wait for health verification.
#>

param(
    [switch]$SkipVerify
)

$SERVER_PORT    = 3100
$PG_PORT        = 54329
$HEALTH_URL     = "http://127.0.0.1:$SERVER_PORT/api/health"
$INSTANCE_DIR   = Join-Path $env:USERPROFILE ".paperclip\instances\default"
$SERVER_LOG     = Join-Path $INSTANCE_DIR "logs\server.log"
$DB_DIR         = Join-Path $INSTANCE_DIR "db"
$PG_LOCKFILE    = Join-Path $DB_DIR "postmaster.pid"
$VERIFY_TIMEOUT = 90

Write-Host ""
Write-Host "========================================" -ForegroundColor Red
Write-Host "  PAPERCLIP EMERGENCY RESTART" -ForegroundColor Red
Write-Host "========================================" -ForegroundColor Red
Write-Host ""

# ============================================================================
# STEP 1: Force-kill everything on ports 3100 and 54329
# ============================================================================
Write-Host "[1/6] Force-killing all processes on ports $SERVER_PORT and $PG_PORT..." -ForegroundColor Yellow

foreach ($port in @($SERVER_PORT, $PG_PORT)) {
    $connections = netstat -ano 2>$null | Select-String ":$port\s" | Where-Object { $_ -match "LISTENING" }
    if ($connections) {
        $pids = $connections | ForEach-Object { ($_ -split '\s+')[-1] } | Sort-Object -Unique | Where-Object { $_ -ne "0" }
        foreach ($pid in $pids) {
            try {
                $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
                if ($proc) {
                    Write-Host "  Killing $($proc.ProcessName) (PID $pid) on port $port" -ForegroundColor Red
                    # Kill entire process tree
                    $children = Get-WmiObject Win32_Process -Filter "ParentProcessId = $pid" -ErrorAction SilentlyContinue
                    foreach ($child in $children) {
                        Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue
                    }
                    Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
                }
            }
            catch {
                Write-Host "  Warning: Could not kill PID $pid : $($_.Exception.Message)" -ForegroundColor Yellow
            }
        }
    }
    else {
        Write-Host "  No process found on port $port" -ForegroundColor Gray
    }
}

Start-Sleep -Seconds 5
Write-Host "  Done." -ForegroundColor Green

# ============================================================================
# STEP 2: Remove stale PG lock file
# ============================================================================
Write-Host "[2/6] Cleaning stale PG lock files..." -ForegroundColor Yellow
if (Test-Path $PG_LOCKFILE) {
    Remove-Item $PG_LOCKFILE -Force -ErrorAction SilentlyContinue
    Write-Host "  Removed: $PG_LOCKFILE" -ForegroundColor Green
}
else {
    Write-Host "  No stale lock file found" -ForegroundColor Gray
}

# ============================================================================
# STEP 3: Truncate oversized server.log
# ============================================================================
Write-Host "[3/6] Checking server.log size..." -ForegroundColor Yellow
if (Test-Path $SERVER_LOG) {
    $logSize = (Get-Item $SERVER_LOG).Length
    $logMB = [math]::Round($logSize / 1MB, 2)
    if ($logSize -gt 50MB) {
        Write-Host "  server.log is $logMB MB — truncating to last 500 lines" -ForegroundColor Yellow
        $tail = Get-Content $SERVER_LOG -Tail 500 -Encoding UTF8 -ErrorAction SilentlyContinue
        $tail | Set-Content $SERVER_LOG -Encoding UTF8 -Force
        Write-Host "  Truncated." -ForegroundColor Green
    }
    else {
        Write-Host "  server.log is $logMB MB — OK" -ForegroundColor Gray
    }
}
else {
    Write-Host "  server.log not found" -ForegroundColor Gray
}

# ============================================================================
# STEP 4: Final port verification
# ============================================================================
Write-Host "[4/6] Verifying ports are free..." -ForegroundColor Yellow
$remaining = netstat -ano 2>$null | Select-String ":($SERVER_PORT|$PG_PORT)\s" | Where-Object { $_ -match "LISTENING" }
if ($remaining) {
    Write-Host "  WARNING: Ports still in use! Waiting 10 more seconds..." -ForegroundColor Red
    Start-Sleep -Seconds 10
    $remaining = netstat -ano 2>$null | Select-String ":($SERVER_PORT|$PG_PORT)\s" | Where-Object { $_ -match "LISTENING" }
    if ($remaining) {
        Write-Host "  CRITICAL: Ports STILL in use. You may need to restart the computer." -ForegroundColor Red
        Write-Host "  Attempting to start anyway..." -ForegroundColor Yellow
    }
}
else {
    Write-Host "  All ports free." -ForegroundColor Green
}

# ============================================================================
# STEP 5: Start fresh Paperclip instance
# ============================================================================
Write-Host "[5/6] Starting fresh Paperclip instance..." -ForegroundColor Yellow
try {
    $process = Start-Process -FilePath "npx" -ArgumentList "-y", "paperclipai", "run" `
        -WindowStyle Hidden `
        -PassThru

    Write-Host "  Paperclip started (PID: $($process.Id))" -ForegroundColor Green
}
catch {
    Write-Host "  FATAL: Could not start Paperclip: $($_.Exception.Message)" -ForegroundColor Red
    exit 2
}

# ============================================================================
# STEP 6: Verify health
# ============================================================================
if ($SkipVerify) {
    Write-Host "[6/6] Skipping health verification (-SkipVerify)" -ForegroundColor Gray
}
else {
    Write-Host "[6/6] Waiting up to $VERIFY_TIMEOUT seconds for health..." -ForegroundColor Yellow
    $startTime = Get-Date
    $healthy = $false

    while (((Get-Date) - $startTime).TotalSeconds -lt $VERIFY_TIMEOUT) {
        Start-Sleep -Seconds 5
        $elapsed = [math]::Round(((Get-Date) - $startTime).TotalSeconds)
        Write-Host "  Checking health... (${elapsed}s / ${VERIFY_TIMEOUT}s)" -ForegroundColor Gray -NoNewline

        try {
            $response = Invoke-RestMethod -Uri $HEALTH_URL -TimeoutSec 10 -ErrorAction Stop
            if ($response.status -eq "ok") {
                Write-Host " OK!" -ForegroundColor Green
                $healthy = $true
                break
            }
            Write-Host " (status: $($response.status))" -ForegroundColor Yellow
        }
        catch {
            Write-Host " (not yet)" -ForegroundColor Gray
        }
    }

    if ($healthy) {
        Write-Host ""
        Write-Host "========================================" -ForegroundColor Green
        Write-Host "  EMERGENCY RESTART SUCCESSFUL" -ForegroundColor Green
        Write-Host "  Server healthy at $HEALTH_URL" -ForegroundColor Green
        Write-Host "========================================" -ForegroundColor Green
    }
    else {
        Write-Host ""
        Write-Host "========================================" -ForegroundColor Red
        Write-Host "  EMERGENCY RESTART FAILED" -ForegroundColor Red
        Write-Host "  Server did not become healthy" -ForegroundColor Red
        Write-Host "  Check: $SERVER_LOG" -ForegroundColor Red
        Write-Host "========================================" -ForegroundColor Red
        exit 2
    }
}
