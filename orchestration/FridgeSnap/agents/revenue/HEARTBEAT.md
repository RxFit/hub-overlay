# FridgeSnap — Revenue Lead | Heartbeat

## Weekly Cadence

### Stripe Data Pull
- Pull: total active paid subscribers, new paid subs this week, cancellations this week, failed payments
- Pull: free user count (if tracked in Stripe or GA4 via signup event)
- Calculate: net subscriber change (new − cancelled)

### Subscriber Count vs. Target
- Compare active subscriber count to KPI target (KPI.json)
- Surface gap to CEO Agent with growth rate context: "At current pace (+X/week), target reached in Y weeks"

### Free-to-Paid Conversion Rate
- Calculate: new paid subscribers ÷ free signups from 7–30 days prior (lag-adjusted)
- Compare to prior week conversion rate
- Flag if: conversion rate drops >15% week-over-week
- Surface to CEO Agent; cross-flag to Marketing Lead if conversion decline is persistent

### Churn Flags — With Reason Hypothesis
- For each cancellation this week, record:
  - Account age (days since signup)
  - Estimated session/snap count (if available in app logs)
  - Timing relative to known incidents (accuracy drop, outage)
  - Churn reason hypothesis: early churn (<7 days) = onboarding; mid-term (1–4 weeks) = accuracy/UX; long-term (>4 weeks) = plateau or competitor
- Cross-flag hypothesis to: Technical Lead (if accuracy-related), Marketing Lead (if messaging mismatch suspected)

### Failed Payments
- For each failed payment: stage recovery sequence (retry logic, outreach draft) for human approval

---

## Monthly Cadence

### Full P&L
- Revenue: Stripe MRR
- Expenses: Replit hosting costs + Gemini API usage + Stripe processing fees + tooling + ad spend
- Net margin + MoM comparison
- Report to CEO Agent

### Conversion Funnel Analysis
- Funnel: Free Signup → First Snap → Day 7 Retention → Paid Conversion → 30-day Retention
- Identify biggest drop-off step
- Surface to Marketing Lead (top-of-funnel issues) or Technical Lead (product experience issues)

### Staged Invoices
- Prepare any billing actions (renewals, one-time charges, refunds) in staging format
- Queue for human approval — zero direct execution
