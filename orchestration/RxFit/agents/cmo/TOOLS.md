# CMO Agent — Tools

> All API credentials accessed via environment variables. Never hardcoded.

---

## 1. rxfit-analytics — Vertex AI Semantic Search

- **Purpose:** GA4 traffic data, Google Search Console rankings, conversion funnel metrics, paid campaign performance
- **Auth:** `${VERTEX_ENGINE_ID_RXFIT}` — GCS project `Semantic-Brain-Desktop`
- **Primary use cases:** SEO keyword gap analysis, CRO funnel analysis, paid campaign review
- **Access:** Read only

---

## 2. rxfit-gdrive — Vertex AI Semantic Search

- **Purpose:** Brand assets, approved imagery, existing content templates, campaign briefs
- **Auth:** `${VERTEX_ENGINE_ID_RXFIT}`
- **Primary use cases:** Brand voice validation, locating existing content to avoid duplication
- **Access:** Read only

---

## 3. rxfit-clients — Vertex AI Semantic Search

- **Purpose:** Client profile data for avatar validation — industries, demographics, objections, conversion patterns
- **Auth:** `${VERTEX_ENGINE_ID_RXFIT}`
- **Primary use cases:** Ensuring content resonates with real client profiles, not assumed avatars
- **Access:** Read only. No PII extraction — aggregate patterns only.

---

## 4. Google Search Console API

- **Purpose:** Direct query-level data — impressions, clicks, CTR, average position by keyword
- **Auth:** `${GSC_API_KEY}`
- **Primary use cases:** Monday SEO pillar — keyword gap identification
- **Permitted operations:** Read queries, pages, performance data

---

## 5. Paperclip Content Queue API

- **Purpose:** Queue approved content recommendations, briefs, and drafts for human or tool publishing
- **Auth:** `${PAPERCLIP_API_KEY}`
- **Workspace:** `${PAPERCLIP_WS_RXFIT_MARKETING}`
- **Permitted operations:** Create task, attach content draft, read queue status, mark complete

---

## 6. Memory File Read/Write

- **Files:**
  - `agents/cmo/MEMORY.md` — own memory (read/write): content calendar, keyword list, avatar profiles, campaign log
  - `KPI.json` — update marketing actuals only (organic traffic, leads)
