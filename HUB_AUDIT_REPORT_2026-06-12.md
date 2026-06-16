# HUB Overlay — Codebase Audit (hub/ app)

**Date:** 2026-06-12 · **Auditor:** Fable 5 · **Scope:** `hub/` Next.js 14 app (204 TS/TSX files). Static analysis only — no live app run.

`tsc --noEmit` passes clean, so every issue below is a **logic, security, or architecture** defect the compiler can't catch. Findings are ranked by severity. Nothing has been changed yet — this is for your approval before I start fixing.

---

## CRITICAL — fix before anything else

### C1. Production database password hardcoded in the repo
`drizzle/migrate.mjs:7` ships a live Railway Postgres URL **with password** as a fallback default:
```
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:PjJMKQ...@metro.proxy.rlwy.net:39263/railway'
```
Anyone with repo access has full read/write to production data across all tenants. **Rotate this credential immediately**, then remove the fallback and make the script fail loudly if `DATABASE_URL` is unset.

### C2. Multi-tenancy is architecturally non-functional — tenant is a build-time constant
This is the root cause behind the "workspace confusion" you flagged. Every server file resolves the tenant from `process.env.NEXT_PUBLIC_TENANT_ID` (defaulting to `'rxfit'`) — `lib/userRoles.ts`, `lib/agent-memory.ts`, `lib/event-logger.ts`, `lib/tenant.ts`, `app/api/kpis/route.ts`, `tool-artifacts`, `settings/kpis`, `webhooks/google`, `embeddings/upsert`, and more.

Two problems: (a) `NEXT_PUBLIC_*` vars are **inlined into the client bundle at build time**, so one deployment can only ever serve one tenant — the schema's `tenant_id` columns are decorative; (b) tenant is never derived from the request/session/host. The DB is "multi-tenant ready" but the app is hard-wired single-tenant. Any second tenant requires a fundamental change: resolve tenant from the authenticated session or request host, thread it through every query, and stop using a public env var for an authorization boundary.

### C3. Cross-tenant KPI leak via broken Drizzle query (`app/api/settings/kpis/route.ts`)
The GET handler chains `.where()` twice on a `$dynamic()` query:
```ts
let query = db.select().from(kpis).where(eq(kpis.tenantId, TENANT_ID)).$dynamic()
if (!isAdmin) query = query.where(eq(kpis.visibility, 'staff'))  // REPLACES the first where
```
I verified against drizzle-orm 0.45: the second `.where()` **overwrites** the first, so for non-admin users the tenant filter is dropped entirely and the query returns staff KPIs **for every tenant**. Latent today (one tenant) but becomes a real data breach the moment C2 is fixed. Fix: combine with `and(eq(tenantId), eq(visibility))`.

### C4. Email header injection in Gmail send (`app/api/google/gmail/route.ts`)
`to`, `subject`, and `inReplyTo` are interpolated straight into raw RFC-2822 headers with no CRLF stripping:
```ts
`To: ${to}`, `Subject: ${subjectLine}`, ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`...] : [])
```
A `to` value containing `\r\nBcc: victim@…` injects arbitrary headers (silent BCC, spoofed routing). Since the assistant can be driven to send mail through Interview Mode, this is reachable. Strip `\r` and `\n` from all header-bound fields and validate the address.

---

## HIGH

### H1. `founder-lens` writes to a directory that doesn't exist in production
`app/api/orgs/[orgId]/founder-lens/route.ts` reads/writes `process.cwd()/../orchestration/<Org>/agents/<role>/FOUNDER_LENS.md`. The `Dockerfile` build context is `hub/` only (`COPY . .` from inside hub), so `../orchestration` is absent in the deployed image — every GET returns 404/empty and every POST throws. The whole Founder Lens feature is silently broken in prod. Also, container filesystems are ephemeral, so even if present, writes wouldn't persist or reach the real agents. Needs to move this state into the DB (or Paperclip), not the filesystem.

### H2. Diagnostic endpoint leaks JWT identity to any logged-in user
`app/api/debug-auth/route.ts` returns `email`, `role`, `assignedProjects`, `sub`, and the configured `superadminEmails` list to any authenticated caller. The file header literally says "DELETE THIS FILE after diagnosing." Delete it.

### H3. Safety gate "fails open" + is driven by stale state
Two compounding issues in the action-confirmation flow:
- `app/api/chat/score-context/route.ts` returns `{score:80, passed:true}` on any Gemini error (the `catch` block). The context-sufficiency guardrail — the thing meant to stop a misinformed agent from executing — is bypassed whenever scoring errors out, including for high-stakes/destructive intents.
- In `app/page.tsx` `runQualityGate`, `finalScore = contextScore ?? 80` reads `contextScore` from a **stale React closure** (the async score fetch sets state separately), and `followUpQuestion` is declared `null` and never assigned, yet rendered as `**${followUpQuestion}**` → users literally see "**null**" in the block message. Net effect: the 80% gate rarely does its job and the failure UI is broken.

### H4. `tool-artifacts` GET has no role scoping
`app/api/tool-artifacts/route.ts` GET returns all artifacts for the (global) tenant to any authenticated session — including `onboarding` users, who are blocked everywhere else. Artifacts can contain strategic/financial analysis. Add role + creator scoping.

### H5. SSRF guard is bypassable (`lib/content-fetch.ts`)
`BLOCKED_URL_PATTERNS` matches only literal private-IP **strings** in the URL. It misses: hostnames that resolve to internal IPs (DNS rebinding), IPv6-mapped (`http://[::ffff:127.0.0.1]`), decimal/octal IP encodings, and redirect chains to internal targets. Because chat attachments fetch arbitrary user URLs server-side (with the ability to reach Google's metadata endpoint), this is exploitable. Use an allowlist or resolve-then-validate the IP, and disable redirects.

