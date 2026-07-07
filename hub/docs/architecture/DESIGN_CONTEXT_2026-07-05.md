# Hub Overlay — Design Context & Sprint Reconciliation (2026-07-05)

Working reference captured while planning the post-test-pass improvement sprint.
Distilled from two authoritative inputs the team provided:

1. **Design & Architecture doc** (2026-07-05) — product intent, stack, scope.
2. **Vault-hydrated expert review** — corrections to the 18 proposed tasks.

Plus the repo's authoritative audit `HUB_TECHNICAL_FUNCTIONAL_AUDIT_2026-06-17.md`.
The companion plan is `IMPROVEMENT_PLAN_2026-07-05.html` in this folder.

> Every disputed claim below was spot-verified against `master` code, not taken
> from any document at face value — because both documents proved partly stale.

## Product intent

- **App:** three-panel AI operations hub for **RxFit** (fitness business, Austin TX).
  Live at hub.casatrejo.com.
- **Users:** Danny Trejo (founder), RxFit staff, and Paperclip AI agents (CEO/COO/CTO).
- **Value:** unify Google Workspace (Calendar, Tasks, Drive, Gmail, Chat) + Paperclip
  orchestration + KPIs behind one AI assistant that can both **answer from** and
  **act on** that data. `/grill-me` interview gates vague work before it's created.
- **Scope:** **Multi-tenancy is DEFERRED.** MVP = RxFit single tenant. Do **not**
  build tenant-scoping work; keep config seams clean for later, don't act on them.

## Stack (essentials)

Next 14 App Router · TypeScript · vanilla CSS (Trejo design tokens) · NextAuth
(Google OAuth) · Postgres + Drizzle · pgvector · Gemini 2.5 Flash (primary) +
Claude Fable 5 (fallback rotation) · Vertex AI Discovery · Exa · Paperclip (Cloud
Run) · Cloud Run us-central1 · GitHub Actions CI/CD · GCP Secret Manager.

## Confirmed healthy — do NOT "fix"

Per-user Google OAuth isolation · JWT role/assignedProjects (server-verified) ·
SSRF protection (`content-fetch.ts`) · Gmail CRLF strip · Paperclip company-scope
filter · pgvector tenant scoping · model rotation + circuit breaker + retry +
loop-detector · CI (tsc + vitest).

## MVP must-fix (from the audit, still open)

- **P0-1** role gating on Paperclip proxy `POST`/`PATCH` (only DELETE gated today;
  partial structure exists — verify, don't trust the audit's "only DELETE" claim).
- **P0-2** server-side safety gate. *Client already fails closed* (`finalScore = 0`,
  not 80 — audit claim stale); remaining gap = Google **send** routes don't verify
  the signed `gateToken` the Paperclip path already checks.
- **P1-1** fence all untrusted prompt content (Exa/URL/Drive/attachments).
- **P1-2** auth resilience — drop `accessToken` when `token.error` set.
- **P1-3** Paperclip sibling-company model + thread `assigneeUserId`.
- **P1-4** strict Zod on list endpoints (throw, don't return raw `as T`).
- **P1-6** `delete_agent` → superadmin; validate `assigneeId` server-side.

## Verified STALE — already fixed, do NOT re-do

- Webhook auth "bypass" (CTO CRITICAL): route is fail-closed (500 if token env
  unset, 401 on mismatch) + idempotency. **Fixed.**
- `/api/embeddings/upsert`: Bearer vs `PAPERCLIP_API_KEY`, fail-closed. **Secure.**
- `prefers-reduced-motion`: comprehensive block at `globals.css:6903`. **Done.**
  (The Playwright actionability flake is therefore NOT animation — cause still open.)

## Expert-review corrections to the 18 tasks

| # | Correction (code-verified) |
|---|---|
| 13 | **DROP** — reduced-motion already implemented. |
| 15 | **DROP** — embeddings + webhook both self-authenticate. |
| 16 | **REINSTATE (P0)** — request limiter was built June 16 (`Backend_Hardening_H1_M5_C6.md`: 15 req/60s per email, in-mem Map + sweep, 429 + Retry-After, 512KB → 413) but is **gone** from code (`rate-limit.ts` absent, no limiter in `route.ts`). Re-implement from spec. *(An earlier retraction that trusted the design doc's rate-limit section was wrong; code confirms it's absent.)* |
| 14 | Clean `.txt`/`.js` cruft only. **Preserve `railway/` and the two-Paperclip-instances AGENTS.md docs** — intentional (2026-06-13). |
| 17 | `userScalable:false` is intentional for `useSwipePanels`; need swipe-**and**-zoom, not bare removal. |
| 5  | Gmail is a **secondary** surface (Calendar/Tasks/Chat primary) — lower priority. |
| 6  | Verify `search-routing.ts` / `inject-routing.ts` / `detect-intent` before building new routing. |
| 8  | `withIdleWatchdog` (30s) + 60s connect already exist; 45s is Claude-path-specific — verify skew before aligning. |
| 12 | Prior `useChatOrchestrator` extraction was reverted (no remnant); **#11 (e2e in CI) must precede.** |

## Execution wave order

- **W1 — Security & critical perf:** #1 send gate · #16 limiter recovery · #10 interview `kind` field · #7 chat-history cap.
- **W2 — Engineering foundation:** #11 e2e in CI + ESLint → #12 `useChatEngine` extraction · #6 verify/tune search routing.
- **W3 — UX & hygiene:** #2 reply subject · #3 self-host fonts · #9 completed-task undo · #4 tiny cleanups · #5 Gmail refresh · #17 zoom+swipe · #14 scoped cruft.
- **W4 — Future/verify:** #18 settings/admin/KPI coverage · #8 timeout alignment.

## Known monoliths (extract only under the e2e net)

`page.tsx` (~1668 lines) · `settings/page.tsx` (~84KB) · `globals.css` (~7200 lines).
CSS-Modules migration has begun (LeftPanelSections, GoogleChatPanel, FounderLensWizard).
