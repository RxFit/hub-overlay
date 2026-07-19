# Hub Overlay — Technical & Functional Audit

**Date:** 2026-06-17
**Method:** Deep-research methodology — 6 parallel investigators across the codebase + targeted web verification of external dependencies; every P0/P1 verified against actual code (file:line) or current vendor documentation.
**Status of this document:** This is the single authoritative audit. It supersedes and replaces the prior root-level audit/plan/report markdowns (several of which described fixes that were never actually applied — see Meta-finding).

---

## Glossary (used precisely in every finding)
- **tenant-company** — a Hub customer org (e.g. RxFit, "rosepop"); the multi-tenant unit.
- **paperclip-company** — paperclip.ing's isolated unit. **Verified reality:** in paperclip, *Company IS the isolated workspace* — there is **no** parent-org → child-workspace hierarchy.
- **paperclip "Workspace"** — **verified reality:** paperclip's **per-issue execution sandbox**, *not* a company or project.
- **Hub `assignedProjects`** — the array on a user that gates which **paperclip-company** ids they may touch.

## The single most important architectural truth
The product is sold as *stateless, multi-tenant*, but **the orchestration + AI layers are currently single-instance, single-credential (RxFit)**. Tenant separation rests entirely on Hub-side `assignedProjects → companyId` filtering. Most "cross-tenant" P0s below are **latent today** (only RxFit is deployed) but are **hard blockers the moment a second tenant-company onboards.**

---

## P0 — Safety / authorization / isolation (fix before any 2nd tenant or wider agent use)

### P0-1 · Orchestration writes enforce company-*scope* but not role-*tier* (§3 orchestration)
`app/api/paperclip/[...path]/route.ts` — only `DELETE` is role-gated (`:93`). `POST`/`PATCH` check `assignedProjects` scope (`:137-215`) but **never the user's role**. A **staff** user assigned to a paperclip-company can `PATCH /api/issues/{id}` (reassign / change state), `PATCH /api/agents/{id}` (restart), and `POST .../agents` (create agent) — all "admin" actions per the product's own map — by calling the API directly. Role gating lives **only** client-side in `page.tsx` (`hasPermission`).
**Fix:** a role → method → path enforcement table in the proxy mirroring the DELETE gate.

### P0-2 · The "misinformed-agent" safety gate is cosmetic server-side (§3)
The interview, Pre-Cog validation, and 80%-context-sufficiency score all live in the browser (`page.tsx` `runQualityGate`). `lib/actions/executeAction.ts` and every `/api/paperclip/**` route execute the mutation with **zero** knowledge of any score; `app/api/chat/score-context/route.ts` only *returns* a number. Worse, in-UI it **fails open**: `finalScore` defaults to `80` (`page.tsx`), so a 200 response with a non-numeric score **passes**. This is the central guardrail protecting non-technical owners from destructive agent actions — and it gates nothing at the boundary.
**Fix:** re-evaluate the gate server-side inside the write route; default score to 0; only raise on an explicit numeric server score.

### P0-3 · No paperclip-level tenant isolation (cross-tenant, §3)
`lib/paperclipConfig.ts:12` falls back to RxFit's Cloud Run URL; `:20,26` hardcode RxFit default company IDs (used as fallbacks in the issues route → a request missing `companyId` writes into **RxFit's CEO paperclip-company**); `lib/paperclipSession.ts:31` caches the session cookie in a **single global**, not per-tenant. Net: every tenant-company authenticates as the *same* RxFit paperclip identity, separated only by `assignedProjects`.
**Fix:** per-tenant paperclip base URL + credentials + company id; tenant-key the cookie cache; fail closed if unset.

### P0-4 · Vertex "Semantic Brain" is both unscoped and broken (cross-tenant + dead feature)
`app/api/chat/route.ts:49` calls `searchSemanticBrain(query)` with **no datastore filter** against one shared engine (`lib/vertex.ts:16`) → searches everything indexed. The attachment path passes `dataStore:"rxfit-gdrive"` (`lib/vertex.ts:136`), but **web-verified against Google Discovery Engine docs that this filter syntax is invalid** — `dataStore` is not a document schema field → **400 INVALID_ARGUMENT → swallowed to `null`** (`:149`). So scoped semantic search silently never works, *and* the unscoped path would leak tenant B's indexed docs to tenant A.
**Fix:** use `dataStoreSpecs:[{ dataStore: "<full resource path>" }]`, derived from tenant context; remove the hardcoded literal.

---

## P1 — Correctness, prompt-safety, resilience

### P1-1 · Prompt injection via injected tool/connector output (§2 chat)
Exa snippets, fetched URL text, Drive doc content, and attachments are interpolated into the system prompt with weak `##` / `[ ]` delimiters (`app/api/chat/route.ts:128,339,353`; `lib/gemini.ts` `buildSystemPrompt`). Adversarial content in a web page / Drive doc / calendar invite can pose as instructions or emit a crafted `<!--suggestedTools:[...]-->`.
**Fix:** wrap all external content in explicit `<untrusted_data>…</untrusted_data>` fences; never inside the instruction region.

### P1-2 · Google auth resilience regressed — and the repo's docs misstate it (§1 integrations)
Every Google route uses raw `getToken()` + `token?.accessToken`, checking only `if (!accessToken)`, **never `token?.error`** (`app/api/google/tasks/route.ts:15-17`, etc.). After a failed refresh, `lib/auth.ts:180` keeps the **stale** token → Google 401 → opaque **500** instead of a 401 reauth, so the UI never prompts re-login. **`lib/google-session.ts` — which `HUB_CHAT_INTEGRATION_AUDIT_2026-06-13.md` claimed was created and wired into all 7 routes — does not exist.**
**Fix:** drop `accessToken` when `error` is set (in the jwt callback), or check `token.error` in every route and return a 401 reauth signal.

