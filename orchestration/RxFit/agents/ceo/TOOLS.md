# CEO Agent — Tools

> Available tools and access scope. All API credentials accessed via environment variables only — never hardcoded.

---

## 1. Vertex AI Semantic Search — All RxFit Data Stores

- **Purpose:** Query any rxfit-* semantic bucket for context before making decisions or drafting briefings
- **Buckets accessible:**
  - `rxfit-stripe` — revenue, subscriptions, charges
  - `rxfit-gmail` — email signals, client communications
  - `rxfit-gchat` — internal team communications
  - `rxfit-gdrive` — brand documents, reports
  - `rxfit-github` — codebase audit findings
  - `rxfit-analytics` — GA4, traffic, conversion data
  - `rxfit-employees` — team roster, scheduling (read only)
  - `rxfit-clients` — client records, retention signals
  - `rxfit-contracts` — service agreements
  - `rxfit-codebase` — technical architecture context
- **Auth:** `${VERTEX_ENGINE_ID_RXFIT}` — via GCS project `Semantic-Brain-Desktop`
- **Usage:** Read-only. CEO Agent does not write to semantic buckets.

---

## 2. Paperclip Task Queue API

- **Purpose:** Create and read tasks for officer agents (CMO, CTO, CFO, COO)
- **Auth:** `${PAPERCLIP_API_KEY}`
- **Workspaces:**
  - Marketing: `${PAPERCLIP_WS_RXFIT_MARKETING}`
  - Technical: `${PAPERCLIP_WS_RXFIT_TECHNICAL}`
  - Revenue: `${PAPERCLIP_WS_RXFIT_REVENUE}`
- **Permitted operations:** Create task, read task status, add comment, mark complete

---

## 3. Google Chat Webhook — Internal Only

- **Purpose:** Post weekly briefing and urgent flags to internal RxFit chat
- **Auth:** `${GOOGLE_CHAT_WEBHOOK_URL}`
- **Constraints:** Internal RxFit space ONLY. No external recipients. External comms require human approval.

---

## 4. GitHub Issues API — Read

- **Purpose:** Read Jules audit issues tagged `jules-audit` for situational awareness
- **Auth:** `${GITHUB_TOKEN}`
- **Permitted operations:** List issues, read issue body, read labels
- **Write:** CEO Agent does NOT write GitHub Issues (CTO Agent owns that)

---

## 5. Memory File Read/Write

- **Purpose:** Persist decisions, patterns, and state across sessions
- **Files:**
  - `agents/ceo/MEMORY.md` — own memory (read/write)
  - `agents/cmo/MEMORY.md` — officer memory (read only)
  - `agents/cto/MEMORY.md` — officer memory (read only)
  - `agents/cfo/MEMORY.md` — officer memory (read only)
  - `agents/coo/MEMORY.md` — officer memory (read only)
  - `KPI.json` — read + update actuals fields


---

## 6. Paperclip Backend API � Full Operational Reference

- **File:** `PAPERCLIP_OPS.md` (in this instructions directory)
- **Purpose:** Complete HTTP endpoint reference, workspace IDs, agent IDs, error handling, and escalation triggers for autonomous Paperclip management
- **REQUIRED READING** on initialization before taking any action
