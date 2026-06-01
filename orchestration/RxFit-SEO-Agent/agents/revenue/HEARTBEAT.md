# Heartbeat — RxFit SEO Agent | Revenue Workspace

## Weekly Routine

**Every week:**
- Pull LLM API usage data (Gemini dashboard or OpenAI usage page via `${GEMINI_API_KEY}` / `${OPENAI_API_KEY}`)
- Pull Cloud Run hosting cost for the SEO Agent service
- Calculate total weekly running cost
- Pull content output volume from Technical workspace log (how many pieces generated this week?)
- Calculate cost-per-piece: total cost ÷ pieces generated
- Compare against agency equivalent: what would Pneuma Media have charged for same volume?
- Flag any cost-per-piece increase >20% vs. 4-week average

**Weekly Output:**
- Weekly cost summary: LLM cost + hosting cost + total
- Content output volume
- Cost-per-piece vs. agency equivalent
- Send to Jade CoS for weekly operations digest

---

## Monthly Routine

**Month-End (within 3 days of month close):**
- Pull GSC data: total clicks + impressions for SEO Agent-generated content
- Calculate organic traffic value: estimated CPC equivalent (use Google Ads benchmark for fitness keywords)
- Pull total monthly running cost from weekly summaries
- Calculate agency cost equivalent: month's content volume × agency rate-per-piece
- Compute Net ROI: `(Agency Equivalent + Organic Traffic Value) - Monthly Running Cost`
- Log in MEMORY.md
- Report to Jade CoS → Antigravity for founder P&L briefing

---

## Escalation Triggers

- Monthly tool cost exceeds 50% of agency cost equivalent → flag to Antigravity
- Cost-per-piece increases 3 weeks in a row → flag to Technical workspace
