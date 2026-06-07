<#
.SYNOPSIS
    Paperclip Log Rotation - Rotates server.log when it exceeds 10 MB.

.DESCRIPTION
    Keeps up to 5 rotated log files (server.log.1.zip through server.log.5.zip).
    Uses copy+truncate approach (not rename) because pino on Windows keeps the
    old file descriptor open after rename. Called by the watchdog or standalone.

.NOTES
    RxHarden v4.1 - Task 2
    Author: Antigravity (AI)
    Date: 2026-06-07
#>

# ============================================================================
# CONFIGURATION
# ============================================================================
$INSTANCE_DIR   = Join-Path $env:USERPROFILE ".paperclip\instances\default"
$SERVER_LOG     = Join-Path $INSTANCE_DIR "logs\server.log"
$MAX_SIZE_BYTES = 10 * 1024 * 1024   # 10 MB
$MAX_ROTATIONS  = 5

# ============================================================================
# ROTATION LOGIC
# ============================================================================
function Invoke-PaperclipLogRotation {
    if (-not (Test-Path $SERVER_LOG)) {
        Write-Host "[LOG-ROTATE] server.log not found at $SERVER_LOG - nothing to rotate"
        return
    }

    $logItem = Get-Item $SERVER_LOG
    $sizeMB = [math]::Round($logItem.Length / 1048576, 2)

    if ($logItem.Length -le $MAX_SIZE_BYTES) {
        Write-Host "[LOG-ROTATE] server.log is $sizeMB MB (threshold: 10 MB) - no rotation needed"
        return
    }

    Write-Host "[LOG-ROTATE] server.log is $sizeMB MB - rotating..."

    $logsDir = Join-Path $INSTANCE_DIR "logs"

    # Step 1: Delete the oldest rotation if it exists
    $oldestZip = Join-Path $logsDir "server.log.${MAX_ROTATIONS}.zip"
    if (Test-Path $oldestZip) {
        Remove-Item $oldestZip -Force
        Write-Host "[LOG-ROTATE] Deleted oldest rotation: server.log.${MAX_ROTATIONS}.zip"
    }
    # Also check for uncompressed fallbacks
    $oldestPlain = Join-Path $logsDir "server.log.${MAX_ROTATIONS}"
    if (Test-Path $oldestPlain) {
        Remove-Item $oldestPlain -Force
    }

    # Step 2: Shift existing rotations up by 1
    for ($i = ($MAX_ROTATIONS - 1); $i -ge 1; $i--) {
        $nextNum = $i + 1
        # Shift zip files
        $currentZip = Join-Path $logsDir "server.log.${i}.zip"
        $nextZip    = Join-Path $logsDir "server.log.${nextNum}.zip"
        if (Test-Path $currentZip) {
            Move-Item $currentZip $nextZip -Force
        }
        # Shift plain files (fallback from failed compression)
        $currentPlain = Join-Path $logsDir "server.log.${i}"
        $nextPlain    = Join-Path $logsDir "server.log.${nextNum}"
        if (Test-Path $currentPlain) {
            Move-Item $currentPlain $nextPlain -Force
        }
    }

    # Step 3: Copy current log to staging, then truncate the original
    # This is the Windows-safe approach - pino keeps the original file descriptor
    # open, so we cannot rename it. Instead we copy the content and truncate.
    $stagingPath = Join-Path $logsDir "server.log.staging"
    try {
        # Copy the log content
        Copy-Item $SERVER_LOG $stagingPath -Force
        Write-Host "[LOG-ROTATE] Copied server.log to staging ($sizeMB MB)"

        # Truncate the original - pino will continue writing to the same fd
        # Using .NET to open the file and truncate it
        $fs = [System.IO.File]::Open($SERVER_LOG, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
        $fs.SetLength(0)
        $fs.Close()
        Write-Host "[LOG-ROTATE] Truncated server.log to 0 bytes"
    }
    catch {
        Write-Host "[LOG-ROTATE] Copy+truncate failed: $($_.Exception.Message)"
        # Last resort: keep last 1000 lines
        try {
            $tail = Get-Content $SERVER_LOG -Tail 1000 -Encoding UTF8 -ErrorAction Stop
            $tail | Set-Content $SERVER_LOG -Encoding UTF8 -Force
            Write-Host "[LOG-ROTATE] Fallback: kept last 1000 lines"
        }
        catch {
            Write-Host "[LOG-ROTATE] Even fallback truncation failed. Skipping rotation."
        }
        return
    }

    # Step 4: Compress the staged file
    $zipPath = Join-Path $logsDir "server.log.1.zip"
    try {
        Compress-Archive -Path $stagingPath -DestinationPath $zipPath -CompressionLevel Optimal -Force
        Remove-Item $stagingPath -Force -ErrorAction SilentlyContinue
        if (Test-Path $zipPath) {
            $zipSize = [math]::Round((Get-Item $zipPath).Length / 1048576, 2)
            Write-Host "[LOG-ROTATE] Compressed to server.log.1.zip ($zipSize MB)"
        }
    }
    catch {
        Write-Host "[LOG-ROTATE] Compression failed: $($_.Exception.Message) - keeping uncompressed"
        $fallbackPath = Join-Path $logsDir "server.log.1"
        if (Test-Path $stagingPath) {
            Move-Item $stagingPath $fallbackPath -Force -ErrorAction SilentlyContinue
            $fallbackMB = [math]::Round((Get-Item $fallbackPath -ErrorAction SilentlyContinue).Length / 1048576, 2)
            Write-Host "[LOG-ROTATE] Saved uncompressed as server.log.1 ($fallbackMB MB)"
        }
    }

    # Step 5: Report total rotated log disk usage
    $totalRotatedSize = 0
    Get-ChildItem $logsDir -Filter "server.log.*" -ErrorAction SilentlyContinue | ForEach-Object {
        $totalRotatedSize += $_.Length
    }
    $totalMB = [math]::Round($totalRotatedSize / 1048576, 2)
    Write-Host "[LOG-ROTATE] Total rotated log storage: $totalMB MB across $MAX_ROTATIONS max files"

    Write-Host "[LOG-ROTATE] Rotation complete. Freed ~$sizeMB MB"
}

# ============================================================================
# ENTRY POINT
# ============================================================================
Invoke-PaperclipLogRotation