### H6. Admin can create/provision workspaces despite "superadmin only" intent
`app/api/admin/workspaces/route.ts` POST comment says "superadmin only" but the guard allows `admin` too. Workspace provisioning seeds 5 agents and mutates Paperclip org structure — decide the real policy and make code + comment agree.

---

## MEDIUM

### M1. Primary Gemini model name is invalid → every chat pays a latency penalty
`lib/gemini.ts` hardcodes `gemini-3.5-flash` as the primary model (and asserts it "verified to work"). That model id doesn't exist on the Generative Language API, so the primary call 404s on every request, waits the 2s back-off, then falls back to `gemini-2.5-pro`. You're shipping a guaranteed-fail first attempt on every message. Also model usage is inconsistent across routes: `detect-intent` uses `gemini-1.5-flash`, `tool-context` uses `gemini-2.0-flash`, `score-context` uses `gemini-2.5-pro`. Consolidate on real, current model ids.

### M2. Global mutable singletons shared across all users/tenants
`loopDetector` (`lib/loop-detector.ts`), `breaker` (`lib/circuit-breaker.ts`), and the Paperclip session cookie cache (`lib/paperclipSession.ts`) are module-level singletons. In a single long-lived container, one user's writes populate a history that can false-trip the loop detector for another user, and the circuit breaker is global across tenants. The Paperclip cookie cache is also shared, meaning all Hub users act as one Paperclip identity (see M3).

