# COO Agent — Tools

> All API credentials accessed via environment variables. Never hardcoded.

---

## 1. ALL rxfit-* Semantic Buckets — Full Access

- **Purpose:** Full operational intelligence across every data store
- **Auth:** `${VERTEX_ENGINE_ID_RXFIT}` — GCS project `Semantic-Brain-Desktop`
- **Buckets accessible:**
  - `rxfit-stripe` — billing context, subscription status
  - `rxfit-gmail` — client/vendor email signals
  - `rxfit-gchat` — internal team communications
  - `rxfit-gdrive` — SOPs, brand docs, operational docs
  - `rxfit-github` — technical status awareness
  - `rxfit-analytics` — traffic/marketing signals for operational context
  - `rxfit-employees` — per-person records: schedules, roles, contractor status, performance signals
  - `rxfit-clients` — client records, escalation context, retention signals
  - `rxfit-contracts` — contract status, renewal dates, compliance flags
  - `rxfit-codebase` — platform status awareness
- **Access:** Read only for all stores. Write to `rxfit-employees` requires human approval.

---

## 2. rxfit-employees — Per-Person Records (Special Access)

- **Purpose:** Advisor and contractor scheduling, invoice readiness, performance context
- **Auth:** `${VERTEX_ENGINE_ID_RXFIT}`
- **Sensitivity:** HIGH — contains personal and financial records for real employees and contractors
- **Constraint:** Any write or mutation to employee records requires human approval before execution
- **Permitted reads:** Schedule, role, status, invoice due dates, session logs

---

## 3. Google Chat Webhook — Internal Only

- **Purpose:** Post internal coordination messages and operational alerts to the RxFit team space
- **Auth:** `${GOOGLE_CHAT_WEBHOOK_URL}`
- **Constraint:** Internal RxFit recipients ONLY. Any message to a non-RxFit recipient requires Antigravity → Danny approval.
- **Auto-approved use cases:** Advisor scheduling coordination, internal ops updates, status alerts

---

## 4. Gmail API — Read Only

- **Purpose:** Read incoming email for client signals, vendor communications, and operational flags
- **Auth:** `${GMAIL_API_KEY}`
- **Permitted operations:** List recent messages, read message body, extract sender/subject/date
- **NEVER:** COO Agent does not send emails directly — all email responses route through Comms Agent → Antigravity → Danny

---

## 5. Paperclip Task Queue API

- **Purpose:** Create operational tasks, route contractor invoice approvals for human review, log external comms staging
- **Auth:** `${PAPERCLIP_API_KEY}`
- **Workspace:** `${PAPERCLIP_WS_RXFIT_REVENUE}` (for billing/contractor) + `${PAPERCLIP_WS_RXFIT_MARKETING}` (for client ops)
- **Permitted operations:** Create task, read status, mark complete

---

## 6. Memory File Read/Write

- **Files:**
  - `agents/coo/MEMORY.md` — own memory (read/write): full ops state
  - All other agent `MEMORY.md` files — read only (COO sees the full company)
  - `KPI.json` — update operations actuals (advisor utilization, client retention)
