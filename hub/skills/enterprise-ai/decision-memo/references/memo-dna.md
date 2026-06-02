---
name: decision-memo-builder
description: Builds a 1-page decision memo (context → options → recommendation → risks → ask) enforcing McKinsey memo DNA — brutal brevity, SCP storyline clarity, decision-forcing output, evidence density. Use when drafting a memo for a leadership decision, a scope cut, a buy/build/partner call, a roadmap slip, or any "should we X?" moment that needs a yes/no from a specific person by a specific date.
---

# Decision Memo Builder

A 1-page memo that forces a decision. Not a status update. Not a brief. Not a FYI. The reader walks away knowing exactly what they are being asked to approve, by when, and why.

---

## Memo DNA — four non-negotiables

Every decision memo must pass all four. If the draft fails one, rewrite. Do not ship a memo that fails Memo DNA.

1. **Brutal brevity** — 1 page, ~400 words max. Every sentence earns its place or gets cut.
2. **Storyline clarity (SCP)** — Situation → Complication → Resolution flow. Reader never asks "so what?"
3. **Decision-forcing** — Last line is a yes/no ask with owner and date. Never "further analysis needed."
4. **Evidence density** — Every claim backed by a number, quote, or source. No adjectives doing load-bearing work.

---

## Structure

### Title (≤10 words)
Name the **decision**, not the topic.
- ✅ "Sunset legacy reporting engine by Q3"
- ❌ "Reporting strategy update"

### Context (3–4 sentences)
State of the world *before* the ask. Facts only. Baseline numbers. No history-of-the-universe framing.

### Complication (2–3 sentences)
What changed, or what's at risk if we don't decide now. Include the number that makes this urgent.
- ✅ "Usage down 15% QoQ; 3 enterprise deals ($1.2M) flagged the gap in Q1 QBRs."
- ❌ "Usage has been declining and customers are concerned."

### Options (2–3 options, 1–2 lines each)
Mutually exclusive. Each option gets:
- **Name**
- One-line description
- The single most important trade-off (cost, time, or risk)

Do not sneak a recommendation in here.

### Recommendation (1 short paragraph)
State the chosen option and why it wins on the decision criteria that matter most. Cite the evidence that tips the call.

### Risks & Mitigations (≤3 bullets)
The top 3 things that could go wrong, each paired with a 1-line mitigation. Not a risk inventory — the three the reader would actually ask about.

### The Ask (1 line)
A specific yes/no request with an owner and a date.
- ✅ "Approve sunset by EOD Friday; Sarah owns migration plan by 5/1."
- ❌ "Let's discuss next steps."

---

## Process

1. **Interview before drafting.** Ask the user:
   - Who is the reader? (CEO, VP, peer)
   - What decision do they need to make?
   - What's the deadline?
   - What are the real 2–3 options, and which do you think wins?
   - What evidence do you have? (Numbers, quotes, benchmarks)

2. **Draft in Memo DNA order.** Title → Context → Complication → Options → Recommendation → Risks → Ask.

3. **Run the four tests.** For each section, confirm it passes Memo DNA. Flag any that fail.

4. **Cut 30%.** First drafts are always too long. Strip adjectives, hedging ("potentially," "may," "could possibly"), and throat-clearing.

5. **Stress-test the ask.** Can the reader answer yes or no from the memo alone? If not, sharpen.

---

## Worked Example 1: Tooling Migration

**Title**
Switch engineering + product from Jira to Linear by 5/30

**Context**
~60 engineers and PMs on Jira today. $48K/yr in licenses. 4 active projects, custom workflows, 6 years of history. Engineering NPS on tooling = 4/10 in the Q1 survey.

**Complication**
Jira admin role has been open 4 months; no single owner maintaining workflows. Two teams (Growth, Platform) ran Linear pilots in Q1 — 30% faster issue creation, 50% less "which field is required" confusion. Renewal is due 5/30 and auto-renews at +12%.

**Options**
1. **Stay on Jira** — $54K next year, zero migration cost, continued tooling friction.
2. **Migrate to Linear** — $36K/yr, ~6 weeks of migration work, cleaner UX, loses some Jira-specific reports.
3. **Run Linear + Jira in parallel for 6 months** — hedged, doubled cost ($90K), splits team context.

**Recommendation**
Migrate to Linear. Saves $18K/yr, ends the 4-month admin vacancy, and two pilot teams already validate the productivity win (60 people × 1 hr/wk saved ≈ $300K/yr loaded). The "lost reports" risk is low — exec dashboards already live in Looker, not Jira.

**Risks & Mitigations**
- 6 years of Jira history → export to a read-only archive; no lift-and-shift.
- Custom workflow loss → document the top 3 workflows, rebuild in Linear before cutover.
- Team resistance → give Growth + Platform leads ownership of internal comms.

**The Ask**
Approve Linear migration by 5/30. Priya owns migration plan; Alex cancels Jira renewal.

---

## Worked Example 2: Scope Cut

**Title**
Cut AI-tagging from v2 launch — approve by EOD

**Context**
v2 is committed for 5/15. Current scope: 8 features, ~1,800 engineer-hours estimated. Team capacity = 1,400 hours remaining.

**Complication**
We're 400 hours over. AI-tagging alone = 350 hours and blocks 3 other teams' integrations if it slips.

**Options**
1. **Ship all 8, slip 3 weeks** — breaks GTM commits to 4 design partners.
2. **Cut AI-tagging, ship 5/15** — scope fits, saves 350 hrs, feature defers 6 weeks.
3. **Cut 2 smaller features, keep AI-tagging** — fits scope but breaks onboarding funnel.

**Recommendation**
Cut AI-tagging. Launch date > this feature. AI-tagging ranked #6 in customer survey (n=42). Cutting the 2 smaller features would break a conversion funnel we validated last quarter (+18% activation).

**Risks & Mitigations**
- GTM already promised AI-tagging → update positioning memo this week.
- Team morale dip → announce v2.1 date (7/1) alongside the cut.
- Competitor parity → no competitor ships it today; 6-week delay = low risk.

**The Ask**
Approve cutting AI-tagging from v2 by EOD. Alex updates GTM narrative; Jordan re-plans v2.1.

---

## Anti-patterns

- ❌ Bullet-point soup with no storyline
- ❌ "We should consider..." — decision-averse hedging
- ❌ Missing numbers — "significant impact," "major risk," "strong signal"
- ❌ Recommendation leaked into the Options section
- ❌ Ask that's just "discuss next steps"
- ❌ > 1 page — if you need more, split into memo + appendix

---

## When to Use

- Leadership decision requests (buy/build, hire, cut, pivot)
- Roadmap calls (ship / slip / cut)
- Scope trade-offs (cut X to save Y)
- Strategic pivots
- Any moment a peer or exec needs a yes/no from you

## When NOT to Use

- FYI updates → use a status note
- Brainstorms → use `/issue-tree`
- Broader strategic narratives → use `/scpr`
- Presentations → use `/storyline`
- Post-review quality check → pair with `mckinsey-critic`
