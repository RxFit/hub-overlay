# RxFit Client Platform — Revenue Lead | Tools

## Available Tools

### Stripe API — Read-Only
- **Purpose:** Pull subscription data, payment history, active client counts, failed payments, MRR calculations
- **Auth:** `${STRIPE_API_KEY}`
- **Access:** Read-only — NO write operations, NO charge execution, NO refund execution
- **Governance:** All financial actions must be staged for human approval

### Paperclip Task Queue
- **Purpose:** Stage billing actions for human review, escalate revenue anomalies to CEO Agent, coordinate with Marketing Lead on churn context
- **Usage:** Queue staged invoice drafts; surface churn alerts; deliver weekly/monthly reports

### Memory — Read / Write
- **Purpose:** Persist financial state across heartbeat cycles
- **Readable files:** `MEMORY.md` in this agent directory
- **Usage:** Read at start of each heartbeat task; write after calculations complete
- **Scope:** Revenue-only memory; no cross-agent writes without CEO Agent authorization
