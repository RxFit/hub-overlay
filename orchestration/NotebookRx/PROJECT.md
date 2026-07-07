# NotebookRx — Project Brief

## What It Is

**NotebookRx** is an AI-powered account intelligence notebook — a structured memory layer for client engagements. It combines advisor meeting notes, client self-reported operating metrics, and market research into a single AI-augmented system that detects patterns, surfaces insights, and generates personalized operating playbooks over time.

Think of it as **"your firm's institutional memory that remembers everything"** — analytical in precision, warm in delivery.

---

## Target Users (Dual Audience)

| User Type | How They Use It |
|---|---|
| **RxFit Advisors** | Log client sessions, track progress over time, receive AI-surfaced pattern alerts ("client's pipeline coverage correlates with hiring-plan slippage") |
| **RxFit Clients** | Self-report operating metrics, receive AI-generated insight summaries, follow personalized board-memo-style recommendations |

---

## Core Value Proposition

Most business tools capture data but fail to synthesize it. NotebookRx is the synthesis layer:
- **Pattern detection** across time-series business data (revenue, pipeline, engagement, sentiment, operating KPIs)
- **Advisor augmentation** — AI surfaces what human advisors might miss across 20+ clients
- **Client engagement** — clients see their own growth narrative, not just raw numbers
- **Analytical credibility** — recommendations grounded in market research, not generic advice

---

## Brand Voice

Intelligent. Analytical but warm. Data-credible without being cold. Think "brilliant chief of staff who actually listens." Avoids startup-guru hype. Every recommendation has a rationale.

---

## How It Fits in the RxFit Ecosystem

```
NotebookRx
      │
      ├── Feeds patterns to ─────► Jade CoS (operational account intelligence)
      │
      ├── Stores data in ─────────► Cloud SQL (antigravity_brain, pgvector for semantic search)
      │
      └── Monetized via ──────────► Stripe (premium tier features)
```

---

## Current Status

**Experimental / Early-Stage.** Core architecture is being validated. The primary technical challenge is AI insight quality — the tool must surface insights that feel meaningfully intelligent, not generic. Product-Market Fit (PMF) has not yet been confirmed.

Key open questions:
- Is the primary user an advisor or a client?
- What is the premium feature set (vs. free tier)?
- Which data integrations drive the highest insight quality?

---

## Technical Stack (Inferred)

- **Runtime:** Python or Node.js
- **LLM:** Google Gemini (primary), OpenAI fallback
- **Database:** PostgreSQL (`antigravity_brain`) + pgvector for semantic note search
- **Embeddings:** Vertex AI Embeddings for note indexing
- **GitHub repo:** `RxFit/notebookrx`

---

## Governance Notes

- Client engagement data is sensitive — SOC 2-aligned, confidentiality-first considerations apply even if not formally required
- All AI-generated recommendations must be framed as informational — no content that could constitute financial or legal advice (legal risk)
- Stripe integration is active for premium tier — all billing changes require human execution
- Escalate to Antigravity for any data model changes or privacy-adjacent decisions
