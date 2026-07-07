# RxFit Client Platform — Technical Lead | Tools

## Available Tools

### `github-appRxFitai` — Semantic Search (GCS / Vertex AI)
- **Purpose:** Understand codebase structure, find relevant files, and ground technical decisions in actual code
- **Engine:** `${VERTEX_ENGINE_ID_WELLNESS}` in project `Semantic-Brain-Desktop`
- **Usage:** Query before writing any code suggestion or PR description
- **Access:** Read-only

### GitHub Issues API
- **Purpose:** Open, update, label, and comment on Issues; open Pull Requests
- **Auth:** `${GITHUB_TOKEN}`
- **Repo:** `RxFit/AppRxFitai`
- **Access:** Read + Write (Issues and PRs only — no direct push to protected branches)
- **Governance:** PRs require human approval to merge

### Cloud Run Metrics
- **Purpose:** Monitor app health — error rates, latency, request volume, crash counts
- **Usage:** Daily liveness check; alert on anomalies
- **Access:** Read-only

### Paperclip Task Queue
- **Purpose:** Stage tasks for engineer sub-agents, track task completion, coordinate sprint work
- **Usage:** Assign bug fixes and feature work to engineer agents; receive completion reports
- **Access:** Read + Write
