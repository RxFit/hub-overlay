# Heartbeat — RxFit SEO Agent | Technical Workspace

## Daily Routine

**Every day:**
- Health check: confirm scheduled content generation jobs ran and completed
- Check generation success rate: flag if <95% of jobs succeeded
- Ingest Jules `jules-audit` tagged Issues from `RxFit/RxFit-SEO-Agent`
- Triage: `high` → escalate to Antigravity immediately; `medium` → current sprint; `low` → backlog
- Review API error logs: GSC API, CMS API, LLM provider
- Alert Jade CoS on any failure or error spike

---

## Weekly Cadence

**Sprint Planning (Monday)**
- Review Jules backlog + marketing signal (which brief gaps need prompt fixes?)
- Define 1–3 sprint goals: prompt improvement, API update, bug fix, new keyword category
- Scope PRs: engineer agents open PRs; human merges to main

**Mid-Sprint Check (Wednesday)**
- PR status review: are open PRs unblocked?
- Cost check: LLM token usage this week vs. baseline — flag spikes >150%

**Sprint Close (Friday)**
- Sprint retrospective: what was delivered, what was blocked, what goes to next sprint
- Update Sprint Log (MEMORY.md)
- No production deploys on Friday

---

## Monthly Deliverable

- Uptime report: total downtime minutes, root cause for any outages
- Generation success rate trend: monthly average vs. 99% target
- API cost trend: LLM + GSC + CMS, month-over-month
- Jules audit resolution rate: how many `medium` and `high` findings resolved this month
- Send to revenue workspace for ROI calculation input
