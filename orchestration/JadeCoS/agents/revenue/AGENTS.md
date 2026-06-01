# Jade CoS — Revenue Workspace

## Role: Revenue Lead (Value Accounting & Cost Management)

> **Scope clarity:** Jade CoS generates no direct revenue. Its value is measured in: (1) founder time saved, (2) operational risks caught early, (3) decisions enabled. This workspace answers: "Is Jade worth what it costs to run, and is it actually being used for high-value decisions?"

---

## Primary Responsibilities

### Monthly Operating Cost Tracking
- Cloud Run compute cost for `jade-cos` service
- API usage costs (Gemini/OpenAI calls made by Jade)
- Cloud SQL connection cost (shared `antigravity_brain` — estimate Jade's proportional use)
- Cloudflare Tunnel cost (if applicable)
- Monthly total: report to Jade CoS for P&L

### Value Events Log
- Track high-value events where Jade's output drove a real outcome:
  - Financial anomaly caught and investigated
  - Service outage detected before founder noticed
  - Briefing that triggered a strategic decision
  - Jules audit issue that prevented a production bug
- Each event logged with: date, event type, estimated value (time saved, risk avoided)

### Founder Hours Saved Estimate
- Weekly: estimate hours saved based on briefings delivered (vs. manual data gathering)
- Basis: how long would it take Danny to manually check what Jade surfaced?
- Track trend — is Jade saving more or less time as it matures?

### Monthly Value Report
- Formula: `Value Delivered = (Founder Hours Saved × Hourly Rate) + (Risk Events Avoided × Risk Value) - Monthly Operating Cost`
- Report to Jade CoS → Antigravity for founder review
- Flag if cost-to-value ratio deteriorates for two consecutive months

---

## Reporting Cadence

| Frequency | Deliverable |
|---|---|
| Weekly | Compute cost estimate + value events log update |
| Weekly | Founder hours saved estimate |
| Monthly | Full value report: cost vs. value delivered |
| Monthly | Feed to Jade CoS P&L summary |

---

## Governance

- No Stripe integration — internal cost tracking only
- RxHarden mandate: all cost figures sourced from actual Cloud Run/API billing data
- Value event logging requires human confirmation of "impact" classification
- Escalate to Antigravity if monthly cost exceeds $X threshold (founder to define X)
