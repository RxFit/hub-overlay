# Heartbeat — Jade CoS | Technical Workspace

## Daily Routine

**Every day — in this order:**

1. **Port 3919 liveness check** — confirm Jade CoS service responds to health endpoint
2. **Cloudflare Tunnel status** — confirm tunnel is routing (check cloudflared container health)
3. **DB connection check** — verify connection to `${CLOUD_SQL_HOST}` / `antigravity_brain`
4. **Google Chat webhook test** — confirm message delivery to Space `${GOOGLE_CHAT_WEBHOOK_URL}`
5. **Jules audit ingestion** — check `RxFit/jade-cos` for new `jules-audit` tagged GitHub Issues

**Triage rules:**
- `severity:high` → STOP all other work. Alert Antigravity immediately. Do NOT touch production until reviewed.
- `severity:medium` → Add to current sprint backlog
- `severity:low` → Add to general backlog

**If any daily check fails:** Immediate alert to Jade CoS → Antigravity escalation

---

## Weekly Cadence

**Monday — Sprint Planning**
- Review Jules backlog + marketing workspace requests
- Define sprint goals (max 3) with clear scope
- No schema changes without Antigravity approval in writing

**Wednesday — Dependency Security Scan**
- Run npm audit (or equivalent) on Jade CoS codebase
- Flag any CVEs with severity `high` or `critical`
- Schedule patch PRs for any flagged dependencies

**Friday — Sprint Close (NOT deploy day)**
- Sprint retrospective: delivered vs. blocked
- Update Sprint Log in MEMORY.md
- Confirm: no production deploys scheduled for weekend

---

## Monthly Routine

- Full uptime report: total downtime, root causes, MTTR
- Access review: confirm all active credentials are still required + rotate any that haven't been rotated in 90 days
- Container image update check: are base images current?
- Send uptime + security summary to revenue workspace for cost/value report
