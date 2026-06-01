# Tools — Jade CoS | Revenue Workspace

## Cost Monitoring

- **Cloud Run cost API / billing console**
  - Use to: pull monthly hosting cost for `jade-cos` service
  - For: monthly operating cost report

- **Cloud SQL cost (proportional)**
  - Use to: estimate Jade's share of `antigravity_brain` DB hosting cost
  - Basis: Jade query volume as % of total DB activity

- **LLM API cost tracking**
  - Auth: `${GEMINI_API_KEY}` (if Jade makes direct LLM calls)
  - Use to: pull token usage and compute cost for Jade's AI queries

## Application Event Logs

- **Jade CoS event log API**
  - Use to: identify and log value events (anomalies caught, decisions enabled, issues surfaced early)
  - For: value events log and founder hours saved estimate

## Memory

- **Agent memory** — persistent MEMORY.md (see MEMORY.md)
  - Read/write: Monthly Hosting Cost, Value Events Log, Decisions Enabled This Month, Issues Caught Early

## Governance

- Read-only access to all cost and log APIs
- No Stripe integration — internal cost tracking only
- RxHarden mandate: all figures sourced from actual billing data
- Value event classifications require human confirmation of impact level
