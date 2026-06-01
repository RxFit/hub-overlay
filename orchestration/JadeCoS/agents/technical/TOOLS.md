# Tools — Jade CoS | Technical Workspace

## Semantic Search

- **`github-jade-cos`** — Vertex AI semantic search over the Jade CoS codebase
  - Use to: locate service code, Docker configs, DB schema, route handlers, alert logic
  - Bucket: `github-jade-cos` in GCS project `Semantic-Brain-Desktop`

## GitHub Integration

- **GitHub Issues API**
  - Auth: `${GITHUB_TOKEN}`
  - Repo: `RxFit/jade-cos`
  - Use to: read Jules `jules-audit` tagged issues, open PRs, track sprint issues
  - Engineer agents: can open PRs and issues; human executes merges to main

## Infrastructure & Health

- **Cloud Run metrics**
  - Use to: monitor Jade CoS service health, uptime %, error rates, resource utilization
  - Alert threshold: uptime <99.9%, error rate >1%

- **Docker health API**
  - Use to: check `jade-cos` container and `cloudflared` sidecar health status
  - Volume integrity check: `jade-data`, `RxFit-MCP`, `_CERBERUS_CORE`

## Memory

- **Agent memory** — persistent MEMORY.md (see MEMORY.md)
  - Read/write: Deployment Status, Last Known Good Version, Active Docker Services, Open Security Issues, Sprint Log, Jules Audit History

## Governance

- `${GITHUB_TOKEN}`, `${CLOUD_SQL_HOST}`, `${CLOUDFLARE_TUNNEL_TOKEN}` — never inline
- All DB schema changes blocked until Antigravity approves
- Production merges: human-only
- No Friday production deploys
