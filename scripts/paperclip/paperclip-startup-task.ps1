<#
.SYNOPSIS
    Registers the Paperclip Watchdog as a Windows Scheduled Task.

.DESCRIPTION
    Creates a scheduled task named "PaperclipWatchdog" that starts the watchdog
    daemon on user login with a 30-second delay. Runs hidden (no window).

.NOTES
    RxHarden v4.1 - Task 3
    Author: Antigravity (AI)
    Date: 2026-06-07

.PARAMETER Unregister
    If specified, removes the scheduled task instead of creating it.
#>

param(
    [switch]$Unregister
)

$TASK_NAME = "PaperclipWatchdog"
$WATCHDOG_SCRIPT = Join-Path $PSScriptRoot "paperclip-watchdog.ps1"

# ============================================================================
# UNREGISTER
# ============================================================================
if ($Unregister) {
    $existing = Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false
        Write-Host "[STARTUP] Removed scheduled task: $TASK_NAME" -ForegroundColor Yellow
    }
    else {
        Write-Host "[STARTUP] Task '$TASK_NAME' not found - nothing to remove" -ForegroundColor Gray
    }
    return
}

# ============================================================================
# REGISTER
# ============================================================================

# Verify watchdog script exists
if (-not (Test-Path $WATCHDOG_SCRIPT)) {
    Write-Host "[STARTUP] ERROR: Watchdog script not found at $WATCHDOG_SCRIPT" -ForegroundColor Red
    exit 1
}

# Remove existing task if present
$existing = Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "[STARTUP] Removing existing task: $TASK_NAME"
    Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false
}

# Create the scheduled task
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger.Delay = "PT30S"  # 30-second delay after login

$scriptArg = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$WATCHDOG_SCRIPT"""
$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument $scriptArg `
    -WorkingDirectory $PSScriptRoot

$restartSpan = New-TimeSpan -Minutes 5
$execLimit = New-TimeSpan -Days 365
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartInterval $restartSpan `
    -RestartCount 3 `
    -ExecutionTimeLimit $execLimit `
    -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Highest

try {
    Register-ScheduledTask `
        -TaskName $TASK_NAME `
        -Trigger $trigger `
        -Action $action `
        -Settings $settings `
        -Principal $principal `
        -Description "Paperclip AI Server Watchdog - auto-restarts the server on crash. Created by RxHarden v4.1." `
        -Force | Out-Null

    Write-Host "[STARTUP] Successfully registered scheduled task: $TASK_NAME" -ForegroundColor Green
    Write-Host "[STARTUP]   Trigger: At login ($env:USERNAME) with 30s delay"
    Write-Host "[STARTUP]   Action:  powershell.exe -File $WATCHDOG_SCRIPT"
    Write-Host "[STARTUP]   Style:   Hidden (no window)"
    Write-Host "[STARTUP]   Restart: Up to 3 retries every 5 min if watchdog crashes"
    Write-Host ""
    Write-Host "[STARTUP] To verify: Get-ScheduledTask -TaskName '$TASK_NAME'" -ForegroundColor Cyan
    Write-Host "[STARTUP] To remove: .\paperclip-startup-task.ps1 -Unregister" -ForegroundColor Cyan
    Write-Host "[STARTUP] To start now: Start-ScheduledTask -TaskName '$TASK_NAME'" -ForegroundColor Cyan
}
catch {
    Write-Host "[STARTUP] ERROR: Failed to register scheduled task: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "[STARTUP] Try running this script as Administrator" -ForegroundColor Yellow
    exit 1
}
