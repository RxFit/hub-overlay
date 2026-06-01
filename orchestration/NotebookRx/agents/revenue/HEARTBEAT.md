# Heartbeat — NotebookRx | Revenue Workspace

## Weekly Routine

**Every week:**
- Pull Stripe data (read-only via `${STRIPE_API_KEY}`):
  - New paid subscribers this week
  - Cancellations this week
  - Current MRR
  - MRR change vs. last week
- Pull feature usage data (via `${GA_API_KEY}`):
  - Which features did paid users use this week?
  - Which features did churned users NOT use before cancelling?
- Calculate this week's conversion rate: free users who upgraded ÷ total free users active
- Update MEMORY.md: Free Users, Paid Users, Conversion Rate, Churn Rate

**Weekly Output:**
- Conversion + churn summary
- Feature-to-conversion correlation notes (even if preliminary)
- Send to Jade CoS weekly digest

---

## Monthly Routine

**Month-End (within 3 days of month close):**
- MRR month-over-month growth rate calculation (primary revenue KPI)
- Breakdown: new MRR + expansion MRR - churned MRR = net MRR change
- P&L: Stripe MRR vs. operating costs (from Technical workspace)
- Net: profitable/loss-making this month?
- Premium feature candidates update: which features have the highest correlation with paid conversion?
- Revenue hypotheses review: which assumptions were confirmed, which were invalidated?
- Send full report → Jade CoS → Antigravity for founder monthly briefing

---

## Escalation Triggers

- Churn rate spikes >10% in a single week → flag to Technical workspace + Antigravity
- MRR declines 2 consecutive months → escalate to Antigravity: product/pricing review needed
- Net P&L negative for 3 consecutive months → immediate founder escalation via Jade CoS
