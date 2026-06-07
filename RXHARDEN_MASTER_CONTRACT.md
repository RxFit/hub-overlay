# RxHarden Master Contract — Paperclip Server Hardening

## 2a. Shared Interfaces & Types

This project produces PowerShell scripts (not TypeScript). The "interfaces" are the contracts between scripts.

### Watchdog Health Check Response
```json
{
  "status": "ok",
  "deploymentMode": "authenticated",
  "deploymentExposure": "private",
  "bootstrapStatus": "ready",
  "bootstrapInviteActive": false
}
```

### Watchdog Log Entry Format
```
[YYYY-MM-DD HH:mm:ss] [LEVEL] Message
```
Levels: `INFO`, `WARN`, `ERROR`, `FATAL`

### Script Exit Codes
| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Health check failed but recovery succeeded |
| 2 | Recovery failed |
| 3 | Critical failure — manual intervention needed |

### File Path Constants
| Key | Path |
|-----|------|
| PAPERCLIP_INSTANCE_DIR | `$env:USERPROFILE\.paperclip\instances\default` |
| PAPERCLIP_LOG | `$PAPERCLIP_INSTANCE_DIR\logs\server.log` |
| PAPERCLIP_DB_DIR | `$PAPERCLIP_INSTANCE_DIR\db` |
| WATCHDOG_LOG | `$PAPERCLIP_INSTANCE_DIR\logs\watchdog.log` |
| HEALTH_URL | `http://127.0.0.1:3100/api/health` |
| PG_LOCKFILE | `$PAPERCLIP_DB_DIR\postmaster.pid` |

---

## 2b. Global State Shapes

### Watchdog State
- `$consecutiveFailures` — int, 0-3, resets on successful health check
- `$lastHealthy` — datetime, last successful health check timestamp
- `$restartCount` — int, number of restarts since watchdog started
- `$serverPid` — int, PID of the Paperclip node process

### Port/Process State
- Port 3100: owned by Paperclip server (node.exe)
- Port 54329: owned by embedded PostgreSQL (postgres.exe)
- Paperclip server PID is parent of PostgreSQL PID

---

## 2c. API Endpoints Used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/health` | GET | Health probe |
| `/api/companies/{id}/agents` | GET | List agents to check error states |
| `/api/agents/{id}` | PATCH | Reset agent status |

---

## 2d. Immutability Rule

> **MASTER CONTRACT IMMUTABILITY RULE:** No following task may deviate from this Master Contract without explicit reconciliation via the Cascade Diff Check (Step 3k). Any deviation without reconciliation is a CRITICAL VIOLATION requiring immediate halt.

---

## Script Contracts

### paperclip-watchdog.ps1
**Inputs**: None (self-contained)
**Outputs**: Watchdog log entries, auto-restarts
**Dependencies**: `npx`, `netstat`, `Invoke-RestMethod`
**Behavior**:
1. Loop every 30 seconds
2. Health check → 3 consecutive failures → restart
3. Before restart: kill zombie processes, clean PG locks, rotate logs
4. After restart: wait 60s for health, verify

### paperclip-log-rotate.ps1
**Inputs**: None (called by watchdog)
**Outputs**: Rotated log files (server.log.1.gz through server.log.5.gz)
**Behavior**:
1. Check if server.log > 10 MB
2. If yes: rotate existing files, compress, delete oldest
3. No server restart needed — Paperclip uses pino which reopens on file rename

### paperclip-startup-task.ps1
**Inputs**: None
**Outputs**: Registers Windows Scheduled Task named "PaperclipWatchdog"
**Behavior**:
1. Creates scheduled task that runs paperclip-watchdog.ps1 at user login
2. Runs hidden (no window)
3. 30-second startup delay

### paperclip-emergency-restart.ps1
**Inputs**: None
**Outputs**: Force-restarted Paperclip
**Behavior**:
1. Force-kill ALL processes on ports 3100 and 54329
2. Clean PG lock files
3. Truncate server.log if > 50 MB
4. Start fresh instance
5. Verify health within 60 seconds
