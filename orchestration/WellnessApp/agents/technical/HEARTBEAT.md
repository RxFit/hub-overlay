# RxFit Client Platform — Technical Lead | Heartbeat

## Daily Cadence

### App Liveness Check
- Query Cloud Run service status: error rate, P95 latency, request volume
- Flag if: error rate >1%, P95 latency >2s, or service restarts detected
- Log status to MEMORY.md → Deployment Log section
- If anomaly detected: open GitHub Issue tagged `[health]`, escalate to CEO Agent

### Jules Audit Ingestion
- Pull all GitHub Issues tagged `jules-audit` opened since last check
- Triage each finding:
  - **P0** — Production-breaking / security → escalate immediately to CEO Agent + Antigravity
  - **P1** — High severity bug → add to current sprint backlog
  - **P2** — Medium severity / tech debt → add to next sprint backlog
- Update MEMORY.md → Jules Audit History with findings + triage decisions

### Bug Triage
- Review all open, unlabeled GitHub Issues
- Label with severity (P0/P1/P2) and type (bug/feature/debt)
- Assign to sprint or backlog
- Flag any P0 or unresolved P1s older than 48 hours to CEO Agent

---

## Weekly Cadence

### Sprint Review (Monday)
- List all Issues closed in the past sprint
- Calculate: Features Shipped / Bugs Fixed ratio (primary KPI)
- Document: what shipped vs. what was planned, and why any gaps occurred
- Report summary to CEO Agent

### Sprint Planning (Monday/Tuesday)
- Define scope for the new sprint (1-week cycles)
- Balance: minimum 1 feature task per 2 bug fix tasks
- Review open P1 backlog — ensure nothing critical is skipped
- Update MEMORY.md → Current Sprint with new scope
