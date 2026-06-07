# RxHarden Cognitive Ledger - Paperclip Server Stability Hardening

> This file is the externalized chain-of-thought for the RxHarden execution.
> It is APPEND-ONLY. Never delete or overwrite previous entries.
> The agent MUST append Pre-Cog outputs and Hostile Auditor findings here
> BEFORE writing any implementation code.

---

## Pre-Task Analysis: Initial Forensic Investigation

### Context & Dependency Matrix

| Node | Type | Direction | Risk Level |
|------|------|-----------|------------|
| `~/.paperclip/instances/default/logs/server.log` (146 MB) | File | Write | 🔴 CRITICAL |
| `~/.paperclip/instances/default/db/postmaster.pid` | File | Read/Write | 🟡 HIGH |
| Port 3100 (Node.js server) | Network | Listen | 🔴 CRITICAL |
| Port 54329 (Embedded PostgreSQL) | Network | Listen | 🟡 HIGH |
| `npx paperclipai run` CLI entry | Process | Spawn | 🔴 CRITICAL |
| `~/.paperclip/instances/default/config.json` | File | Read | 🟡 HIGH |
| `~/.paperclip/instances/default/data/backups/` | Dir | Write | 🟡 MEDIUM |
| Windows Scheduled Tasks API | System | Mutate | 🟡 MEDIUM |
| Chrome browser (7 established connections) | Network | Read | 🟢 LOW |

### Blast Radius Prediction (from initial investigation)

1. **Data desync risk**: Embedded PG crash during backup could corrupt WAL. Mitigated by 30-day backup retention.
2. **Process zombie risk**: Killing port-holding processes may orphan PG child processes. Must use process tree traversal.
3. **Double-start risk**: If watchdog starts a second instance while first recovers, port conflict creates 3101 ghost.
4. **Log rotation risk**: If pino doesn't reopen after rename, logs silently stop. Must verify pino behavior.

### Key Findings

- **72 Node.js processes** consuming 6.8 GB RAM (Paperclip server + all agent heartbeats spawning Gemini CLI sessions)
- **Exit code 0xC0000409** (STATUS_STACK_BUFFER_OVERRUN) found on agent heartbeats — this is a Windows-specific crash, not a Node.js OOM
- **Server started as `paperclipai onboard --yes`** not `paperclipai run` — different entrypoint
- **11 downtime gaps** identified from backup timeline, totaling **~230 hours** of downtime in 14 days
- **Agent error thrashing**: CEO 2 + CTO reset every 60 seconds = 2,880 unnecessary API calls/day
- **Double backup scheduling** after restart: two backup timers running concurrently


---

## Phase 2: Infrastructure Cleanup via Paperclip-Ops

### 3e. Issue Delegation
The following tasks are being delegated to the CEO Agent (`a26e5555-2ce0-4eda-a5d3-fb4a15109612`) via the Paperclip CLI:
1. **Agent Error Thrashing**: Identify and fix/delete agents stuck in an ERROR state loop on the `RxFit` organization (causing database churn and server crashes).
2. **Docker Cleanup**: Remove the unused `paperclip-db` Docker container.
3. **Backup Deduplication**: Clean up double-scheduled backups.

By delegating to the CEO agent, the Paperclip AI org will use its own internal tools (CTO/COO) to resolve its configuration state while the local watchdog process protects the server from crashing during the operation.


## Task 1: Create PowerShell Auto-Restart Watchdog Script

### 3b. Context & Dependency Matrix

| Dependency | Type | Direction | Risk Level |
|-----------|------|-----------|------------|
| `http://127.0.0.1:3100/api/health` | API | Read | 🟢 LOW |
| `Invoke-RestMethod` cmdlet | System | Call | 🟢 LOW |
| `netstat` / `Get-NetTCPConnection` | System | Read | 🟢 LOW |
| `Stop-Process` cmdlet | System | Mutate | 🟡 HIGH |
| `npx paperclipai run` | Process | Spawn | 🔴 CRITICAL |
| Port 3100 ownership | Network | Mutate | 🔴 CRITICAL |
| Port 54329 (embedded PG) | Network | Mutate | 🟡 HIGH |
| `~/.paperclip/instances/default/db/postmaster.pid` | File | Delete | 🟡 HIGH |
| `~/.paperclip/instances/default/logs/watchdog.log` | File | Write | 🟢 LOW |
| `scripts/paperclip/` directory | File | Create | 🟢 LOW |

### 3c. Blast Radius Prediction

1. **Data desync**: Killing the Node process while it's mid-DB-write could leave a transaction uncommitted. PG's WAL handles this — committed transactions survive, uncommitted roll back. Risk: LOW.
2. **Process zombie cascade**: If we `Stop-Process` the node.exe but don't kill its children (postgres.exe, cmd.exe agent runners), they become orphans holding ports. Mitigation: use process tree kill via `Get-WmiObject Win32_Process` to find children by ParentProcessId.
3. **Double-start race condition**: If the health check fails at T=0, watchdog starts restart at T=90s, but the old server recovers at T=91s. Now two servers try to bind port 3100. Mitigation: always kill existing port holders before starting new instance. Add a mutex/lock file.
4. **npx cache staleness**: `npx -y paperclipai run` may pull a new version on restart, causing unexpected behavior changes. Mitigation: use the specific npx cache path already established.
5. **Watchdog self-crash**: If the watchdog PowerShell process itself crashes (OOM, terminal closed), the server has no guardian again. Mitigation: Windows Scheduled Task (Task 3) provides the outer watchdog.

### 3d. Explicit Mitigations

| Risk | Mitigation | Verification |
|------|-----------|-------------|
| Process zombie cascade | Kill process tree: find all children of the node PID via WMI before killing parent | Verify no orphan postgres.exe after restart |
| Double-start race | Check port 3100 occupancy before starting; kill holders if found; use 10s grace period | Verify only one node.exe on port 3100 after restart |
| npx version drift | Use explicit `npx -y paperclipai run` which uses the cached version | Log the version on startup |
| Watchdog self-crash | Outer recovery via Scheduled Task (Task 3) | Verify Task Scheduler shows PaperclipWatchdog |
| PG lock file stale | Delete `postmaster.pid` only when no postgres.exe process is running on port 54329 | Check port 54329 before deleting |

---
