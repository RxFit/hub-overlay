# RxHarden v4.1 — Paperclip Dev Server Stability Hardening

## 1a. Project Overview & Core Objective

The Paperclip AI platform local dev server (127.0.0.1:3100) experiences **regular crashes** that require the user to manually restart it via PowerShell. This project audits the root causes and hardens the server for autonomous, resilient operation.

### Architecture Summary

- **Platform**: `paperclipai` npm package (v2026.525.0), run via `npx -y paperclipai`
- **Database**: Embedded PostgreSQL (port 54329) bundled via `@embedded-postgres/windows-x64`
- **Server**: Express 5 + WebSocket on Node.js 20, binding to 127.0.0.1:3100
- **Process Management**: **NONE** — runs in a bare terminal window
- **Agent Heartbeats**: 30-second intervals, spawning cmd.exe child processes for agent work
- **Storage**: 2.71 GB total in `~/.paperclip/` (logs: 146 MB, workspaces: 661 MB, backups: 215 MB, Gemini home: 1 GB)

### Root Cause Analysis — Why It Crashes

| # | Root Cause | Severity | Evidence |
|---|-----------|----------|----------|
| 1 | **No process manager** — server runs in bare terminal, no auto-restart | 🔴 CRITICAL | PID 70176 parent is `cmd.exe`, no PM2/systemd/Windows Service |
| 2 | **146 MB unbounded server log** — no rotation, verbose request logging with full headers/cookies | 🔴 CRITICAL | `server.log` = 167,214 lines, 146 MB, growing ~25 MB/day |
| 3 | **Agent error thrashing loop** — CEO 2 + CTO flip ERROR→idle→ERROR every 60s | 🟡 HIGH | Auditor log shows continuous 2-min reset cycles generating DB churn |
| 4 | **Stale PG lock files on restart** — embedded Postgres crashes without clean shutdown | 🟡 HIGH | Restart log: "Removing stale embedded PostgreSQL lock file" |
| 5 | **Port conflict race on restart** — port 3100 occupied by zombie, falls back to 3101 | 🟡 HIGH | "Requested port is busy; using next free port (3101)" |
| 6 | **Double backup scheduling** — two backup timers run concurrently after restart | 🟡 MEDIUM | 17 hours of duplicate backups every 30 min from 2026-06-06 onward |
| 7 | **72 concurrent Node.js processes** consuming 6.8 GB RAM total | 🟡 MEDIUM | `Get-Process node` shows 72 processes, total WS 6830 MB |
| 8 | **Agent heartbeat exit code 0xC0000409** (STATUS_STACK_BUFFER_OVERRUN) | 🟡 MEDIUM | Exit code 3221226505 in heartbeat_runs DB queries |
| 9 | **EPERM symlink failures** — Gemini skill linking fails on Windows | 🟢 LOW | "EPERM: operation not permitted, symlink" in server log |
| 10 | **Skills catalog 500 errors** — missing generated/catalog.json | 🟢 LOW | Repeated 500s on GET /api/skills/catalog |
| 11 | **Dead paperclip-db Docker container** — Exited 10 days ago | 🟢 LOW | Docker: `paperclip-db` status "Exited (255) 10 days ago" |

### Downtime Timeline (from backup gaps > 90 min)

| Start | End | Duration | Likely Cause |
|-------|-----|----------|-------------|
| 2026-05-24 22:31 | 2026-05-30 19:51 | **141 hours** | Initial setup / not running |
| 2026-05-31 12:08 | 2026-05-31 13:53 | 1.7 hours | Crash + manual restart |
| 2026-05-31 13:53 | 2026-06-01 20:57 | **31 hours** | Overnight crash, not restarted |
| 2026-06-02 21:56 | 2026-06-03 13:19 | **15.4 hours** | Overnight crash |
| 2026-06-04 10:29 | 2026-06-04 16:09 | **5.7 hours** | Midday crash (confirmed by auditor log) |
| 2026-06-04 16:09 | 2026-06-04 18:44 | 2.6 hours | Second crash same day (auto-restarted by auditor) |
| 2026-06-05 22:44 | 2026-06-06 06:31 | 7.8 hours | Overnight crash |
| 2026-06-07 02:31 | 2026-06-07 07:25 | 4.9 hours | Overnight crash |

