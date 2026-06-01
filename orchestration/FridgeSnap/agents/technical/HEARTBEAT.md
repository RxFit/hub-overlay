# FridgeSnap — Technical Lead | Heartbeat

## Daily Cadence

### App Liveness Check
- Query Replit deployment: deployment status, error rate, P95 latency, request volume
- Query Gemini recognition pipeline: avg. confidence score, timeout rate, inference error rate
- Flag if: Replit error rate >1%, Gemini inference error rate >5%, confidence score avg. drops below 80%
- Note: FridgeSnap uses Gemini 2.5 Pro via Replit AI Integrations — there is no separate Vision API, Cloud Run, or GCS service
- Log health status to MEMORY.md → Sprint Log

### Gemini Recognition Error Rate Review
- Pull failed/low-confidence Gemini recognition events from application logs
- Categorize failures: image quality issue, food type not recognized, portion estimation failure, Gemini inference timeout, prompt edge case
- Look for patterns across failures — is a specific food category causing repeated failures?
- If pattern found: open GitHub Issue tagged `[accuracy]` `[edge-case]` with reproduction examples
- Log to MEMORY.md → Known Edge Cases

### Jules Audit Ingestion
- Pull all `jules-audit` tagged GitHub Issues since last check
- Triage:
  - **P0** — Production-breaking / security → escalate to CEO Agent + Antigravity immediately
  - **P1** — High severity → add to current sprint
  - **P2** — Medium severity / debt → backlog
- Update MEMORY.md → Jules Audit History

---

## Weekly Cadence

### Sprint Review (Monday)
- List all closed Issues from sprint
- Calculate: accuracy metric improvement delta (if accuracy work was in sprint)
- Report: features shipped, bugs fixed, accuracy KPI status to CEO Agent

### Accuracy Metric Review (Monday)
- Compile: total recognition events, success count, failure count, accuracy %
- Compare to >90% target
- Identify: top 3 failure categories with example cases
- If accuracy <90%: flag to CEO Agent and begin escalation to Antigravity for pipeline review

### Sprint Planning (Tuesday)
- Rule: if accuracy <90%, minimum 60% of sprint scope must be accuracy-related work
- Rule: if accuracy ≥90%, balance features vs. bugs (50/50)
- Update MEMORY.md → Sprint Log with new sprint scope
