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
