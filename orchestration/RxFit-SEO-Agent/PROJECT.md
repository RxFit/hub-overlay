# RxFit SEO Agent — Project Brief

## What It Is

RxFit SEO Agent is an **internal, autonomous SEO and content automation tool** built for the RxFit brand. It replaces the function previously served by external SEO agencies (e.g., Pneuma Media) by generating SEO-optimized blog posts and landing pages, conducting keyword research, publishing or queuing content to the CMS, and tracking SERP rankings — all without manual intervention from the marketing team.

This is **not** a client-facing product. It is a force-multiplier internal tool that runs autonomously on a scheduled cadence.

---

## Purpose

- **Replace external SEO agencies** — reduce dependency on Pneuma Media and similar vendors
- **Drive organic traffic to rxfit.co** without paying per-click or per-post
- **Reduce Customer Acquisition Cost (CAC)** by building sustainable, compounding organic reach
- **Own RxFit's content pipeline** — no third-party bottlenecks on publish cadence

---

## Target Outcome

- Consistent organic traffic growth to `rxfit.co`
- Lead generation attributed to organic search (measured in Google Search Console + GA4)
- Published content that ranks within 90 days of publication
- A growing content moat that compounds over time

---

## How It Fits in the RxFit Ecosystem

```
RxFit SEO Agent
      │
      ├── Publishes to ──────► rxfit.co CMS (blog / landing pages)
      │
      ├── Reports to ────────► Jade CoS (operational summaries)
      │
      └── Tracks via ─────────► Google Search Console + GA4
```

The SEO Agent feeds content directly into the RxFit CMS. Performance data flows back to Jade CoS for founder-level briefings.

---

## Current Status

**Operational / Autonomous.** The tool runs on a scheduled cadence and does not require manual triggering for standard content generation cycles. Human review is available for high-stakes content (e.g., service landing pages, money keywords).

---

## Internal-Only

This tool is exclusively for internal RxFit use. It does not expose a public API and is not distributed to external clients. All credentials, API keys, and CMS access are governed by the CERBERUS Portability Mandate.

---

## Key Governance Notes

- All content published through this tool is subject to human review before targeting high-competition money keywords
- Billing and API usage tracking is handled internally — no Stripe integration
- Operational costs (LLM API calls, hosting) are tracked by the Revenue workspace and compared against agency cost equivalents
