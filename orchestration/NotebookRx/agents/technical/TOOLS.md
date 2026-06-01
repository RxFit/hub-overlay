# Tools — NotebookRx | Technical Workspace

## Semantic Search

- **`github-notebookrx`** — Vertex AI semantic search over the NotebookRx codebase
  - Use to: locate prompt pipeline code, data schema, insight generation logic, API integrations
  - Bucket: `github-notebookrx` in GCS project `Semantic-Brain-Desktop`

## GitHub Integration

- **GitHub Issues API**
  - Auth: `${GITHUB_TOKEN}`
  - Repo: `RxFit/notebookrx`
  - Use to: read Jules `jules-audit` tagged issues, open PRs, track experiments as GitHub Issues
  - Engineer agents: can open PRs and issues; human executes merges to main

## Infrastructure Monitoring

- **Application logs** (Cloud Run or equivalent)
  - Use to: monitor service health, uptime, error rates, AI inference latency
  - Key alerts: service down, inference error rate >5%, DB connection failures

- **Paperclip task queue**
  - Use to: schedule and monitor AI insight generation jobs, manage async health pattern analysis

## Memory

- **Agent memory** — persistent MEMORY.md (see MEMORY.md)
  - Read/write: Current AI Model/Prompt Version, Known Accuracy Issues, Sprint Log, Jules Audit History, Pattern Detection Results

## Governance

- `${GITHUB_TOKEN}`, `${CLOUD_SQL_HOST}`, `${GEMINI_API_KEY}` — never inline
- Health data handling: HIPAA-adjacent standards regardless of formal requirement
- DB schema changes blocked until Antigravity approves
- All prompt changes version-controlled as code, not ad hoc edits
