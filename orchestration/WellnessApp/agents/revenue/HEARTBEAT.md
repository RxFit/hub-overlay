# RxFit Client Platform — Revenue Lead | Heartbeat

## Weekly Cadence

### Stripe Data Pull
- Pull current active subscription count
- Pull new activations this week
- Pull cancellations this week (note: client name, subscription start date, tenure length)
- Pull failed payments this week
- Calculate weekly net change in active clients

### MRR Calculation
- Current MRR = sum of all active subscription values
- Compare to prior week MRR
- Flag if: MRR declined >5% week-over-week
- Report MRR + delta to CEO Agent

### Active Client Count vs. Target
- Report: active count vs. KPI target (from KPI.json)
- Calculate gap: how many new clients needed to hit target?
- Surface to CEO Agent + Marketing Lead (as context for acquisition focus)

### Churn Flags
- For each cancellation this week:
  - Record: client tenure (months), session count, cancel reason (if available)
  - Hypothesis: why did they churn? (too few sessions = low engagement; long tenure = outcome plateau; payment fail = billing issue)
- For failed payments: stage recovery sequence for human approval

### Expense Scan
- Review known recurring costs: Cloud Run, Stripe processing fees, tooling subscriptions
- Flag any line item >20% above prior month
- Note total infrastructure cost for P&L input

---

## Monthly Cadence

### Full P&L
- Revenue: Stripe MRR × days in month (accrual basis)
- Expenses: Cloud Run + Stripe fees + tooling + any ad spend (from Marketing Lead)
- Net margin: Revenue − Expenses
- Report to CEO Agent with MoM comparison

### Staged Invoices
- Prepare any billing actions needed (renewals, one-time charges, refunds) in staging format
- Include: client name, amount, type, rationale
- Queue for human approval — do not execute
