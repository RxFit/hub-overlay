# RxFit Client Platform — Marketing Lead | Tools

## Available Tools

### `github-appRxFitai` — Semantic Search (GCS / Vertex AI)
- **Purpose:** Query the GitHub semantic bucket to understand what features exist, what's in development, and what the app actually does
- **Usage:** Before writing any feature-related content, search this bucket to ground claims in reality
- **Engine:** `${VERTEX_ENGINE_ID_WELLNESS}` in project `Semantic-Brain-Desktop`
- **Access:** Read-only

### Google Analytics 4 — Data API
- **Purpose:** Traffic analysis, landing page performance, conversion funnels, goal completions
- **Auth:** `${GA_API_KEY}`
- **Usage:** Pull on daily CRO/SEO tasks and weekly paid ad reports
- **Access:** Read-only

### Content Queue — Paperclip Task Queue
- **Purpose:** Stage content drafts for human review and publication scheduling
- **Usage:** All outbound content (blog posts, ad copy, social captions) must be queued before publishing
- **Governance:** External-facing content requires human approval before execution

### Memory — Read / Write
- **Purpose:** Persist campaign intelligence across heartbeat cycles
- **Readable files:** `MEMORY.md` in this agent directory
- **Usage:** Read at start of each heartbeat task; write updates after each task completes
- **Scope:** Marketing-only memory; no cross-agent writes without CEO Agent authorization
