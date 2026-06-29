<#
.SYNOPSIS
    Paperclip AI Server Watchdog - Auto-restart daemon for the local Paperclip instance.

.DESCRIPTION
    Monitors the Paperclip server health at http://127.0.0.1:3100/api/health.
    Automatically restarts the server after 3 consecutive health check failures.
    Handles zombie process cleanup, stale PG lock files, and log rotation.

.NOTES
    RxHarden v4.1 - Task 1
    Author: Antigravity (AI)
    Date: 2026-06-07
#>

# ============================================================================
# CONFIGURATION
# ============================================================================
$HEALTH_URL          = "http://127.0.0.1:3100/api/health"
$HEALTH_TIMEOUT_SEC  = 10
$CHECK_INTERVAL_SEC  = 30
$MAX_FAILURES        = 3
$STARTUP_WAIT_SEC    = 60
$SERVER_PORT         = 3100
$PG_PORT             = 54329

# Paths
$INSTANCE_DIR        = Join-Path $env:USERPROFILE ".paperclip\instances\default"
$SERVER_LOG          = Join-Path $INSTANCE_DIR "logs\server.log"
$DB_DIR              = Join-Path $INSTANCE_DIR "db"
$PG_LOCKFILE         = Join-Path $DB_DIR "postmaster.pid"
$WATCHDOG_LOG        = Join-Path $INSTANCE_DIR "logs\watchdog.log"
$LOG_ROTATE_SCRIPT   = Join-Path $PSScriptRoot "paperclip-log-rotate.ps1"

# State
$consecutiveFailures = 0
$restartCount        = 0
$lastHealthy         = $null
$watchdogStartTime   = Get-Date

# ============================================================================
# LOGGING
# ============================================================================
function Write-WatchdogLog {
    param(
        [Parameter(Mandatory)][string]$Level,
        [Parameter(Mandatory)][string]$Message
    )
    $timestamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    $entry = "[$timestamp] [$Level] $Message"

    # Ensure log directory exists
    $logDir = Split-Path $WATCHDOG_LOG -Parent
    if (-not (Test-Path $logDir)) {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    }

    # Append to log file
    $entry | Out-File -FilePath $WATCHDOG_LOG -Append -Encoding UTF8

    # Also write to console (if interactive)
    switch ($Level) {
        "ERROR" { Write-Host $entry -ForegroundColor Red }
        "WARN"  { Write-Host $entry -ForegroundColor Yellow }
        "INFO"  { Write-Host $entry -ForegroundColor Green }
        "FATAL" { Write-Host $entry -ForegroundColor Magenta }
        default { Write-Host $entry }
    }
}

# ============================================================================
# HEALTH CHECK
# ============================================================================
function Test-PaperclipHealth {
    try {
        $response = Invoke-RestMethod -Uri $HEALTH_URL -TimeoutSec $HEALTH_TIMEOUT_SEC -ErrorAction Stop
        if ($response.status -eq "ok") {
            return $true
        }
        Write-WatchdogLog "WARN" "Health check returned non-ok status: $($response.status)"
        return $false
    }
    catch {
        Write-WatchdogLog "WARN" "Health check failed: $($_.Exception.Message)"
        return $false
    }
}

# ============================================================================
# PROCESS MANAGEMENT
# ============================================================================
function Get-ProcessOnPort {
    param([int]$Port)
    try {
        $portStr = ":$Port"
        $connections = netstat -ano 2>$null | Select-String $portStr |
            Where-Object { $_ -match "LISTENING" }
        if ($connections) {
            $pids = $connections | ForEach-Object {
                $parts = ($_.ToString().Trim()) -split '\s+'
                $parts[-1]
            } | Sort-Object -Unique | Where-Object { $_ -ne "0" }
            return $pids
        }
    }
    catch {
        Write-WatchdogLog "WARN" "Failed to check port ${Port}: $($_.Exception.Message)"
    }
    return @()
}

function Stop-ProcessTree {
    param([int]$ProcessId)
    Write-WatchdogLog "INFO" "Killing process tree rooted at PID $ProcessId"

    # Find all children recursively
    $children = @()
    $queue = @($ProcessId)
    while ($queue.Count -gt 0) {
        $current = $queue[0]
        if ($queue.Count -gt 1) {
            $queue = $queue[1..($queue.Count - 1)]
        } else {
            $queue = @()
        }
        $childProcs = Get-WmiObject Win32_Process -Filter "ParentProcessId = $current" -ErrorAction SilentlyContinue
        foreach ($child in $childProcs) {
            $children += $child.ProcessId
            $queue += $child.ProcessId
        }
    }

    # Kill children first (bottom-up), then parent
    $allPids = @($children) + @($ProcessId)
    [array]::Reverse($allPids)

    foreach ($pidItem in ($allPids | Select-Object -Unique)) {
        try {
            $proc = Get-Process -Id $pidItem -ErrorAction SilentlyContinue
            if ($proc) {
                Write-WatchdogLog "INFO" "  Stopping: $($proc.ProcessName) (PID $pidItem)"
                Stop-Process -Id $pidItem -Force -ErrorAction SilentlyContinue
            }
        }
        catch {
            Write-WatchdogLog "WARN" "  Failed to stop PID ${pidItem}: $($_.Exception.Message)"
        }
    }

    # Grace period for cleanup
    Start-Sleep -Seconds 3
}

