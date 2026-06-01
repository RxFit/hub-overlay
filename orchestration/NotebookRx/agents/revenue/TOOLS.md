# Tools — NotebookRx | Revenue Workspace

## Billing

- **Stripe API** (read-only)
  - Auth: `${STRIPE_API_KEY}`
  - Use to: pull subscriber counts (free vs. paid), MRR, churn events, subscription history
  - Key queries: new MRR, churned MRR, net MRR, conversion events, cancellation reasons
  - **CRITICAL:** Read-only. All charge execution requires human. Staging for billing tests.

## Analytics

- **Google Analytics 4 API**
  - Auth: `${GA_API_KEY}`
  - Use to: pull feature usage data, session behavior, funnel drop-off points
  - For: feature-to-conversion correlation analysis

## Memory

- **Agent memory** — persistent MEMORY.md (see MEMORY.md)
  - Read/write: Free Users, Paid Users, Conversion Rate, Churn Rate, Features Driving Conversions, Revenue Hypotheses

## Governance

- Stripe access is **strictly read-only** — `${STRIPE_API_KEY}` scoped to read permissions only
- RxHarden mandate: all revenue figures sourced directly from Stripe API — no estimates or manual entry
- Billing changes require human execution in Stripe dashboard after agent recommendation
- Revenue hypotheses documented before testing — no untested assumptions in reports
