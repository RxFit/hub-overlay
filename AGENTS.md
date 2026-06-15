# HUB Overlay — Paperclip AI Org

<!-- BEGIN:paperclip-org -->

> This project's Paperclip org runs on the shared local instance at 127.0.0.1:3100.
> All board-level API calls require the board token in `~/.paperclip/auth.json`.
> CLI profile: `hub-local`

> ⚠️ **TWO PAPERCLIP INSTANCES EXIST — do not mix their IDs.**
> 1. **Local instance** (`127.0.0.1:3100`) — the "HUB Overlay" org described in THIS file.
>    Used by Antigravity/CLI workflows and the watchdog scripts in `scripts/paperclip/`.
>    Company `05787964-…`, agents `a26e5555-…` (CEO), `c56e5206-…` (COO), `9eeb28d1-…` (CTO).
> 2. **Cloud Run instance** (`https://api.paperclip.casatrejo.com`) —
>    the "RxFit" org the **Hub web app** (`hub/`) talks to. Its company/agent IDs live in
>    `hub/lib/paperclipConfig.ts` and are DIFFERENT from the IDs below.
>    `railway/paperclip/` is a legacy (Railway) deployment config.
> Issues created from the Hub chat UI land on the Cloud Run instance, NOT this local org.
> 
> *Decision (2026-06-13): We are explicitly KEEPING the local Paperclip instance at 127.0.0.1:3100 as an isolated sandbox for Antigravity's developer tasks, separated from the Hub Web App's production tasks.*

## Instance
- **API Base:** `http://127.0.0.1:3100`
- **Dashboard:** `http://127.0.0.1:3100` → select HUB Overlay
- **CLI Profile:** `hub-local` (active by default)

## Company
- **Company ID:** `05787964-7240-4851-b7df-d006f0d8001c`
- **Display Name:** HUB Overlay
- **Issue Prefix:** HUB

## C-Suite Agents

| Role | Agent ID | Status |
|------|----------|--------|
| **CEO** | `a26e5555-2ce0-4eda-a5d3-fb4a15109612` | Receives ALL issues first |
| **COO** | `c56e5206-5d54-4fe8-95ea-6e5669a7333e` | Operations & audits |
| **CTO** | `9eeb28d1-b8b2-4904-8486-39d8c77da86b` | Code, features, technical |

**Always assign new issues to the CEO first.** The CEO delegates to COO/CTO.

## Org Structure
```
Danny Trejo (Founder — Board Chair)
    └── Antigravity (AI Board Member & Orchestration Layer)
            └── CEO Agent (a26e5555)
                    ├── COO Agent (c56e5206) — ops, audits
                    └── CTO Agent (9eeb28d1) — code, features, infra
```

## Operational Model — Hybrid Execution

```
Is this a simple/quick task? (typo fix, config, lookup)
├── YES → Antigravity executes directly
└── NO → Is this meaningful work? (feature, audit, refactor)
    └── YES → /pre-cog → Create Issue → Assign CEO
              → Monitor (2-3 min polling, alert-only)
              → Report completion → Write Memory log
```

### Task Routing
| Trigger | Route |
|---------|-------|
| Code, bugs, features, infra, devtools | CEO → CTO |
| Operations, audits, processes | CEO → COO |
| Cross-functional or unclear | CEO decides |

### Protocols
- **Meaningful tasks:** Full `/rxharden` protocol (Pre-Cog → Cognitive Ledger → TDD → Hostile Audit)
- **Simple tasks:** Direct execution, no RxHarden
- **Memory:** Antigravity writes all Obsidian memory logs to `Memory/tasks/`
- **Monitoring:** Poll every 2-3 minutes, alert only on blocked/approval/completion

## Restricted Actions (Always Require Human Approval)
- External comms to non-whitelisted recipients
- Any billing mutation
- PR merges (agents can open PRs, humans merge)
- Strategic decisions: pricing, hiring, product direction

## CLI Quick Reference

```bash
# Create issue assigned to CEO
npx -y paperclipai issue create --profile hub-local \
  -C 05787964-7240-4851-b7df-d006f0d8001c \
  --title "..." --description "..." \
  --assignee-agent-id a26e5555-2ce0-4eda-a5d3-fb4a15109612

# List issues
npx -y paperclipai issue list

# List agents
npx -y paperclipai agent list -C 05787964-7240-4851-b7df-d006f0d8001c

# Check dashboard
npx -y paperclipai dashboard
```

## Project Folder
`C:\Users\danie\Documents\antigravity\vibrant-chandrasekhar`

<!-- END:paperclip-org -->
