# CEO Agent — Weekly Heartbeat

> **Cadence:** Every Monday · **Owner:** CEO Agent · **Output:** Company Briefing → Antigravity

---

## Pre-Flight (Run First)
- [ ] Load `PROJECT.md` — confirm mission alignment
- [ ] Load `KPI.json` — read all primary and secondary targets + prior actuals
- [ ] Read all four officer agent weekly reports (CMO, CTO, CFO, COO)
- [ ] Load `MEMORY.md` — review last week's decisions and open items

## Step 1 — KPI Actuals vs Targets
- [ ] Pull current MRR actual (from CFO report + Stripe)
- [ ] Pull organic traffic + qualified leads actual (from CMO report)
- [ ] Pull platform uptime + Jules open issues (from CTO report)
- [ ] Pull trainer utilization + client escalations (from COO report)
- [ ] Flag any KPI that is > 10% below target → mark as "at risk"
- [ ] Flag any KPI that is > 25% below target → mark as "escalate to Antigravity"

## Step 2 — Cross-Department Blockers
- [ ] Identify top 3 blockers that span more than one department
- [ ] For each: name the cause, name the owner, propose resolution path
- [ ] If resolution requires human decision → flag for Step 5

## Step 3 — Draft Weekly Company Briefing
Format:
```
## RxFit Weekly Briefing — [DATE]

### KPIs
- MRR: [actual] vs [target] — [status]
- Organic Leads: [actual] vs [target] — [status]
- Platform Uptime: [actual] vs [target] — [status]

### Top 3 Blockers
1. [Blocker] — Owner: [agent] — Proposed resolution: [...]
2. ...
3. ...

### Decisions Needed from Danny
- [Decision item]

### Recommended Priorities This Week
1. [Priority]
2. [Priority]
3. [Priority]
```

## Step 4 — Assign Weekly Department Objectives
- [ ] CMO: set top 2 content priorities for the week
- [ ] CTO: confirm sprint goal and top 3 tasks
- [ ] CFO: confirm weekly financial pull scope
- [ ] COO: flag any scheduling or client escalation items

## Step 5 — Governance Check
- [ ] Any external comms pending? → Route to Antigravity
- [ ] Any Stripe staging actions ready for human execution? → Notify Danny
- [ ] Any strategic decision or employee record change? → Escalate

## Post-Flight
- [ ] Route briefing to Antigravity via Paperclip
- [ ] Update `MEMORY.md` — log key decisions, patterns, open items
- [ ] Update `KPI.json` actuals fields if not already updated by officers
