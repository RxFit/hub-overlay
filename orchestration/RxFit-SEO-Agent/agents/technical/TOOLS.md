# Tools — RxFit SEO Agent | Technical Workspace

## Semantic Search

- **`github-rxfit-seo-agent`** — Vertex AI semantic search over the SEO Agent codebase
  - Use to: locate prompt templates, scheduled job configs, API integration code, bug context
  - Bucket: `github-rxfit-seo-agent` in GCS project `Semantic-Brain-Desktop`

## GitHub Integration

- **GitHub Issues API**
  - Auth: `${GITHUB_TOKEN}`
  - Repo: `RxFit/RxFit-SEO-Agent`
  - Use to: read Jules `jules-audit` tagged issues, open PRs, track sprint progress
  - Engineer agents: can open PRs and issues; human executes merges to main

## Infrastructure Monitoring

- **Cloud Run metrics**
  - Use to: monitor SEO Agent service health, uptime, error rates, memory/CPU usage
  - Alert thresholds: error rate >5%, memory >80%, job failure rate >5%

- **Paperclip task queue**
  - Use to: schedule and monitor content generation jobs, retry failed tasks

## Memory

- **Agent memory** — persistent MEMORY.md (see MEMORY.md)
  - Read/write: Tool Health Status, Active Prompt Templates, API Integration Status, Sprint Log, Jules Audit History

## Governance

- `${GITHUB_TOKEN}` — never inline, always from env
- No production deploys without testing — staging environment required
- CERBERUS Mandate enforced: all configs environment-agnostic
