# NotebookRx — Project Brief

## What It Is

**NotebookRx** is an AI-powered health and fitness intelligence notebook — a structured memory layer for health journeys. It combines coach session logs, client self-tracking data, and health science research into a single AI-augmented system that detects patterns, surfaces insights, and generates personalized health protocols over time.

Think of it as **"your personal health AI that remembers everything"** — clinical in precision, warm in delivery.

---

## Target Users (Dual Audience)

| User Type | How They Use It |
|---|---|
| **RxFit Coaches** | Log client sessions, track progress over time, receive AI-surfaced pattern alerts ("client's sleep quality correlates with workout performance drops") |
| **RxFit Clients** | Self-track health journals, receive AI-generated insight summaries, follow personalized prescription-style recommendations |

---

## Core Value Proposition

Most health apps capture data but fail to synthesize it. NotebookRx is the synthesis layer:
- **Pattern detection** across time-series health data (sleep, nutrition, workouts, mood, biomarkers)
- **Coach augmentation** — AI surfaces what human coaches might miss across 20+ clients
- **Client engagement** — clients see their own health narrative, not just raw numbers
- **Scientific credibility** — recommendations grounded in health research, not generic advice

---

## Brand Voice

Intelligent. Clinical but warm. Scientifically credible without being cold. Think "brilliant doctor who actually listens." Avoids wellness-industry hype. Every recommendation has a rationale.

---

## How It Fits in the RxFit Ecosystem

```
NotebookRx
      │
      ├── Feeds patterns to ─────► Jade CoS (operational health intelligence)
      │
      ├── Stores data in ─────────► Cloud SQL (antigravity_brain, pgvector for semantic search)
      │
      └── Monetized via ──────────► Stripe (premium tier features)
```

---

## Current Status

**Experimental / Early-Stage.** Core architecture is being validated. The primary technical challenge is AI insight quality — the tool must surface insights that feel meaningfully intelligent, not generic. Product-Market Fit (PMF) has not yet been confirmed.

Key open questions:
- Is the primary user a coach or a client?
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

- Health data is sensitive — HIPAA-adjacent considerations apply even if not formally required
- All AI-generated health recommendations must be framed as informational, not prescriptive (legal risk)
- Stripe integration is active for premium tier — all billing changes require human execution
- Escalate to Antigravity for any data model changes or privacy-adjacent decisions
