# RxHarden Paperclip Server Stability Fix

## Metadata
| Key | Value |
|-----|-------|
| Date | 2026-06-07T16:42:00Z |
| Workspace | vibrant-chandrasekhar |
| Conversation | 03e28109 |
| Type | fix |

## Summary
Performed a full forensic audit and implemented the RxHarden stability protocol for the local Paperclip dev server (127.0.0.1:3100) which was crashing overnight due to an unbounded 146MB log file, a lack of process management, and agent error thrashing on the RxFit organization. Created a PowerShell watchdog, a Windows-safe copy+truncate log rotation script, and an emergency restart script. The infrastructure cleanup tasks were delegated to the CEO agent via Paperclip-Ops issue HUB-15.

## Key Decisions
- **Watchdog over Service**: Built a PowerShell watchdog script (`paperclip-watchdog.ps1`) instead of a raw Windows service because it allows for custom process tree killing and stale PostgreSQL lock file cleanup before restarts.
- **Copy+Truncate Log Rotation**: Windows locks files opened by `pino`. Standard rename log rotation causes data loss. Used `.NET FileStream.SetLength(0)` to truncate the log in-place after copying, preserving data without breaking the logger's file descriptor.
- **Paperclip-Ops Delegation**: Delegated the agent thrashing loop fix, Docker container cleanup, and backup deduplication to the CEO agent (`a26e5555`) to keep the infrastructure code decoupled from the Paperclip DB mutations.

## Files Changed
- `RXHARDEN_OVERVIEW.md` — Created to document forensic audit.
- `RXHARDEN_MASTER_CONTRACT.md` — Created to define script contracts and state shapes.
- `RXHARDEN_COGNITION_LOG.md` — Created as an append-only cognitive ledger for Pre-Cog analysis.
- `scripts/paperclip/paperclip-watchdog.ps1` — Created watchdog daemon for auto-restarts and health checks.
- `scripts/paperclip/paperclip-log-rotate.ps1` — Created log rotation script utilizing copy+truncate.
- `scripts/paperclip/paperclip-startup-task.ps1` — Created Windows Scheduled Task registration script.
- `scripts/paperclip/paperclip-emergency-restart.ps1` — Created nuclear recovery script.

## Tags
#memory #vibrant-chandrasekhar #fix #rxharden #paperclip-ops #watchdog
