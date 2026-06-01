# CFO Agent — Weekly Revenue Heartbeat

> **Cadence:** Weekly (every Monday) + Monthly P&L (first Monday) · **Owner:** CFO Agent

---

## Pre-Flight
- [ ] Pull latest from `rxfit-stripe` semantic bucket (last 7 days of charges, refunds, subscription events)
- [ ] Load `KPI.json` — read revenue MRR target and last actual
- [ ] Load `MEMORY.md` — read current MRR, active subscriptions count, pending staged invoices

---

## Weekly Revenue Analysis
- [ ] Calculate current MRR:
  - Kickstart active count × $49
  - Committed active count × $40.83 (normalized monthly from $490/yr)
  - Sum = current MRR
- [ ] Compare MRR to `KPI.json` target — flag if > 5% below
- [ ] Identify top 3 expense categories (trainer pay, infrastructure, marketing/platform)
- [ ] Flag any subscriptions past_due or inactive > 30 days — list by client name
- [ ] Scan for any charges or refunds that don't match a verified rxfit-clients record → flag as reconciliation error
- [ ] Identify 1 margin improvement opportunity (expense reduction or upsell opportunity)

## Billing Staging (Weekly)
- [ ] Compile list of any renewals, overdue notices, or new charges due this week
- [ ] Stage each in Paperclip task queue with: client name, amount, description, Stripe customer ID
- [ ] Mark all as STAGING — awaiting human execution
- [ ] Flag any staged charge > $500 for explicit Danny confirmation
- [ ] Report staged billing summary to CEO Agent

---

## Monthly P&L — First Monday of Month
- [ ] Pull full prior month from `rxfit-stripe`
- [ ] Calculate: Total Revenue (MRR + one-time Transformation payments)
- [ ] Calculate: COGS (trainer pay + chef/nutritionist fees + Cloud Run infra + platform subscriptions)
- [ ] Calculate: Gross Margin % = (Revenue − COGS) / Revenue
- [ ] Reconcile: every active Stripe subscription → verify corresponding rxfit-clients record
- [ ] Churn: list all subscriptions cancelled in month, calculate monthly churn rate
- [ ] Stage all client invoices for the month in Paperclip → human executes
- [ ] Route full P&L summary to CEO Agent

---

## Governance Reminder (Every Run)
- ALL billing documents → STAGING ONLY
- Charges > $500 → flag for explicit Danny confirmation before staging
- Refunds → stage for human review, NEVER issue directly

---

## Post-Flight
- [ ] Update `KPI.json` — revenue MRR actual, churn rate actual
- [ ] Update `MEMORY.md` — current MRR, active subs, pending staged invoices, P&L snapshot
- [ ] Report to CEO Agent: MRR vs target, top expense, churn signal, staged billing count
