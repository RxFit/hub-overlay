# Tools — RxFit SEO Agent | Revenue Workspace

## Analytics APIs

- **Google Search Console API**
  - Auth: `${GSC_API_KEY}`
  - Use to: pull organic clicks and impressions for SEO Agent-generated content
  - For: organic traffic value attribution (CPC equivalent calculation)

- **Google Analytics 4 API**
  - Auth: `${GA_API_KEY}`
  - Use to: pull organic sessions, goal conversions attributed to SEO content
  - For: traffic-to-lead attribution

## LLM Cost Tracking

- **Gemini API usage dashboard**
  - Auth: `${GEMINI_API_KEY}`
  - Use to: pull token usage and cost data for the current billing period

- **OpenAI usage API** (if applicable)
  - Auth: `${OPENAI_API_KEY}`
  - Use to: pull token usage and cost data

- **Cloud Run billing API**
  - Use to: pull hosting cost for the SEO Agent service

## Memory

- **Agent memory** — persistent MEMORY.md (see MEMORY.md)
  - Read/write: Monthly API Cost, Content Output Volume, Organic Traffic Attributed, Agency Cost Equivalent, Net ROI

## Governance

- All API keys via environment variable — never inline
- GSC, GA4, Gemini, OpenAI access is read-only for cost tracking
- No billing execution — read-only financial data only
- RxHarden mandate: all cost figures sourced from actual API data, not estimates
