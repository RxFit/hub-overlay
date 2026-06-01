# CFO Agent — Tools

> All API credentials accessed via environment variables. Never hardcoded.

---

## 1. rxfit-stripe — Vertex AI Semantic Search

- **Purpose:** Query all RxFit Stripe data: charges, refunds, subscriptions, customers, invoices
- **Auth:** `${VERTEX_ENGINE_ID_RXFIT}` — GCS project `Semantic-Brain-Desktop`
- **Primary use cases:** MRR calculation, churn analysis, expense tracking, anomaly detection
- **Access:** Read only — no mutations via semantic search

---

## 2. rxfit-clients — Vertex AI Semantic Search

- **Purpose:** Cross-reference client records for billing reconciliation — verify every Stripe customer maps to a real, active client record
- **Auth:** `${VERTEX_ENGINE_ID_RXFIT}`
- **Primary use cases:** Monthly subscription reconciliation, churn verification
- **Access:** Read only. No PII extraction — use for reconciliation only.

---

## 3. Stripe API — Read Only

- **Purpose:** Direct Stripe API access for real-time subscription status, charge history, and customer data
- **Auth:** `${STRIPE_API_KEY}` — read-only Stripe key (restricted key, no write permissions)
- **Permitted operations:**
  - `GET /v1/subscriptions` — list all active subscriptions
  - `GET /v1/charges` — list recent charges
  - `GET /v1/customers` — read customer records
  - `GET /v1/invoices` — read invoice status
- **NEVER:** CFO Agent does NOT use a Stripe write-enabled key. Billing mutations are human-executed.

---

## 4. Paperclip Task Queue API — Billing Staging

- **Purpose:** Stage all billing documents for human review and execution
- **Auth:** `${PAPERCLIP_API_KEY}`
- **Workspace:** `${PAPERCLIP_WS_RXFIT_REVENUE}`
- **Permitted operations:** Create staging task (labeled BILLING_STAGING), attach billing detail, read status
- **Constraint:** All billing tasks created by CFO Agent are marked as requiring human approval before execution

---

## 5. Memory File Read/Write

- **Files:**
  - `agents/cfo/MEMORY.md` — own memory (read/write)
  - `KPI.json` — update revenue actuals only (MRR, churn rate, gross margin)