function Clear-PortHolders {
    param([int]$Port)
    $pids = Get-ProcessOnPort -Port $Port
    foreach ($pidVal in $pids) {
        Write-WatchdogLog "WARN" "Found zombie process on port $Port (PID $pidVal) - killing tree"
        Stop-ProcessTree -ProcessId ([int]$pidVal)
    }
}

# ============================================================================
# STALE PG LOCK CLEANUP
# ============================================================================
function Clear-StalePGLock {
    if (Test-Path $PG_LOCKFILE) {
        # Only remove if no postgres process is actually running on the PG port
        $pgPids = Get-ProcessOnPort -Port $PG_PORT
        if ($pgPids.Count -eq 0) {
            Write-WatchdogLog "WARN" "Removing stale PG lock file: $PG_LOCKFILE"
            Remove-Item $PG_LOCKFILE -Force -ErrorAction SilentlyContinue
        }
        else {
            $pgList = $pgPids -join ', '
            Write-WatchdogLog "INFO" "PG lock file exists but postgres is running (PIDs: $pgList) - skipping removal"
        }
    }
}

# ============================================================================
# LOG ROTATION
# ============================================================================
function Invoke-LogRotation {
    if (Test-Path $LOG_ROTATE_SCRIPT) {
        Write-WatchdogLog "INFO" "Triggering log rotation"
        try {
            & $LOG_ROTATE_SCRIPT
        }
        catch {
            Write-WatchdogLog "WARN" "Log rotation failed: $($_.Exception.Message)"
        }
    }
    else {
        # Inline fallback: truncate if over 50 MB
        if (Test-Path $SERVER_LOG) {
            $logSize = (Get-Item $SERVER_LOG).Length
            $maxLogSize = 50 * 1024 * 1024
            if ($logSize -gt $maxLogSize) {
                $logSizeMB = [math]::Round($logSize / 1048576, 2)
                Write-WatchdogLog "WARN" "server.log is $logSizeMB MB - truncating (rotation script not found)"
                # Use .NET to truncate while pino keeps writing
                try {
                    $fs = [System.IO.File]::Open($SERVER_LOG, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
                    $fs.SetLength(0)
                    $fs.Close()
                }
                catch {
                    # Last resort: overwrite with tail
                    $tail = Get-Content $SERVER_LOG -Tail 1000 -Encoding UTF8 -ErrorAction SilentlyContinue
                    $tail | Set-Content $SERVER_LOG -Encoding UTF8 -Force
                }
            }
        }
    }

    # Self-rotate watchdog log at 5 MB
    if (Test-Path $WATCHDOG_LOG) {
        $wdSize = (Get-Item $WATCHDOG_LOG).Length
        $maxWdSize = 5 * 1024 * 1024
        if ($wdSize -gt $maxWdSize) {
            $rotatedPath = "${WATCHDOG_LOG}.1"
            if (Test-Path $rotatedPath) { Remove-Item $rotatedPath -Force }
            Move-Item $WATCHDOG_LOG $rotatedPath -Force
            $wdSizeMB = [math]::Round($wdSize / 1048576, 2)
            Write-WatchdogLog "INFO" "Rotated watchdog log ($wdSizeMB MB)"
        }
    }
}

# ============================================================================
# SERVER RESTART
# ============================================================================
function Restart-PaperclipServer {
    $script:restartCount++
    $count = $script:restartCount
    Write-WatchdogLog "ERROR" "=== RESTART #${count} INITIATED ==="

    # Step 1: Rotate logs before restart
    Invoke-LogRotation

    # Step 2: Kill any zombie processes holding port 3100
    Clear-PortHolders -Port $SERVER_PORT

    # Step 3: Kill any zombie postgres on port 54329
    Clear-PortHolders -Port $PG_PORT

    # Step 4: Wait for ports to fully release
    Start-Sleep -Seconds 5

    # Step 5: Clear stale PG lock
    Clear-StalePGLock

    # Step 6: Verify ports are free
    $remaining3100 = Get-ProcessOnPort -Port $SERVER_PORT
    $remaining54329 = Get-ProcessOnPort -Port $PG_PORT
    if ($remaining3100.Count -gt 0 -or $remaining54329.Count -gt 0) {
        $r1 = $remaining3100 -join ','
        $r2 = $remaining54329 -join ','
        Write-WatchdogLog "ERROR" "Ports still occupied after cleanup! 3100: [$r1] 54329: [$r2]"
        Write-WatchdogLog "ERROR" "Waiting 10 more seconds..."
        Start-Sleep -Seconds 10
    }

    # Step 7: Start fresh Paperclip server
    Write-WatchdogLog "INFO" "Starting Paperclip server via: npx -y paperclipai run"
    $stderrLog = Join-Path $INSTANCE_DIR "logs\paperclip-stderr.log"
    try {
        $process = Start-Process -FilePath "npx.cmd" `
            -ArgumentList "-y", "paperclipai", "run" `
            -WindowStyle Hidden `
            -PassThru `
            -RedirectStandardError $stderrLog

        Write-WatchdogLog "INFO" "Paperclip server started (PID: $($process.Id))"
    }
    catch {
        Write-WatchdogLog "FATAL" "Failed to start Paperclip server: $($_.Exception.Message)"
        return $false
    }

    # Step 8: Wait for health
    Write-WatchdogLog "INFO" "Waiting up to $STARTUP_WAIT_SEC seconds for server health..."
    $startWait = Get-Date
    $healthy = $false
    while (((Get-Date) - $startWait).TotalSeconds -lt $STARTUP_WAIT_SEC) {
        Start-Sleep -Seconds 5
        if (Test-PaperclipHealth) {
            $healthy = $true
            break
        }
    }

    if ($healthy) {
        Write-WatchdogLog "INFO" "=== RESTART #${count} SUCCESSFUL - server healthy ==="
        $script:lastHealthy = Get-Date
        return $true
    }
    else {
        Write-WatchdogLog "ERROR" "=== RESTART #${count} FAILED - server did not become healthy within $STARTUP_WAIT_SEC seconds ==="
        return $false
    }
}

# ============================================================================
# MAIN WATCHDOG LOOP
# ============================================================================
function Start-Watchdog {
    Write-WatchdogLog "INFO" "============================================"
    Write-WatchdogLog "INFO" "Paperclip Watchdog started"
    Write-WatchdogLog "INFO" "  Health URL:     $HEALTH_URL"
    Write-WatchdogLog "INFO" "  Check interval: ${CHECK_INTERVAL_SEC}s"
    Write-WatchdogLog "INFO" "  Max failures:   $MAX_FAILURES"
    Write-WatchdogLog "INFO" "  Instance dir:   $INSTANCE_DIR"
    Write-WatchdogLog "INFO" "============================================"

    # Initial health check
    if (Test-PaperclipHealth) {
        Write-WatchdogLog "INFO" "Server is already healthy - entering monitoring mode"
        $script:lastHealthy = Get-Date
    }
    else {
        Write-WatchdogLog "WARN" "Server is NOT healthy on startup - will trigger restart after $MAX_FAILURES consecutive failures"
    }

    # Periodic log rotation check (every 30 minutes = 60 checks)
    $checksSinceRotation = 0
    $ROTATION_INTERVAL = 60

    while ($true) {
        Start-Sleep -Seconds $CHECK_INTERVAL_SEC

        $checksSinceRotation++

        if (Test-PaperclipHealth) {
            if ($consecutiveFailures -gt 0) {
                Write-WatchdogLog "INFO" "Server recovered after $consecutiveFailures failure(s)"
            }
            $script:consecutiveFailures = 0
            $script:lastHealthy = Get-Date
        }
        else {
            $script:consecutiveFailures++
            $failures = $script:consecutiveFailures
            if ($lastHealthy) {
                $elapsed = ((Get-Date) - $lastHealthy)
                $uptimeStr = "{0:hh}:{0:mm}:{0:ss}" -f $elapsed
            } else {
                $uptimeStr = "never"
            }
            Write-WatchdogLog "WARN" "Consecutive failures: $failures / $MAX_FAILURES (last healthy: $uptimeStr ago)"

            if ($failures -ge $MAX_FAILURES) {
                Write-WatchdogLog "ERROR" "Failure threshold reached - initiating restart"

                $success = Restart-PaperclipServer
                $script:consecutiveFailures = 0

                if (-not $success) {
                    Write-WatchdogLog "FATAL" "Restart failed! Will retry on next cycle."
                }
            }
        }

        # Periodic log rotation (every ~30 min)
        if ($checksSinceRotation -ge $ROTATION_INTERVAL) {
            $checksSinceRotation = 0
            Invoke-LogRotation
        }
    }
}

# ============================================================================
# ENTRY POINT
# ============================================================================
Start-Watchdog
