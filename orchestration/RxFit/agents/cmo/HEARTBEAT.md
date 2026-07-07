# CMO Agent — Daily Organic Heartbeat

> **Cadence:** Monday–Friday · **Owner:** CMO Agent · **Output:** Content queue item + weekly report to CEO Agent

---

## Pre-Flight (Run Every Morning)
- [ ] Load `PROJECT.md` avatar section (primary + secondary personas)
- [ ] Check `KPI.json` — marketing target and last actual
- [ ] Check `MEMORY.md` — content calendar, keyword priority list
- [ ] Load day-specific pillar (see below)

---

## Monday — SEO Pillar
- [ ] Pull GA4 organic sessions WoW and MoM from `rxfit-analytics`
- [ ] Pull Google Search Console top 20 queries — identify impression/click gap
- [ ] Identify top 3 keyword gaps (high impression, low CTR or low position 1–10)
- [ ] Select 1 keyword gap → draft 1 on-page optimization recommendation (title, H1, meta, body paragraph)
- [ ] Queue recommendation in Paperclip content queue
- [ ] Also run: Paid Ads weekly review (see Paid section below)

## Tuesday — AEO Pillar (Answer Engine Optimization)
- [ ] Research top 5 executive-advisory queries returning AI-generated answers on Perplexity, ChatGPT, Gemini
- [ ] Check if RxFit is cited in any answer → log coverage in `MEMORY.md`
- [ ] Identify 1 FAQ or featured snippet opportunity (query + RxFit's answer angle)
- [ ] Draft structured answer content (Q&A format, 150–300 words, schema-ready)
- [ ] Queue in Paperclip content queue

## Wednesday — GEO Pillar (Generative Engine Optimization)
- [ ] Search Perplexity/ChatGPT/Gemini: "best executive advisor Austin TX" + 3 variant queries
- [ ] Check if RxFit is mentioned → log coverage
- [ ] Identify 1 authority angle where RxFit should be cited (data-backed, metrics-driven advisory, concierge)
- [ ] Draft 1 content brief: article/resource that establishes that authority angle
- [ ] Queue brief in Paperclip content queue

## Thursday — CRO Pillar (Conversion Rate Optimization)
- [ ] Pull funnel metrics from `rxfit-analytics`: sessions → leads → booked calls → closed
- [ ] Identify 1 friction point (highest drop-off stage)
- [ ] Draft 1 CRO recommendation with hypothesis: "If we [change X], we expect [Y% improvement] because [data signal]"
- [ ] Queue recommendation in Paperclip content queue

## Friday — Local Map Pack Pillar
- [ ] Check Google Business Profile signals: recent reviews, Q&A, post recency
- [ ] Flag any reviews needing response → route to COO Comms Agent → Antigravity (human responds)
- [ ] Draft 1 GBP post (≤300 words, outcome-focused, local Austin signal)
- [ ] Queue GBP post in Paperclip content queue

---

## Paid Ads — Weekly (Every Monday, After SEO)
- [ ] Pull last 7 days campaign performance from `rxfit-analytics`
- [ ] Identify: top performer (lowest CPL + highest conversion), bottom performer
- [ ] Draft budget reallocation recommendation → stage for human review
- [ ] Log in `MEMORY.md` campaign performance log

---

## Post-Flight (Run Every Day)
- [ ] Update content queue in `MEMORY.md`
- [ ] Report to CEO Agent: today's pillar output, queued items, any blockers
- [ ] Update `MEMORY.md` if new keyword, avatar, or campaign insight emerged
