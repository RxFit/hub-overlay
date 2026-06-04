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

---

# CEO Pulse Audit

> **Cadence:** Every 4 hours (configurable in `context_config.json` → `ceo_pulse_cadence_hours`) · **Output:** Structured `CEO_PULSE` record → Paperclip memory + Hub Right Panel feed

This is a SILENT audit. Do not message the human unless escalation criteria are met.

## Pulse Pre-Flight
- [ ] Load `KPI.json` — read all primary targets and last-known actuals
- [ ] Load `MEMORY.md` — review last CEO Pulse findings
- [ ] Pull last 10 completed tasks per C-Suite agent from Paperclip

## Pulse Step 1 — Score Each Department
For each C-Suite agent (CMO, CTO, CFO, COO), evaluate:
1. **Output volume** — are tasks completing at the expected cadence?
2. **KPI trajectory** — is the relevant KPI moving toward target?
3. **Quality signals** — any repeated errors, revisions, or blocked tasks?

Assign a status per department:
- `ON_TRACK` — KPI on or ahead of target, tasks completing normally
- `DRIFTING` — KPI 10–25% below target OR task completion rate dropping
- `CRITICAL` — KPI > 25% below target OR tasks failing repeatedly

## Pulse Step 2 — Corrective Actions (Silent)
For each `DRIFTING` department:
- [ ] Generate a corrective task and inject it into that agent's Paperclip queue
- [ ] Log the corrective action in `MEMORY.md`
- [ ] Write to CEO_PULSE record: `{ role, status: 'DRIFTING', corrective_action, timestamp }`

For each `CRITICAL` department:
- [ ] Same as DRIFTING, PLUS escalate to human (create a `needs_you` feed item in the Hub)
- [ ] Write to CEO_PULSE record: `{ role, status: 'CRITICAL', escalated: true, timestamp }`

For each `ON_TRACK` department:
- [ ] Write to CEO_PULSE record: `{ role, status: 'ON_TRACK', timestamp }`

## Pulse Step 3 — Write CEO_PULSE Record
Output a structured record to Paperclip memory in this exact format:
```json
{
  "pulse_id": "[ISO timestamp]",
  "org": "[ORG_NAME]",
  "global_health_pct": [0-100],
  "departments": [
    { "role": "cmo", "status": "ON_TRACK|DRIFTING|CRITICAL", "kpi_actual": "...", "kpi_target": "...", "last_task": "...", "corrective_action": null | "..." },
    { "role": "cto", "status": "...", ... },
    { "role": "cfo", "status": "...", ... },
    { "role": "coo", "status": "...", ... }
  ],
  "escalations": [],
  "next_pulse_scheduled": "[ISO timestamp]"
}
```

## Pulse Escalation Criteria (Human Notification)
ONLY create a `needs_you` feed item when:
- Any department has been `CRITICAL` for 2 consecutive pulse cycles
- A C-Suite agent's tasks are failing with no clear resolution path
- A task requires external communications or billing approval

Do NOT escalate for: first-time drift, temporary slowdowns, or normal operational variance.
