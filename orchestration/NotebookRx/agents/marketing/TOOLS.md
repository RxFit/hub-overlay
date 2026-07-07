# Tools — NotebookRx | Marketing Workspace

## Semantic Search

- **`github-notebookrx`** — Vertex AI semantic search over the NotebookRx codebase
  - Use to: understand current feature set, locate user feedback handling, find content/messaging in codebase
  - Bucket: `github-notebookrx` in GCS project `Semantic-Brain-Desktop`

## Analytics

- **Google Analytics 4 API**
  - Auth: `${GA_API_KEY}`
  - Use to: pull traffic data, landing page performance, user acquisition channels, session behavior
  - Key queries: monthly active users, traffic by source, bounce rate by landing page

## Content Tools

- **Content queue** (Jade CoS integrated)
  - Use to: queue concept validation research outputs and content brief drafts for review
  - All external content requires human approval before publish

## Memory

- **Agent memory** — persistent MEMORY.md (see MEMORY.md)
  - Read/write: PMF Signals Log, User Feedback, Content Tests, Avatar Research Notes, Messaging Hypotheses

## Governance

- GA4 access is read-only
- No direct publish access — all content queued for human review
- Content claims must be reviewed for regulatory compliance before use — nothing that could constitute financial or legal advice
- No paid acquisition spending without founder approval
