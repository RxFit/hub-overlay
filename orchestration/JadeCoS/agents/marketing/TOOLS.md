# Tools — Jade CoS | Marketing Workspace

## Semantic Search

- **`github-jade-cos`** — Vertex AI semantic search over the Jade CoS codebase
  - Use to: locate feature code, capability inventory, alert/briefing templates
  - Bucket: `github-jade-cos` in GCS project `Semantic-Brain-Desktop`

## Application Logs

- **Jade CoS application log API**
  - Use to: pull alert send history, briefing delivery log, feature usage events
  - Key queries: alerts sent by type and week, founder queries executed, features invoked

## Memory

- **Agent memory** — persistent MEMORY.md (see MEMORY.md)
  - Read/write: Feature Utilization Log, Active Integrations, Documentation Status, Adoption Blockers

## Governance

- Read-only access to application logs — no write access to Jade CoS runtime
- Documentation changes go through GitHub repo PR process
- Feature change recommendations go to Technical workspace — this workspace does not implement
