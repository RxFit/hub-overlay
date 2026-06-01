# CTO Agent — Daily Technical Heartbeat

> **Cadence:** Daily (weekdays) + Weekly sprint (Monday) + Monthly architecture audit · **Owner:** CTO Agent

---

## Pre-Flight
- [ ] Load `KPI.json` — read technical target (uptime %, error rate)
- [ ] Load `MEMORY.md` — review current sprint tasks and open Jules issues

---

## Daily Liveness Checks
- [ ] Verify Cloud Run health endpoint: rxfit.co (`/health` or equivalent)
- [ ] Verify Cloud Run health endpoint: rxfit.ai (`/health` or equivalent)
- [ ] Check error rate (5xx %) — flag if > 0.1%
- [ ] Check P95 response latency — flag if > 2000ms
- [ ] Update `KPI.json` uptime actual if daily check changes rolling average

## Daily Jules Audit Ingestion
- [ ] Pull GitHub Issues opened since last run — filter label: `jules-audit`
- [ ] For each new issue, classify severity:
  - `severity:low` → Add to Paperclip task queue (Lead Engineer Agent)
  - `severity:medium` → Task queue + flag for Monday CEO briefing
  - `severity:high` → **Immediately escalate to Antigravity** — do not wait for Monday
  - `type:architectural` → **Immediately escalate to Antigravity**
- [ ] Log all new Jules issues in `MEMORY.md` (Jules Audit History)
- [ ] Update `KPI.json` open high-severity issues count

---

## Weekly Sprint Cycle (Every Monday)
### Sprint Review
- [ ] List tasks completed last sprint (✅) vs. blocked (🚧)
- [ ] For blocked items: identify root cause — dependency, scope, personnel, environment
- [ ] Log blockers to CEO Agent Monday briefing

### Sprint Planning
- [ ] Set top 3 tasks for the week — each with: owner, definition of done, estimated completion
- [ ] Estimate token/compute cost for planned AI-assisted work
- [ ] Confirm with DevOps Agent: any deployment windows needed?

---

## Monthly Architecture Audit (1st Monday of Month)
- [ ] Review tech debt log in `MEMORY.md` — is any item now urgent?
- [ ] Check dependency versions — flag any with known CVEs or major-version lag > 2
- [ ] Review exposed public endpoints — confirm all have auth or rate limiting
- [ ] Review API key rotation status — flag any key > 90 days without rotation
- [ ] Route architecture audit summary to CEO Agent + Antigravity

---

## Post-Flight
- [ ] Update `MEMORY.md` — Jules audit log, sprint status, any new tech debt
- [ ] Report to CEO Agent: liveness status, Jules findings summary, sprint status
