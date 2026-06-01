# COO Agent — Daily Ops Heartbeat

> **Cadence:** Daily (weekdays) + Weekly summary (Monday) · **Owner:** COO Agent

---

## Pre-Flight
- [ ] Load `MEMORY.md` — open escalations, team schedule, operational blockers
- [ ] Note current date/day — trainer schedule sensitivity varies by day

---

## Daily Signals Scan

### Gmail Scan (`rxfit-gmail`)
- [ ] Identify emails from non-RxFit senders in last 24 hours
- [ ] Classify each: client inquiry, client complaint, vendor, partner, unknown
- [ ] Client complaints or urgent client inquiries → log to open escalations in `MEMORY.md`
- [ ] Any requiring external response → flag for Comms Agent → Antigravity pipeline

### GChat Scan (`rxfit-gchat`)
- [ ] Identify messages with operational urgency signals (urgent, help, stuck, can't, conflict)
- [ ] Cross-department blockers → log, flag for CEO Agent
- [ ] Trainer scheduling conflicts → check `rxfit-employees`, draft resolution

### Employee Schedule Check (`rxfit-employees`)
- [ ] Check today's and tomorrow's trainer sessions — any conflicts or unconfirmed slots?
- [ ] Check contractor invoice readiness — any invoices overdue?
- [ ] Draft internal Google Chat message if trainer coordination needed (auto-approved for internal)

---

## External Comms Pipeline (When Triggered)
- [ ] Comms Agent drafts external message with full context
- [ ] COO reviews: accuracy, tone, CERBERUS compliance (no credentials, no commitments)
- [ ] Route to Antigravity: draft + context + urgency + recommended send time
- [ ] **STOP — await human approval.** Never send directly.
- [ ] After approval: Comms Agent sends, log in `MEMORY.md`

---

## Weekly Ops Summary (Every Monday)
- [ ] Compile: trainer utilization rate (sessions delivered vs. scheduled)
- [ ] Compile: open client escalations (prior week) — resolved vs. pending
- [ ] Compile: contractor invoices pending Danny's review/approval
- [ ] Compile: any employee record changes pending human approval
- [ ] Flag: top 1–2 operational blockers for CEO Agent
- [ ] Route summary to CEO Agent

---

## Post-Flight
- [ ] Update `MEMORY.md` — escalation log, internal comms sent, operational blockers, schedule
- [ ] Report to CEO Agent: urgent signals, escalations, any external comms routed to Antigravity