**Pattern**: Server crashes consistently during overnight/idle periods, suggesting memory leak under sustained agent heartbeat load.

---

## 1b. Exhaustive Task List

### Task 1: Create PowerShell Auto-Restart Watchdog Script
Create a `paperclip-watchdog.ps1` script that:
- Health-checks `http://127.0.0.1:3100/api/health` every 30 seconds
- Auto-restarts `npx -y paperclipai run` if health check fails 3 consecutive times
- Kills zombie node processes holding port 3100 before restart
- Cleans stale PG lock files before restart
- Logs all actions to a dedicated watchdog log with rotation
- Can be registered as a Windows Scheduled Task for boot-time startup

### Task 2: Implement Log Rotation for server.log
Create a log rotation script/mechanism that:
- Rotates `server.log` when it exceeds 10 MB
- Keeps last 5 rotated files (50 MB max total)
- Compresses rotated logs with gzip
- Runs as part of the watchdog loop
- Does NOT require server restart to rotate (external rotation via rename + signal)

### Task 3: Create Windows Startup Task
Register a Windows Scheduled Task that:
- Starts the Paperclip watchdog on system boot (user login)
- Runs as the current user with no visible window
- Handles the dependency on PostgreSQL embedded startup
- Includes a 30-second startup delay to avoid port conflicts

### Task 4: Fix Agent Error Thrashing Loop
Audit and fix the agent error cycle:
- Identify why CEO 2 and CTO agents continuously flip to ERROR
- Check if the agent adapter configuration is correct
- Clean up stale/broken agent entries via the API
- Verify heartbeat recovery config to prevent thrashing

### Task 5: Clean Up Stale Infrastructure
- Remove dead `paperclip-db` Docker container
- Clean up duplicate backup files (keep only one per hour)
- Remove the stale `runtime-services/` PID file
- Clean up the 87 MB `gemini-launcher.exe` if unused

### Task 6: Create Emergency Recovery Script
Create `paperclip-emergency-restart.ps1` that:
- Force-kills ALL node processes on port 3100 and 54329
- Removes stale PG lock files
- Clears server.log if over 50 MB
- Starts fresh Paperclip instance
- Verifies health within 60 seconds

---

## 1c. Task Impact Analysis

| Task | Impact on System | Impact on User |
|------|-----------------|----------------|
| 1 - Watchdog | Eliminates need for manual restart; server recovers within 2 min of crash | User never has to open PowerShell to restart again |
| 2 - Log Rotation | Prevents disk I/O pressure from 146+ MB log file; reduces crash risk | Disk space reclaimed; faster log searches |
| 3 - Startup Task | Server starts automatically on boot; survives system restarts | No manual intervention on reboot |
| 4 - Agent Fix | Reduces DB churn by ~1440 unnecessary PATCH requests/day; reduces load | Agents actually work instead of error-cycling |
| 5 - Cleanup | Frees ~300 MB disk; removes confusion from stale infrastructure | Cleaner Docker/system state |
| 6 - Emergency Script | Provides guaranteed recovery when watchdog also fails | One-click full reset option |

---

## 1d. Necessity Justification

| Task | Why Strictly Necessary |
|------|----------------------|
| 1 - Watchdog | **Core fix.** Without this, every crash requires human intervention. The server has crashed 8+ times in 8 days. |
| 2 - Log Rotation | **Prevents cascading failure.** A 146 MB log file growing 25 MB/day will cause disk I/O storms and eventual disk-full crashes. |
| 3 - Startup Task | **Eliminates boot dependency.** Computer restarts currently leave Paperclip dead until manually started. |
| 4 - Agent Fix | **Reduces root cause load.** The error thrashing loop generates continuous unnecessary API traffic that contributes to server instability. |
| 5 - Cleanup | **Hygiene.** Dead containers and stale files create confusion and waste resources. Not crash-critical but reduces noise. |
| 6 - Emergency Script | **Safety net.** When the watchdog and normal restart fail, this provides a nuclear option that clears all blockers. |
