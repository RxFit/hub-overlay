# CTO Agent — Tools

> All API credentials accessed via environment variables. Never hardcoded.

---

## 1. rxfit-github — Vertex AI Semantic Search (All 5 Buckets)

- **Purpose:** Search all RxFit GitHub repositories for code context, architecture patterns, and dependency information
- **Auth:** `${VERTEX_ENGINE_ID_RXFIT}` — GCS project `Semantic-Brain-Desktop`
- **Buckets:** rxfit-github-1 through rxfit-github-5 (all accessible)
- **Primary use cases:** Context for Jules triage, sprint planning, architecture review
- **Access:** Read only

---

## 2. rxfit-codebase — Vertex AI Semantic Search

- **Purpose:** Search the rxfit codebase semantic bucket for service maps, infrastructure definitions, and deployment configurations
- **Auth:** `${VERTEX_ENGINE_ID_RXFIT}`
- **Primary use cases:** Architecture audit, understanding system dependencies before making changes
- **Access:** Read only

---

## 3. GitHub Issues API — Read/Write

- **Purpose:** Ingest Jules audit findings, create follow-up issues, update issue labels and status
- **Auth:** `${GITHUB_TOKEN}`
- **Permitted operations:**
  - List issues (filter by label: `jules-audit`)
  - Read issue body and comments
  - Create new issues
  - Add labels and comments
  - Close issues (when resolved)
- **Constraint:** CTO Agent does NOT merge PRs or push code directly

---

## 4. Cloud Run Metrics API

- **Purpose:** Pull uptime, error rates, latency, and instance scaling data for rxfit.co and rxfit.ai services
- **Auth:** `${GOOGLE_CLOUD_API_KEY}` — GCS project `Semantic-Brain-Desktop`
- **Primary use cases:** Daily liveness checks, KPI uptime tracking
- **Permitted operations:** Read metrics, read logs (structured log query)

---

## 5. Paperclip Task Queue API

- **Purpose:** Create and manage engineering tasks for Lead Engineer Agent, QA Agent, DevOps Agent
- **Auth:** `${PAPERCLIP_API_KEY}`
- **Workspace:** `${PAPERCLIP_WS_RXFIT_TECHNICAL}`
- **Permitted operations:** Create task, set priority, assign agent, read status, mark complete

---

## 6. Memory File Read/Write

- **Files:**
  - `agents/cto/MEMORY.md` — own memory (read/write)
  - `KPI.json` — update technical actuals (uptime %, error rate, open Jules issues)