### M3. All Hub users share one Paperclip identity
`lib/paperclipSession.ts` signs in with a single `PAPERCLIP_AUTH_EMAIL/PASSWORD` and caches that cookie for everyone. Per-user authorization exists only in the Hub proxy's `assignedProjects` check; downstream Paperclip sees one super-user. If the proxy's path/role check has a gap (e.g. non-`/api/companies/<id>` routes aren't company-scoped), a user reaches anything that identity can. Acceptable as a design only if the proxy allowlist is airtight — worth a focused review.

### M4. `tool-context` ignores the API-key fallback chain
`app/api/tool-context/route.ts` checks only `process.env.GEMINI_API_KEY`, while every other module also accepts `GOOGLE_API_KEY`/`GOOGLE_GENERATIVE_AI_API_KEY`. If only the fallback var is set, this route silently degrades to canned context.

### M5. Duplicate/oprhaned migration files
`drizzle/` contains both `0000_init.sql` and `0000_special_nemesis.sql` (the journal only references the latter), plus a hand-written `migrate.mjs` that re-creates tables via `IF NOT EXISTS` in parallel to the drizzle migrations. Two competing migration systems is a drift hazard — the live schema (with `version`, `previousValue`, `sourceConfig` columns) depends on which one actually ran. Consolidate to one.

### M6. `withAuth` middleware redirects API calls instead of returning 401
`middleware.ts` matches `/api/google`, `/api/kpis`, `/api/paperclip`, etc. Unauthenticated API requests get a 302 to `/login` (HTML) rather than JSON `401`, which breaks client error handling (`useHubData` specifically branches on `status === 401`). Exclude `/api/*` from the matcher (routes already self-check) or supply an `authorized` callback that 401s for API paths.

---

## LOW / polish

- **L1.** `next.config.js` sets no security headers (CSP, HSTS, X-Frame-Options, etc.) and no `poweredByHeader:false`.
- **L2.** `detect-intent` constructs `GoogleGenerativeAI` at module scope (no lazy init like `gemini.ts`); a missing key at build/import is handled less gracefully.
- **L3.** Chat intent heuristics are crude substring matches — `needsInternalSearch` triggers on `'my '`, `'our '`, `'workspace'`; `needsExternalSearch` on `'seo'`, `'trend'`. Lots of false positives that fan out to Vertex/Exa unnecessarily (latency + cost).
- **L4.** `lib/agent-memory.ts` `deleteMemory`/`pruneExpiredMemories` default `tenantId='rxfit'` as a string literal rather than the env-derived default used elsewhere — inconsistent and a footgun under multi-tenancy.
- **L5.** Stray root-level scratch/audit files (`fix-script.js`, `audit-output*.txt`, `csuite_modal_screenshot_fixed.png`, `test-browser.js`, `test-chat.js`) and a `debug-upsert.ts` script committed alongside app code — clean up.
- **L6.** `app/page.tsx` is a 2,325-line client component holding all chat, interview, swipe, and 15 action handlers. Not a bug, but a maintainability risk and the most likely place new defects hide — worth decomposing.

---

## Suggested fix order

1. **C1 + H2** (minutes): rotate the DB password, delete the fallback, delete `debug-auth`. Stops active exposure.
2. **C3 + C4 + H5** (hours): the three concrete security bugs with clear fixes (query `and()`, header sanitization, SSRF allowlist).
3. **M1** (minutes): correct the Gemini model ids — immediate latency win on every chat.
4. **H3** (hours): make the safety gate fail *closed* for high-stakes/destructive intents and fix the stale-score/`null` UI bug.
5. **H1 + H4 + H6** (hours): founder-lens persistence, artifact scoping, workspace role policy.
6. **C2** (project): the real multi-tenancy rework — biggest effort, needs a design decision from you first (session-derived vs. host-derived tenant).
7. **Medium/Low**: batch cleanup.

I'd recommend starting with steps 1–3 as a first PR since they're high-impact and low-risk. Want me to proceed with that, or adjust priorities first?

---

## REMEDIATION STATUS — 2026-06-12 (approved scope: Critical + High + Medium)

**All 16 findings (C1–C4, H1–H6, M1–M6) are now fixed in code.** Earlier fixes from the first pass were verified in place; this session completed the remaining three:

- **C2 (multi-tenancy)** — Phase 1 implemented. `middleware.ts` now derives the tenant from the request hostname (`TENANT_HOST_MAP` env, JSON hostname→tenant map) and sets a trusted `x-tenant-id` request header, **stripping any client-supplied value first** (the Phase-0 header read was spoofable). New edge-safe resolver in `lib/tenant-map.ts`. All module-scope `const TENANT_ID = getDefaultTenantId()` constants in `settings/kpis`, `kpis/sync`, `tool-artifacts`, `founder-lens`, and `webhooks/google` converted to per-request `getTenantId()`. Single-tenant deployments need no new env vars.
- **M2 (singletons)** — `loopDetector` history is now keyed per scope (user email in the Paperclip proxy; default scope for server-side jobs), so one user's writes can't false-trip another's detector. Bounded scope map (500 scopes max). The circuit breaker stays keyed per upstream service intentionally — an upstream outage is shared state, per-user breakers would just hammer a down API.
- **M3 (Paperclip proxy)** — closed four gaps in the catch-all proxy: `onboarding` users now blocked entirely; `POST /api/companies` (workspace creation) now admin/superadmin only (was an H6 bypass); top-level `/api/agents`, `/api/projects`, `/api/runs`, and bare `/api/issues` writes restricted to unscoped users (scoped staff use the company-nested or dedicated scoped routes); `/api/issues/<id>` access by scoped users now verifies the issue's company upstream before proxying (fails closed).

**Bonus fix:** the Railway cron path for `POST /api/kpis/sync` was unreachable — middleware 401'd the cookie-less cron request before the route's `x-cron-secret` check could run. The route is now auth-exempt in middleware (it fully self-checks admin-session-or-cron-secret).

**Verification:** scoped `tsc --noEmit` over every changed file + its dependency graph = 0 errors; loop-detector behavior verified with 5 runtime assertions (including per-scope isolation and back-compat for default-scope callers); host→tenant resolution verified with 4 runtime assertions.

**Still requires Danny (manual):**
1. Rotate the leaked Railway Postgres password (see `REMEDIATION_PLAN_2026-06-12.md` §1) — code no longer contains it, but the credential must be treated as compromised.
2. When a second tenant onboards: set `TENANT_HOST_MAP` (e.g. `{"hub.rxfitatx.com":"rxfit","hub.other.co":"other"}`) and review the L-series polish items (security headers, `app/page.tsx` decomposition).