### P1-3 · Paperclip data model is misunderstood in code (§3 — the terminology hazard, realized)
`lib/paperclipConfig.ts:24-26` comments treat `RXFIT_CEO_COMPANY_ID` as a "CEO personal workspace" child of a parent "org" (`RXFIT_COMPANY_ID`) — but web-verified, those are **two sibling, mutually-isolated paperclip-companies**; there is no cross-company "CEO delegates to officer workspaces" routing. Human assignment is broken (`assigneeUserId` never threaded — `lib/paperclip.ts:117`). The `GET /api/issues/:id/runs` aggregation (`lib/paperclip.ts:384`) is not in paperclip's public docs and may 404 (swallowed to `[]`).
**Fix:** correct the model/comments; thread `assigneeUserId`; verify the runs route.

### P1-4 · "Validation theater" against a fast-moving dependency (§3)
`paperclipFetch` returns **raw unvalidated `json as T` on zod mismatch** (`lib/paperclip.ts:218-224`); schemas are `.passthrough()`; dozens of unchecked `as` casts; `getRuns` / `checkHealth` swallow errors to empty. Since paperclip ships breaking changes multiple times/week, drift becomes silent wrong-typed data or blank panels, never an alert.
**Fix:** throw on list-endpoint schema failure; distinguish empty from error; alert on drift.

### P1-5 · Cross-tenant pgvector mixing via Google webhooks
`app/api/webhooks/google/route.ts:108,134` index Drive docs under a hardcoded `getDefaultTenantId()` ('rxfit'). Multi-tenant, all docs land under one tenant.
**Fix:** derive tenant from the webhook channel metadata.

### P1-6 · Smaller but real
- `delete_agent` server gate allows `admin` though the intent map requires `superadmin` (`app/api/paperclip/[...path]/route.ts:93` vs `lib/interview.ts`).
- `send_communication` resolves the COO agent client-side and the server trusts `assigneeId` unvalidated (`lib/actions/executeAction.ts:144-164`).
- Exa masks a **bad API key as zero results** (`lib/exa.ts:43`).
- Google write endpoints have **no input-size validation** (`lib/google.ts` create paths) → OOM / rate-limit risk.

---

## P2 — Hygiene / UX / latent
- No timeout on Google fetches (`lib/google.ts`) — can hang to `maxDuration`.
- Calendar **delete defaults to `primary`** with no verify → wrong-calendar deletion risk (`lib/google.ts` / `app/api/google/calendar` DELETE).
- tasks/calendar/drive can't distinguish auth-expired from empty (chat routes partially can).
- `suggestedTools` / `activeSkill` not validated against the catalog (`app/api/chat/route.ts`).
- Error-path message ids still `String(Date.now())` (`app/page.tsx`).
- Deprecated Exa `searchAndContents` / `useAutoprompt` (`lib/exa.ts`).
- Unencoded IDs in Google URLs; `maxResults` unbounded.
- KPI sync cron + embeddings-delete default to 'rxfit' tenant.
- OAuth stale-role on refresh error (`lib/auth.ts`).

---

## ✅ Confirmed healthy (do NOT "fix")
- Google Workspace **data** isolation is inherently correct (per-user OAuth token; Google enforces server-side).
- Role / `assignedProjects` are **server-verified in the JWT — not client-spoofable** (`lib/auth.ts`).
- SSRF protection (DNS + internal-IP block + redirect handling) and Gmail CRLF header-injection stripping are well implemented (`lib/content-fetch.ts`, `lib/google.ts`).
- Paperclip company-*scope* filtering works (`app/api/paperclip/[...path]/route.ts`, `app/api/chat/route.ts:209-214`).
- pgvector queries are tenant-scoped (`lib/vector-store.ts`).
- Prior chat-engine fixes (model rotation Fable 5 → Sonnet 4.6 → Gemini, idle watchdog, pure `doSend` updater, panel context porting) are intact and stress-tested (`lib/gemini.ts`, `lib/panel-inject.ts`, `lib/*.test.ts`).
- Circuit-breaker / retry / loop-detector wrap paperclip.
- CI now runs typecheck + tests on every PR (`.github/workflows/ci.yml`).

## ⚠️ Meta-finding — why the codebase "feels like a mess"
The repo root accumulated ~15 audit/plan/runbook/log markdowns, and **several describe fixes that are not in the code** (e.g. `lib/google-session.ts` claimed by `HUB_CHAT_INTEGRATION_AUDIT_2026-06-13.md` does not exist). The historical audit trail cannot be trusted at face value. This document replaces it.

## Recommended remediation sequence (matches the #3 > #2 > #1 risk order)
1. **P0-2 then P0-1** — move the safety gate and role enforcement *server-side*. This is the "a non-technical owner can't be harmed by a misinformed agent" promise.
2. **P0-3 / P0-4** — per-tenant paperclip + Vertex config before onboarding tenant #2.
3. **P1-1** (prompt-injection fencing) and **P1-2** (auth reauth) — highest-frequency real-user impact.
4. **P1-3 / P1-4** — correctness + drift resilience for the orchestration layer.
</content>
