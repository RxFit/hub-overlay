# Heartbeat — NotebookRx | Technical Workspace

## Daily Routine

**Every day:**
- App liveness check: confirm NotebookRx service is responding
- Jules audit ingestion: check `RxFit/notebookrx` for new `jules-audit` tagged GitHub Issues
- Triage: `high` → escalate to Antigravity immediately; `medium` → sprint; `low` → backlog
- Review any in-app AI insight quality feedback from the previous day
- Log in MEMORY.md: AI Insight Quality Score update (if new feedback exists)

---

## Weekly Cadence

**Monday — Sprint Planning**
- Review Jules backlog + marketing feedback (what are users saying about insight quality?)
- Define sprint experiment: one primary hypothesis ("if we change prompt X, insight quality improves by Y")
- Define measurement: how will we know if the experiment succeeded?
- Scope PRs: engineer agents open PRs; human executes merge to main

**Wednesday — Insight Quality Review**
- Pull sample of AI insights generated this week
- Evaluate: accurate? specific? actionable? or generic and safe?
- Identify failure patterns: hallucination instances, over-generalization, missed correlations
- Document in MEMORY.md: Current AI Model/Prompt Version + findings

**Friday — Sprint Close**
- Experiment result: did the hypothesis hold?
- Document result (even if negative) in Pattern Detection Results (MEMORY.md)
- Sprint Log update
- No schema changes or production deploys without Antigravity review

---

## Monthly Routine

- AI Insight Quality Score trend: improving or degrading?
- pgvector embedding freshness audit: are embeddings current for all note data?
- Model cost vs. insight quality summary → revenue workspace
- Privacy audit: health data access log review
