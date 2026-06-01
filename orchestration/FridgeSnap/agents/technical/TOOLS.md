# FridgeSnap — Technical Lead | Tools

## Available Tools

### `github-fridgesnap` — Semantic Search (GCS / Vertex AI)
- **Purpose:** Understand the recognition pipeline, nutrition database integration, and codebase structure
- **Engine:** `${VERTEX_ENGINE_ID_FRIDGESNAP}` in project `Semantic-Brain-Desktop`
- **Usage:** Query before writing any pipeline-adjacent code suggestion or PR description
- **Access:** Read-only

### GitHub Issues API
- **Purpose:** Open, update, label, and comment on Issues; open Pull Requests
- **Auth:** `${GITHUB_TOKEN}`
- **Repo:** `RxFit/Fridge-Food-Snap`
- **Label taxonomy:** `[accuracy]`, `[edge-case]`, `[P0]`, `[P1]`, `[P2]`, `[jules-audit]`, `[pipeline]`, `[health]`
- **Access:** Read + Write (Issues and PRs only — no direct push to protected branches)
- **Governance:** PRs require human approval to merge; pipeline PRs require Antigravity review

### Replit Deployment Health
- **Purpose:** Monitor app health — deployment status, error rates, request volume, Gemini recognition pipeline health
- **Usage:** Daily liveness check; alert on anomalies
- **Note:** FridgeSnap runs on Replit with Gemini 2.5 Pro via Replit AI Integrations — there is no separate Vision API or Cloud Run service
- **Access:** Read-only

### Paperclip Task Queue
- **Purpose:** Assign accuracy investigation tasks and bug fixes to engineer agents; receive completion reports; escalate to CEO Agent
- **Access:** Read + Write
