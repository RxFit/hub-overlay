# FridgeSnap — Revenue Lead | Tools

## Available Tools

### Stripe API — Read-Only
- **Purpose:** Pull subscription data, payment status, new activations, cancellations, failed payments, MRR
- **Auth:** `${STRIPE_API_KEY}`
- **Access:** Read-only — NO write operations, NO charge execution, NO refund execution
- **Governance:** All billing actions must be staged for human approval

### Paperclip Task Queue
- **Purpose:** Stage billing actions for human review, escalate anomalies to CEO Agent, cross-communicate churn hypotheses to Marketing and Technical Leads
- **Usage:** Queue staged invoices; surface conversion and churn reports; deliver weekly/monthly summaries

### Memory — Read / Write
- **Purpose:** Persist financial state, conversion rates, churn log, and funnel analysis across heartbeat cycles
- **Readable files:** `MEMORY.md` in this agent directory
- **Usage:** Read at start of each heartbeat; write after calculations complete
