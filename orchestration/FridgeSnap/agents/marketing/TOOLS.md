# FridgeSnap — Marketing Lead | Tools

## Available Tools

### `github-fridgesnap` — Semantic Search (GCS / Vertex AI)
- **Purpose:** Understand what the vision/recognition pipeline actually does before writing claims about it
- **Engine:** `${VERTEX_ENGINE_ID_FRIDGESNAP}` in project `Semantic-Brain-Desktop`
- **Usage:** Always query before writing accuracy claims or feature descriptions — ground content in real capabilities
- **Access:** Read-only

### Google Analytics 4 — Data API
- **Purpose:** MAU tracking, new subscription attribution, landing page conversion funnels, traffic by channel
- **Auth:** `${GA_API_KEY}`
- **Usage:** Pull on daily CRO/SEO tasks and weekly paid ad reports
- **Access:** Read-only

### Content Queue — Paperclip Task Queue
- **Purpose:** Stage content drafts, demo scripts, ad copy, social captions for human review
- **Usage:** All outbound content must be queued before publishing
- **Governance:** External-facing content requires human approval

### Memory — Read / Write
- **Purpose:** Persist avatar research, keyword targets, campaign history, App Store optimization notes across cycles
- **Readable files:** `MEMORY.md` in this agent directory
- **Usage:** Read at start of each heartbeat task; write after task completion
