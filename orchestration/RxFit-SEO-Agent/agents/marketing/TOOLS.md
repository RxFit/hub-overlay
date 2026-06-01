# Tools — RxFit SEO Agent | Marketing Workspace

## Semantic Search

- **`github-rxfit-seo-agent`** — Vertex AI semantic search over the RxFit SEO Agent codebase and content output
  - Use to: search for published content pieces, prompt templates, content brief formats
  - Bucket: `github-rxfit-seo-agent` in GCS project `Semantic-Brain-Desktop`

## Analytics APIs

- **Google Search Console API**
  - Auth: `${GSC_API_KEY}`
  - Use to: pull ranking positions, impressions, clicks for SEO Agent-generated URLs
  - Key queries: ranking distribution, position decay, CTR vs. position benchmarks

- **Google Analytics 4 API**
  - Auth: `${GA_API_KEY}`
  - Use to: pull organic traffic sessions, bounce rate, conversion events attributed to SEO content
  - Key queries: sessions by landing page, organic channel attribution, traffic trend

## Memory

- **Agent memory** — persistent MEMORY.md (see MEMORY.md)
  - Read/write: Content Quality Audit Log, Ranking Improvements, Known Tool Weaknesses, Keyword Strategy Notes

## Governance

- All API keys via environment variable — never inline
- GSC and GA4 are read-only access for this workspace
- No CMS write access — content changes recommended to Technical workspace only
