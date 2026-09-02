# Sentinel — Error Reporting Architecture for `casatrejo-hub`

**Status:** Canonical spec · **Date:** 2026-08-24 · **Target:** `hub/` on `next@^14.2.35`, Cloud Run `hub` / `rxfit-automation` / `us-central1`

**How this document was produced.** Eight independent web-research passes (Next.js App Router error instrumentation, error-tracking vendors, error-record schemas and grouping, browser capture surfaces, the Cloud Run/pino server pipeline, SRE alerting doctrine, TypeScript error modeling, LLM-app failure taxonomy) and a four-area audit of this repository, fed into three competing architecture proposals written to different priorities, scored by three independent judges, synthesized, then attacked by an adversarial reviewer and a completeness critic. Every correction those two produced has been applied.

**Verification status.** Counts marked **✱** in §2.2 and every claim in Appendix A were re-derived directly against the tree on 2026-08-24. Two external facts are load-bearing and were verified against primary sources rather than memory: `onRequestError` was introduced in **Next v15.0.0** (official version-history table) and is therefore a **silent no-op on 14.2.35**; and `register()` *does* work on 14.2.35 but **requires `experimental.instrumentationHook = true`**, without which the file is parsed and never imported.

---

## 1. Executive summary

**The recommendation, in plain language:** the hub does not need an error-tracking product. It needs one canonical fault record, one normalizer that every layer funnels into, and one push channel — and it already owns working implementations of every hard part except the funnel itself.

Today an unexpected error in a hub API route reaches, at best, an unstructured Cloud Run stdout line that nothing aggregates, alerts on, or persists; at worst it reaches nothing at all. Client-side errors reach nothing, ever. The root cause is singular and mechanical: **there is no route wrapper.** `grep` for `withErrorHandling|apiHandler|wrapHandler|withRoute` across `hub/` returns zero hits. Every one of the 112 exported handlers is on its own — its own try/catch (or none), its own logger choice, its own status code, its own response body — which is why 21 handlers have no catch at all, 33 catch blocks log nothing, and 58 distinct error-response shapes exist.

**Sentinel** adds one concept, not one subsystem: a `FaultRecord` that becomes the fifteenth member of the discriminated union already living in `hub/lib/observability.ts`. That union already has a working emitter (`emit()`), a lazy best-effort DB sink into `event_log`, a hard PII test guarding it, and an aggregation page reading it. Phase 1 ships with **zero database migrations**, because `event_log` already has exactly the right columns (`payload jsonb`, `correlation_id`) and an index that serves the aggregation read (`event_log_type_created_idx` on `(event_type, created_at)`, `hub/lib/schema.ts:87`). It does **not** serve the tenant-scoped prune or a fingerprint lookup — Phase 4 adds those indexes (§8).

Nothing new gets stood up. The alerting spine is `lib/dispatch-alerts.ts` — durable cross-instance dedup, a 6-hour re-alert window, affirmative-clear-only recovery, Google Chat delivery, and a deliberate failure path where an undeliverable alert fails the GitHub workflow so GitHub's email becomes the last-resort channel for a dark Hub. The scheduler is `.github/workflows/dispatch-alert.yml`, already firing hourly at `:07`. The cron auth is `verifyCronSecret`. The redaction discipline is the pure-mapper pattern proven twice in `toRunRow` and `toAuditRow`. The correlation id is `withCorrelationId`, which has existed at `lib/logger.ts:20` since day one **with zero callers** — Sentinel's layer 0 is just calling it.

**What it costs.**

| | |
|---|---|
| Recurring cash | **$0/month.** No vendor, no new npm dependency, no new GCP product, no new secret, no new container, no new database. |
| Marginal infra | Cloud Logging ~600 B/fault; a pessimistic 5,000 faults/day ≈ 90 MB/month against a **50 GiB/project/month free tier** → $0. Postgres: ~150k rows steady-state at 30-day retention, ~120 MB, on an instance already carrying `ai_runs`. GCP Error Reporting: free, already enabled on Cloud Run, default SA already holds `roles/errorreporting.writer`. |
| Phase 1 engineering | ~1,000–1,200 LOC across ~22 files, 2 agent sessions, 2 auto-mergeable PRs (split at pure-modules+tests / wiring). |
| Full six phases | ~4,000–4,500 LOC, 8–10 agent sessions, 14–16 auto-mergeable PRs. |
| Ongoing operator time | Near zero by design. Roughly one hour a month of fingerprint tuning in the first quarter, trending to zero. The system pushes at Danny; nobody opens a dashboard to learn something is wrong. |
| Named upgrade trigger | A second human needs a login, **or** fingerprint tuning exceeds 4 hours in a quarter → adopt Sentry Team at **$26/mo billed annually**. Reversible: instrumenting to the Sentry wire format is also accepted by Better Stack and self-hosted Sentry. |

**The three structural bets, stated plainly:**

1. **A higher-order wrapper applied at the export site is the only available mechanism.** Vercel discussion #59868 confirms middleware structurally cannot catch route-handler exceptions, and `onRequestError` landed in Next **15.0.0** — writing it on `14.2.35` is a silent no-op that reads as done. Enforcement is a brand-checking test, not a lint rule and not a grep.
2. **Alerts fire on NEW / REGRESSED / ESCALATING fingerprints, never per occurrence.** A solo founder with a design target of *median zero pages per day* is the constraint. Google's SRE Workbook is explicit that at this traffic level a single failed request out of ten reads as a 1000× burn rate; copying the 99.9%/14.4× recipe here would page on one flaky request.
3. **Absence of errors is not evidence of health.** `persistTelemetryEvent` (`lib/observability.ts:128`) swallows every failure, so a Postgres outage today produces *zero* faults — which reads as perfect health. Sentinel counts its own dropped writes and alerts on silence. Two prerequisites make this real rather than aspirational, and both are called out where they bite: `recordEvent` must be able to **report its own failure** (today it cannot — it catches internally and resolves, so `sinkFailed` has no wiring, §8), and the tick's staleness detector must live **outside the tick** (§3 Layer 10). This is the only part of the design a bought tool would not have given for free, and it is the part that makes the whole system trustworthy for an operator who is not watching.

---

## 2. What breaks today

Everything in this section is a count or a `file:line` from the audit. Counts marked **✱** were **re-derived directly against the tree**, most recently on 2026-08-25 after merging `master` at `b2eade0` (#214, which added `app/api/runs/route.ts`), and are load-bearing. They move with every merge — treat the *shape* of the finding as durable and the digit as a snapshot. Unmarked derived counts came from the 2026-08-20 audit pass and must be regenerated by `scripts/gen-fault-pending.mjs` before Phase 2 is scoped — do not treat them as exact.

### 2.1 The headline: there is no general error sink

Only the AI path (4 of 14 telemetry event types) and 11 hand-placed `recordEvent` sites produce a durable, queryable record. Everything else is an unread stdout line.

**Where a production error goes today, case by case:**

| Case | Fate |
|---|---|
| Throw in one of the 4 `SectionErrorBoundary`-wrapped left-panel sections | `console.error('[SectionErrorBoundary]', …)` → **browser console only** (`app/components/LeftPanelShared.tsx:206`) |
| Any other client render throw | `console.error('[GlobalError]', error)` → **browser console only** (`app/error.tsx:13`), then the raw stack is rendered into a `<pre>` for the user (`app/error.tsx:49-51`) |
| Throw in `app/layout.tsx`, `Providers`, `QueryProvider`, `TenantProvider` | Uncatchable. No `app/global-error.tsx` exists. Next's built-in 500 page, **zero telemetry** |
| Client event-handler throw or unhandled promise rejection | Boundaries don't catch these; there is no `window.onerror` and no `unhandledrejection` listener. **Reaches nothing at all** |
| Route handler error in the 12 Google route files | `return googleApiErrorResponse(error)` — the helper logs nothing, emits nothing, records nothing (`lib/google-session.ts:106-121`). **No server-side trace whatsoever** |
| Route handler error in one of the 21 genuinely unguarded handlers | Opaque Next 500. No structured line, no `correlationId`, no telemetry event, no `event_log` row |
| Chat route 500 before streaming starts | `log.error` only (`app/api/chat/route.ts:868-874`) — **no `emit()`**. Produces an `ai_request_start` with no terminal partner, so `computeAiHealth`'s `requests = completes + errors` (`lib/ai-health.ts:226`) silently *excludes* it rather than counting it as a failure |

### 2.2 The counts

| Metric | Value |
|---|---|
| API route files / exported handlers ✱ | **76 / 112** (GET 55, POST 41, DELETE 8, PATCH 5, PUT 3) |
| Route files containing **no** `catch` at all ✱ | **4** — `admin/semantic-brain-health`, `auth/[...nextauth]`, `cron/dispatch-alert`, `google/chat/me` |
| `createLogger(` call sites vs raw `console.*` calls ✱ | **38** vs **147** (75 in `app/`, 72 in `lib/`) — ~4× more unstructured logging than structured |
| `emit(` / `recordEvent(` call sites ✱ | **36** / **13** |
| Empty-or-swallowing catch sites ✱ | **31** (`catch {}`, `.catch(() => {})`, `.catch(() => undefined)`) |
| `googleApiErrorResponse` call sites ✱ | **44** |
| `fetch(` sites in `app/` (client components + hooks) ✱ | **98** (**80**) — with **no** shared wrapper |
| `catch` blocks in `app/components` + `app/hooks` ✱ | **102** |
| `withCorrelationId` callers ✱ | **0** (only its own definition, `lib/logger.ts:20`) |
| Handlers with **no** catch-all | 25 (~21 genuinely unguarded; 4 delegate to `proxyRequest`'s own catch) |
| Catch-all blocks that log **nothing** | 33 of 86 (38%) — 25 of them the Google cluster |
| Catch blocks reaching structured pino | 20 of 86 (23%) |
| Catch blocks using raw `console.*` | 35 of 86 (41%) |
| Routes with **zero** logging of any kind | 27 of 75 (36%) |
| Routes importing `lib/logger` | 18 of 75 (24%) |
| Distinct error-response shapes | 58 (status × key-set); ~38 distinct key-sets; three competing envelopes (`error:` ×447, `ok:` ×35, `success:` ×12) |
| Raw internal error text returned to clients | ~42 sites (22 direct + 20 files via `googleApiErrorResponse`'s raw-message fallback) |
| Routes gating error detail on `NODE_ENV` | **1** (`app/api/chat/route.ts` via `lib/chat-error.ts:7-15`) |
| `.catch(` sites in app+lib | 132, of which **121 (92%)** are zero-arg — the error object is never even bound |
| `.catch(() => [])` / `.catch(() => null)` — silent **data omission** | 11 + 7 = 18 |
| `void someCall()` fire-and-forget statements | 33 |
| Client-side `console.*` calls in the entire client surface | **3** |
| Client→server error transports | **0** |
| Route error boundaries | 1 (`app/error.tsx`); `global-error.tsx`: 0 |
| External error-tracking deps in `package.json` | 0. No `instrumentation.ts`. `next.config.js` has no `experimental` key |
| `export const VERB =` forms in `app/api` | **0** — every handler is `export async function VERB` |
| Tables with **zero** retention | `ai_runs`, `ai_action_log`, `tool_runs` (no `.delete()` anywhere) |

### 2.3 What is specifically invisible

- **`lib/google-session.ts:106-121`** — `googleApiErrorResponse` is called **44 times** across the Google route cluster and contains zero log lines. This one function is simultaneously the largest silent-failure cluster and the largest raw-message leak surface in the repo.
- **`lib/retry.ts`** — 69 lines, zero observability. Retries, backoff waits, and the retryable/non-retryable classification at `retry.ts:19-33` are entirely invisible. A route that burns 3 attempts × exponential backoff looks identical to a fast success in every log we keep.
- **HTTP 200 carrying an error.** `app/api/companies/route.ts:63` returns `{ companies: [], error: 'Failed to load companies' }` with **no status** (= 200). `app/api/projects/route.ts:72` does the same. `app/api/auth/register/route.ts:60` returns `{ registered: false, reason: 'write_failed', detail: message }` at 200. React Query treats all three as success, so the UI renders a confident empty state over a live backend failure — precisely the failure mode a solo operator cannot catch by eye.
- **Silent data omission.** `app/api/google/calendar/route.ts:47` does `.catch(() => [])` per calendar, so one failing calendar disappears from the merged list and the user is told they have no events.
- **Orphaned dispatch cleanup.** `lib/agy-dispatch.ts:150-210` has seven `void cancelJob(jobId).catch(() => {})` / `void settleAbandoned(…)` calls on the abort, budget-exhaustion, claim-timeout and lease-expiry paths. Each is cleanup for an already-failing dispatch; if cleanup fails the job is orphaned with no trace. `app/api/deep-runs/route.ts:147,151` is worse: `finishToolRun(…).catch(() => null)` failing leaves a `tool_run` row `queued` forever, permanently consuming the concurrency cap the code's own comment at line 146 says it is protecting.
- **The two log seams cannot be joined.** `emit()` writes `requestId`; `createLogger` writes `correlationId`. `withCorrelationId` (`lib/logger.ts:20-22`) has zero callers. The pino line carrying the stack and the telemetry line carrying the lifecycle are not correlatable in Cloud Logging.
- **A permanently-null metric.** `AiHealth.firstTokenMs.p50` can never populate, because `ai_first_token` is excluded from `PERSISTED_EVENT_TYPES` (`lib/observability.ts:81-86`). `lib/ai-health.ts:97-99` admits this in a comment.
- **The alert engine that exists is dead code.** `computeAiHealth` produces a fully-formed `alerts[]` with five named thresholds (`lib/ai-health.ts:19-27`). Nothing pushes them. `app/admin/ai-health/page.tsx:60` fetches once in a `useEffect` with a manual Retry button — no polling, no auto-refresh. It requires a human to open it.
- **`listAiRuns` (`lib/runs.ts:217-239`) has zero callers.** The richest structured ledger in the app has no read surface.
- **Retention is welded to a user-triggered button.** `pruneOldEventLogs` (`lib/agent-memory.ts:108-114`) is called only from `app/api/kpis/sync/route.ts:210` — and `POST /api/kpis/sync` is reachable from the settings UI (`app/settings/page.tsx:593`). A user clicking "sync KPIs" silently triggers a 30-day delete. It is also tenant-scoped, so rows under any other `tenant_id` are immortal. `hub/docs/architecture/HARDENING_REVIEW_2026-08-20.md:119` already lists decoupling it as an open item.
- **Doc drift that will mislead the next agent.** `next.config.js:4-6` claims "a strict Content-Security-Policy is intentionally omitted here" — false; `middleware.ts:45-57` ships a strict nonce CSP. `app/api/admin/ai-health/route.ts:29-31` claims the `(event_type, created_at)` index is missing — it exists at `lib/schema.ts:87`.

### 2.4 The two hard constraints that shape everything below

```
connect-src 'self';                                      // middleware.ts:55, production (the isDev ternary is empty)
script-src 'self' 'nonce-…' 'strict-dynamic';            // middleware.ts:47
```

Every third-party beacon — Sentry, LogRocket, Datadog RUM, Bugsnag, Highlight — is blocked by construction. Any client error transport must be same-origin. And `next@14.2.35` means no `onRequestError`, no `instrumentation-client.ts`, no `retry()` prop, no `catchError`.

---

## 3. The recommended architecture, layer by layer

### Layer 0 — The correlation spine (prerequisite for everything else)

**Mechanism.** Mint one id in `middleware.ts` **where middleware actually runs**, using the `crypto.randomUUID()` already called there for the CSP nonce. Set it on the cloned `requestHeaders` (the clone already exists) as `x-hub-request-id`, and echo it on the response.

**The matcher is the catch.** `middleware.ts:113` excludes `api/chat`, `api/worker`, `api/cron/`, `api/healthz`, `api/embeddings`, `api/webhooks`, `login`, `_next` and static assets — i.e. streaming chat, the desktop-dispatch worker routes and the cron tick, which are precisely the priority paths in Layers 5, 6 and 7. On those paths **there is no middleware and `withFault` is the only spine**: it mints its own id when the header is absent and parses `traceparent` itself. Middleware also returns at `middleware.ts:22-27` for unauthenticated requests **before** the nonce/CSP block, so those responses carry neither CSP nor reporting headers.

**Never trust an inbound `x-hub-request-id` on an excluded path.** A caller supplies it unvalidated there — the same injection class middleware already defends against by deleting `x-tenant-id`. `withFault` validates shape (`/^[0-9a-f-]{36}$/`) and length, and mints fresh on any non-matched path.

`withFault` reads it, passes it to `createLogger(name, requestId)`, into `emit()`, into `recordAiRun`, and into `event_log.correlation_id`. Also parse Cloud Run's injected `traceparent` (prefer it over `X-Cloud-Trace-Context`, whose span id is **decimal** while `LogEntry.spanId` must be 16-char hex) and emit `logging.googleapis.com/trace` as `projects/rxfit-automation/traces/${traceId}`. That single field is what nests container logs under the request log in Logs Explorer.

**`lib/logger.ts` must be refactored first.** `createLogger()` (`lib/logger.ts:7-18`) calls `pino(...)` fresh on every invocation, and in dev allocates a new `pino-pretty` stream each time. Calling it per request across 112 routes is a per-request logger-plus-stream allocation. Refactor to a single module-scope root `pino()` instance plus `root.child({ module, correlationId })`, preserving `createLogger`'s signature. `withFault` must never construct a pino instance per request.

**Files:** `hub/middleware.ts` (modify), `hub/lib/logger.ts` (refactor to a module-scope root + child; actually call `withCorrelationId`, which has zero callers today), `hub/lib/fault.ts` (new), `hub/lib/route-fault.ts` (new).

---

### Layer 1 — Client: render, event handlers, promises, fetch, resource loads, CSP

Six capture surfaces, one same-origin transport.

**(a) `app/error.tsx`** — keep the boundary; add `useEffect(() => reportClientFault({ code: 'client_render', digest: error.digest }), [error])`. **Stop rendering `error.stack` in production** (lines 49-51 currently print a raw stack into the production UI — client-component throws are *not* digest-masked by Next). Show `faultId` + `digest` only.

**(a2) Carry the `digest` through.** A Server Component throw (e.g. `app/admin/knowledge/page.tsx`) is digest-masked in production: the client sees only an opaque `digest` string and the server's only record is Next's own unstructured stdout line. `withFault` cannot see RSC render errors and `onRequestError` does not exist on 14.2, so this is a genuine blind spot. Mitigate, do not pretend: `error.tsx` and `global-error.tsx` both send `error.digest` in the client fault, and `hub/docs/runbooks/fault-reporting.md` documents the Logs-Explorer query that joins a digest to Next's line. The blind spot closes for free on a Next 15 upgrade.

**(b) NEW `app/global-error.tsx`** — a throw in `app/layout.tsx:99-103` (Providers → QueryProvider → TenantProvider) is currently uncatchable. It must render its own `<html>`/`<body>` and import its own styles. On 14.2.x it does **not** render in `next dev` (that landed in 15.2), so it must be verified against `next build && next start`.

**(c) `SectionErrorBoundary.componentDidCatch`** (`app/components/LeftPanelShared.tsx:206`) — replace the bare `console.error`. This call is **mandatory, not redundant**: in production `componentDidCatch` errors do not bubble to `window`. Generalize the boundary beyond its 4 left-panel uses to wrap chat, the right panel, and `ToolPanel`.

**(d) NEW `app/components/FaultListeners.tsx`**, a client component mounted inside `Providers`:
- `window.addEventListener('error', h, true)` — **capture phase**, the only way to see resource-load failures (a 404'd `/_next` chunk, a broken image, a failed stylesheet). Those dispatch at the element and do not bubble. Branch on `event.target === window` for script errors vs an element for resource errors, and **re-check after ~500 ms** (`complete && naturalWidth > 0`, or detached) — React aborts in-flight `<img>` requests during re-render and will otherwise flood you with phantoms.
- `'unhandledrejection'` and `'rejectionhandled'` — the latter *retracts* a report when a handler attaches late, which TanStack Query and Suspense resources legitimately do.
- `document.addEventListener('securitypolicyviolation', …)` for CSP blocks, which no JS error handler and no console patch can ever see.
- `new ReportingObserver(cb, { types: ['deprecation', 'intervention'], buffered: true })`. The `buffered: true` is load-bearing — on 14.2 there is no `instrumentation-client.ts`, so it is the only way to see reports fired before the observer existed.
- `Error.stackTraceLimit = 50`. V8's default of 10 frames is often entirely React internals.

**(e) `app/providers.tsx`** — the single highest-leverage client edit. The production `QueryClient` at lines 17-27 has no error handling at all. Add `queryCache: new QueryCache({ onError })` and `mutationCache: new MutationCache({ onError })`. **Cache level, never `defaultOptions`**: cache callbacks fire once per cache entry (not once per mounted observer, so no duplicates) and always run even when a hook defines its own local `onError` (so no misses). One file instruments every React Query hook in the app. Suppress benign session churn with the existing pure predicate `shouldTriggerReauth` (`app/hooks/useHubData.ts:62`).

**(f) `app/hooks/useWriteFetch.ts`** — extend the existing wrapper (already handles 401 → `signIn('google')` and attaches `.status`) with reporting and an `x-hub-request-id` header, and add a `readFetch` sibling. Classify honestly: `!res.ok` → server error with status/method/route (fetch does **not** reject on 500); `err.name === 'AbortError'` → cancelled, never a fault; anything else → one bucket labelled *network/CORS/blocked — cause unavailable*, because the platform deliberately makes those indistinguishable. Never claim otherwise on a dashboard, and never use `navigator.onLine` as a positive classification. Migrate the 80 native fetch sites (components + hooks + settings) incrementally, highest-count files first: `app/settings/page.tsx` (14), `useGmailInbox.ts` (9), `useGoogleChat.ts` (6), `useChatEngine.ts` (6).

**Transport.** `app/lib/fault-client.ts` → module-scope dedupe + per-fingerprint token bucket (copy the single-flight latch idiom at `useHubData.ts:18`) → `fetch(url, { keepalive: true })` normally, `navigator.sendBeacon` on `visibilitychange → hidden`. **Never on `unload`** — unreliable on mobile and it evicts the page from bfcache. Cap the payload at 16 KB and track your own in-flight keepalive byte total: the 64 KiB limit is a *shared* budget across all keepalive requests, not per-request.

**Accepted blind spot:** crashes during hydration itself. There is no `instrumentation-client.ts` on 14.2, so a root-layout client component is the earliest available hook. This closes for free on a Next 15.3+ upgrade, which is deliberately not on this critical path.

**Files:** `hub/app/error.tsx`, `hub/app/global-error.tsx` (new), `hub/app/components/FaultListeners.tsx` (new), `hub/app/lib/fault-client.ts` (new), `hub/app/layout.tsx`, `hub/app/components/LeftPanelShared.tsx`, `hub/app/page.tsx`, `hub/app/providers.tsx`, `hub/app/hooks/useWriteFetch.ts`, `hub/app/hooks/useHubData.ts`.

---

### Layer 2 — Edge / middleware

`middleware.ts` runs on the Edge runtime: no pino, no `node:crypto` import, no DB. Four changes.

1. **Mint and propagate `x-hub-request-id`** (layer 0).
2. **Wrap the handler body in try/catch**, emitting one dependency-free JSON line via `console.log` with `severity: 'ERROR'` and `layer: 'edge'`, formatted by a new pure `lib/fault-line.ts` that imports nothing (usable from both runtimes). The catch must **never swallow into a failure**: return `NextResponse.next()` so a telemetry bug cannot take down routing.
3. **Matcher surgery at `middleware.ts:113`** — add `api/client-fault` to the exclusion list. The current matcher returns a JSON 401 for every unauthenticated `/api/*` (`middleware.ts:22-24`), so client reports would be rejected in exactly the dead-session scenario most worth capturing — this app's documented recurring failure mode. The route then guards itself with an **allowlisted** `Origin`/`Referer` check plus `checkActionLimit(hashIp(ip), 'client_fault')` (`lib/rate-limit.ts:100`) under a new `client_fault` entry in `ACTION_LIMITS`. Note the real signature is `checkActionLimit(email, actionType, now?) => { allowed, retryAfterSec? }` — it returns an object, not a boolean, and it is keyed by identity, so an unauthenticated reporter needs an explicit key. Use `hashIp()`, built on the same `hashEmail()` construction, so §7's own HIPAA framing (which enumerates IP addresses as identifiers) is not contradicted by the limiter key.
4. **Ship the browser reporting headers on every *middleware-matched, authenticated* response** — plus, for the excluded set and the 401/redirect paths, via `next.config.js`'s existing `headers()` block (`source: '/:path*'`), which runs regardless of the matcher. Reporting API v1 is *document-scoped*, not origin-scoped, so setting it only on the HTML document silently yields nothing:
   ```
   Reporting-Endpoints: default="/api/client-fault?kind=report", csp="/api/client-fault?kind=csp"
   ```
   and append `report-uri /api/client-fault?kind=csp; report-to csp` to the CSP string. **Ship both directives** — browsers supporting `report-to` ignore `report-uri` and older ones ignore `report-to`. An endpoint named exactly `default` is required or deprecation/intervention/**crash** reports are generated and silently never sent. Crash reports are the one class no JS handler can ever observe, and CSP violations are the class that survives the scenario where the CSP blocks the app's own bundle so `FaultListeners` never mounts — the exact shape of the 2026-07-13 nonce outage documented at `app/layout.tsx:40-49`.

**Files:** `hub/middleware.ts`, `hub/lib/fault-line.ts` (new), `hub/app/api/client-fault/route.ts` (new), `hub/lib/rate-limit.ts`.

---

### Layer 3 — Route handlers (112 handlers / 76 files) and Server Actions

**Mechanism: a higher-order wrapper applied at the export site.** This is the mechanism, not a workaround — middleware provably cannot catch route-handler throws, and `onRequestError` does not exist on 14.2.35.

`lib/route-fault.ts` exports `withFault(name, handler)` with a **fixed duty order**:

1. Read or mint `x-hub-request-id`.
2. Bind a pino child via `createLogger(name, requestId)`.
3. Run the handler.
4. **Re-throw Next control-flow errors FIRST.** `redirect()` and `notFound()` work by throwing; a naive catch converts every intended navigation and 404 into a fake 500 and floods the tracker. Detect via the `NEXT_REDIRECT` / `NEXT_NOT_FOUND` digest string, **never** `instanceof`.
5. Inspect its own 2xx responses **only when it is safe to do so**: `content-type` is `application/json` **and** `content-length` is present and ≤ 64 KB. Read via `res.clone()`, never the original. Skip entirely for `text/event-stream`, any streamed body, and any response with no `content-length` — `app/api/chat/route.ts:411` returns a `ReadableStream`, and any proxy route returns an upstream body it does not own; reading or cloning either consumes or buffers the whole stream in memory on Cloud Run. The gate is written against the *shape* of the response, never against a list of routes, so it stays correct as routes are added or removed. Within those limits, a 2xx JSON body carrying an `error`/`reason` key or `ok:false`/`success:false` throws in development and emits a `contract_violation` fault in production. This catches an entire class **structurally**, so nobody has to remember.
6. `toFault(err, ctx)` → `reportFault()` → `faultResponse()`.
7. Stamp a non-enumerable brand symbol on the returned function.

**Enforcement is a test, not a lint rule.** `tests/route-fault-coverage.test.ts` globs `app/api/**/route.ts`, dynamic-imports each module, and asserts every exported GET/POST/PUT/PATCH/DELETE carries the brand. A brand check beats grepping source for `withFault` (which passes on a commented-out import) and beats a lint rule (which cannot see through re-exports).

**Polarity matters.** A hand-maintained allowlist naming ~107 not-yet-wrapped files is a ~110-line literal every PR must edit, and — fatally — it *silently passes for a newly added unwrapped route*. Instead: the test asserts every exported verb either carries the brand or appears in a **`PENDING` set generated by `scripts/gen-fault-pending.mjs`** and regenerated per PR. A route in **neither** set **fails**, so a new unwrapped route cannot be added. `PENDING` shrinks one directory per PR and the failure message names each remaining gap by file path.

**And "zero" must mean "zero unexplained."** Three handlers can never take the wrapper as written: the NextAuth catch-all (`app/api/auth/[...nextauth]/route.ts` re-exports `NextAuth(authOptions)` directly), the SSE chat route (wrapped, but with body inspection skipped), and the Google webhook receiver (which must always ack 200). Add a `PERMANENT_EXEMPTIONS` map requiring a **reason string**, asserted by the same test.

**Priority order.** The genuinely unguarded write paths first: `app/api/worker/jobs/[id]/result/route.ts:76` (a throw loses a completed desktop job's result), `.../heartbeat/route.ts:16` (a throw silently breaks lease heartbeats and surfaces later as phantom "worker went silent" cancellations), `app/api/orgs/[orgId]/founder-lens/route.ts:49,94`, `app/api/cron/dispatch-alert/route.ts:23`, `app/api/deep-runs/[id]/route.ts`. Then the Google cluster.

**The single highest-leverage edit in the whole design:** add `log.error` + `reportFault` inside `googleApiErrorResponse` (`lib/google-session.ts:106-121`) and swap its raw-message fallback at line 120 for `faultResponse`. This closes 25 of the 33 fully-silent catch blocks in one function.

**But it is not a one-function edit.** The current signature is `googleApiErrorResponse(err: unknown)` — no `requestId`, no route, no method. Faults raised through it would land with `requestId: null` and could not join the pino seam, which is Phase 1's headline win. The signature must gain a required context argument, `googleApiErrorResponse(err, ctx: { requestId, route, method })`, so **all 44 call sites change too**. That is a mechanical 44-site edit, not a one-line win — budget it as such. **Keep its classification logic verbatim** — `mapGoogleErrorToStatus`, `isApiNotEnabledError` → the dedicated non-reauth `API_NOT_ENABLED` 403, `MISSING_SCOPE`, the reauth flag. Those encode real documented incidents (the infinite "Authorize → consent → same error" loop) and must be mapped onto `FaultCode`, never flattened.

**NextAuth is uninstrumented and cannot be wrapped.** `app/api/auth/[...nextauth]/route.ts` re-exports `NextAuth(authOptions)` directly, so no route wrapper will ever see it — and every refresh/role/signIn failure in `lib/auth.ts` uses a raw `console.error` (lines 270, 346, 351) inside callbacks. This is the app's **documented recurring failure mode** (the hourly forced-relogin bug whose analysis fills the header of `app/components/Providers.tsx`), and today it is invisible. Instrument `authOptions.callbacks.jwt` / `signIn` and the `events` hooks instead of the route: map `REFRESH_FATAL_ERROR` → `auth_reauth_required` and `REFRESH_TRANSIENT_ERROR` → `degraded`. This is a `PERMANENT_EXEMPTIONS` entry with that reason string, not a gap in coverage.

**Server Actions.** `app/admin/knowledge/actions.ts` is the repo's only `'use server'` file. It gets `withActionFault`, which **returns** `{ ok: false, code, userMessage }` rather than throwing. An uncaught throw in an action runs inside a transition, escalates to the nearest error boundary and blows up the whole segment, *and* has its message masked to a generic string in production — so the user-facing text is destroyed.

**Files:** `hub/lib/route-fault.ts` (new), `hub/lib/google-session.ts`, `hub/app/api/**/route.ts` (75 files, mechanical export-site change), `hub/app/admin/knowledge/actions.ts`, `hub/tests/route-fault-coverage.test.ts` (new), `hub/lib/chat-error.ts` (generalized into `faultResponse`).

---

### Layer 4 — Library / service layer: Google, AI providers, Postgres, vector store

**Classification lives in exactly one place** — `toFault(err, ctx)` in `lib/fault.ts` — recognizing, in order:

1. An existing `FaultRecord` / `AppError` → pass through.
2. `ZodError` → `validation_failed`, 422, `expected`. Keep `issues[].path` only, **never `issues[].input`**; leave Zod's `reportInput` at its default (off). With `lib/secret-crypto.ts` and Google OAuth tokens in play, enabling it would put credentials into error logs. **Do not import `zod/v4` in Phase 1.** A `ZodError` from `zod/v4` is not `instanceof` the `ZodError` from the `zod` root that 13 routes use, so an `instanceof` check would silently mis-classify half of them as `internal`. `toFault` therefore recognizes ZodError **structurally** — `err.name === 'ZodError' && Array.isArray(err.issues)` — never by `instanceof`, which also means it survives a later v4 migration untouched.
3. The repo's five existing ad-hoc `extends Error` classes — `CircuitOpenError`, `LoopDetectedError`, `InvalidPageTokenError`, `SecretCryptoError`, and `PaperclipSchemaError` (transitional — Paperclip is retired and being removed per `AGENTS.md`; recognize it while it exists, never build on it, and drop it with the rip-out) — **structurally recognized in `toFault` in Phase 1**, and retrofitted onto one `AppError` base in **Phase 2 only, one class per PR, each shipping with its existing suite green**. The retrofit is not free: five live control-flow paths (`lib/circuit-breaker.ts`, `lib/dispatch-store.ts`, `lib/secret-crypto.ts`) match these today by `instanceof` **and** by message text, so a base-class swap is a behavior change, not a refactor. `Object.setPrototypeOf(this, new.target.prototype)` and `Error.captureStackTrace?.(this, new.target)` go in that ONE base constructor (`new.target`, never a hardcoded class, or `instanceof` breaks for subclasses), and the options object MUST be forwarded as `super(message, { cause })` or ES2022 silently never installs `cause`.
4. Google errors via the existing `lib/google-session.ts` mappers.
5. Postgres error codes (`err.code`), plus `isMissingTableError` from `lib/dispatch-store.ts:51` → `db_table_missing` at severity `fatal`, because `docker-entrypoint.sh` is deliberately **non-fatal** on migration failure (the 2026-07-10 outage) so a missing table is a live runtime possibility.
6. AI provider shapes — and **never branch on `err.status` for a streamed call.** A mid-stream Anthropic `overloaded_error` arrives on a committed HTTP 200; a filed `anthropic-sdk-python` issue (#1258) documents a production fallback router silently no-op'ing because `status_code` was 200.
7. Else → `internal`, `isExpected: false`, `cause: err`.

**Per-provider mapping is a table, not a hand-wave — and it must be seeded from the live ledger.** Each provider signals differently: Gemini via `promptFeedback.blockReason` and `finishReason: SAFETY | RECITATION | MAX_TOKENS`; Anthropic via `stop_reason` plus typed error bodies; agy via its own documented failure classes (`not_configured | not_installed | install | auth | empty | timeout | parse | spawn`). `hub/docs/runbooks/agy-gateway.md` is a **canonical document** under `CLAUDE.md`'s doc-precedence rule, and its failure-class table wins over anything restated here. Build one `providerFault()` mapping per provider in `lib/gemini.ts` / `lib/claude.ts` / `lib/agy-chat.ts`, **seeded from the `ai_runs.error_class` values already in production**, so the new taxonomy cannot fork from the ledger the app already writes.

**Vector/brain and ingest failures need an actual capture path.** `vector_store_error` is in the union but nothing raises it. Map `lib/vector-store.ts` embedding calls and pgvector queries onto it, and note `lib/ingest-client.ts:101` returns `{ success: false, error }` — another success-shaped failure that no error-rate alert can see. Add the `EMBEDDING_MODEL` cross-space case as a **`degraded` invariant** in the reconciliation sweep: "0 chunks returned while rows exist on a stale embedding model" makes stale rows *invisible* rather than erroring, which is the worst shape a failure can take.

**`lib/retry.ts`** gets an `onAttempt` hook. Attempts are counted onto the eventual record; **a retry that eventually succeeds produces one `degraded` fault with `retryCount:n`, never n errors.** OpenTelemetry is normative here: "Errors that were retried or handled (allowing an operation to complete gracefully) SHOULD NOT be recorded on spans or metrics that describe this operation." This single rule is the difference between a real error rate and one inflated by the retry factor.

**`lib/circuit-breaker.ts`** already writes durable `circuit.tripped` / `circuit.reset` events (lines 67-93). Map a trip to `upstream_breaker_open`, which must be **non-retryable**, so logs distinguish "we tried and the dependency said no" from "we did not try, by policy".

**NEW `lib/swallow.ts`** exporting `swallow(err, ctx)` and `emptyOn(err, ctx, fallback)` to replace the 121 zero-arg `.catch(() => …)` sites. `swallow` logs at debug and increments a counter; `emptyOn` additionally sets `partial: true`. The distinction is load-bearing and permanent: it separates the 18 **silent data omission** sites from the ~100 benign localStorage/format guards, so nobody has to re-derive that judgment. Note the 6 `recordEvent(...).catch(() => {})` sites are **not** losing errors — `recordEvent` already catches internally and does `log.error` at `event-logger.ts:41-44`. Do not overcount them.

**Files:** `hub/lib/fault.ts` (new), `hub/lib/errors.ts` (new — the `AppError` base), `hub/lib/swallow.ts` (new), `hub/lib/retry.ts`, `hub/lib/circuit-breaker.ts`, `hub/lib/google-session.ts`, `hub/lib/gemini.ts`, `hub/lib/claude.ts`, `hub/lib/agy-chat.ts`, `hub/lib/dispatch-store.ts`, `hub/lib/loop-detector.ts`, `hub/lib/secret-crypto.ts`.

---

### Layer 5 — Streaming responses (mid-stream failure with a 200 already sent)

Once the shell is flushed the status line is committed and cannot change. OpenRouter states it plainly: "Once the first token has been written to the client, the HTTP 200 OK status and headers are already committed — they can't be changed." HTTP trailers are not an option: browsers cannot read them via Fetch (the `response.trailers` API was removed from the Fetch Standard, whatwg/fetch#772, and Chromium closed it wontfix), which is exactly why gRPC-Web moved trailers into the body.

**Mechanism: an explicit terminal frame contract.**

`app/api/chat/route.ts` currently sends `data: [DONE]` (line 383) and, on mid-stream failure, `data: {error: message}` (line 396). Change to always send, immediately before `[DONE]`:

```
data: {"type":"done","outcome":"success|incomplete|cancelled|error","code":…,"faultId":…,"finishReason":…,"usage":…}
```

Do **not** name the SSE event `error`: per the WHATWG dispatch algorithm an `event: error` frame lands on `EventSource`'s `onerror` alongside transport failures. Keep the discriminator inside the JSON on the default message event.

Client side (`app/hooks/useChatEngine.ts:460-475`): track `sawTerminal`. A stream that ends **without** the sentinel is `stream_incomplete` — per the SSE spec an unterminated final event is silently dropped, so absence of the sentinel is the only reliable failure signal. Add an idle-stall watchdog reset on every chunk (including provider keepalive `ping` frames), keyed to the existing ladder in `lib/timeout-config.ts` (`GOOGLE 10s < IDLE 30s < CONNECT 45s ≤ CLIENT_ABORT 110s < ROUTE_MAX 120s`) → `stream_stalled`, tracked separately from connect timeout and total duration. A rise in stalls with healthy TTFT means a proxy is killing long-lived connections — an infra bug, not a model bug.

The existing abort branch (`route.ts:388`) is already correct and stays: `signal.aborted` → `outcome: 'cancelled'`, **not** a fault. Otherwise the error rate measures how often users press stop. Verify empirically on Cloud Run that `request.signal` actually fires on client disconnect before trusting it; if it does not, you keep paying for tokens nobody reads.

All decision logic goes in a pure `lib/stream-outcome.ts` (`terminalFrame`, `parseTerminalFrame`, `classifyStreamEnd`) so it is unit-testable with no network and protects the coverage ratchet. **Fault reporting on this path must be idempotent, keyed by `faultId` (UPSERT, not INSERT)** — streaming error hooks are documented to fire twice per upstream error (vercel/ai#14726).

**Files:** `hub/app/api/chat/route.ts`, `hub/lib/stream-outcome.ts` (new), `hub/app/hooks/useChatEngine.ts`, `hub/lib/chat-error.ts`, `hub/lib/agy-chat.ts`.

---

### Layer 6 — Background / fire-and-forget and the dispatch queue

**The platform trap.** Cloud Run's default request-based billing throttles CPU after the response, and Google's own docs warn that suspended background activity **resumes during a later unrelated request**. So a fire-and-forget rejection surfaces attributed to the wrong request with the wrong (or no) correlation context. Google's own detection recipe: look for log entries appearing *after* the request log entry.

**Rule: no work crosses the response boundary.** Await it, or hand it to the dispatch queue. `voidReport()` makes a stray promise *visible*; it does not make it *correct*.

Replace the seven `void cancelJob(jobId).catch(() => {})` / `settleAbandoned(…)` calls in `lib/agy-dispatch.ts:150-210` with `swallow(err, { code: 'job_orphaned', severity: 'degraded' })`. Same for `app/api/deep-runs/route.ts:147,151,160`.

The queue keeps its durable spine (`dispatch_jobs`, `ai_runs`, `tool_runs`). Add fault mapping for `reapExpired`'s `lease_expired`/`deadline` → `worker_timeout`, `enqueueJob`'s `queue_full` refusal → `degraded`, `worker_unreachable` for a dispatch to an offline worker (not a tool error), and **a sweeper folded into the hourly tick** that finds rows stuck in `queued`/`running` past deadline → `job_orphaned`. Without that sweeper a worker-side failure shows up as literally nothing: the LLM run succeeded, the job row just never closed.

The three best-effort ledger writers (`recordAiRun`, `recordAiAction`, `recordEvent`) already self-report — `lib/runs.ts:165` emits `{ type: 'ai_error', code: 'ai_run_write_failed' }`. That contract is the template: **best-effort work must still report its own failure.**

**Inbound Google webhooks produce two silences of their own.** `app/api/webhooks/google/route.ts` + `/renew` and `lib/google/watch-channels.ts` fail in ways nothing observes: (1) a 5xx returned to Google makes Google back off and eventually **drop the channel**, so the fix for a transient error is a permanent outage; (2) a failed renewal — channels expire in ≤7 days — stops all push delivery with **zero errors anywhere**, which is the exact failure the `webhook_channels` table was created to prevent (see its header at `lib/schema.ts`). Add `webhook_delivery_failed` and `watch_channel_expired` codes, an **always-ack-200 contract** for the receiver (record the fault, never signal it upstream — hence its `PERMANENT_EXEMPTIONS` entry), and a reconciliation check for any channel past `expiration` with no successful renewal.

**Files:** `hub/lib/agy-dispatch.ts`, `hub/app/api/deep-runs/route.ts`, `hub/lib/dispatch-store.ts`, `hub/lib/tool-runs.ts`, `hub/lib/chat-store.ts`, `hub/lib/swallow.ts` (new), `hub/app/api/worker/jobs/[id]/result/route.ts`, `hub/app/api/worker/jobs/[id]/heartbeat/route.ts`, `hub/app/api/worker/claim/route.ts`, `hub/app/api/webhooks/google/route.ts`, `hub/lib/google/watch-channels.ts`.

---

### Layer 7 — Scheduled / cron work

**Reuse, do not rebuild.** The hourly `.github/workflows/dispatch-alert.yml` (`cron: '7 * * * *'`) already solves every hard part: a constant-time `CRON_SECRET` gate with 503-as-kill-switch, the `.run.app` URL rather than the Cloudflare-fronted domain (which 403s CI curls), durable `event_log`-backed dedup safe across 1–3 Cloud Run instances, and `jq`-driven `exit 1` so GitHub's failure email is the fallback push path for a dark Hub.

`app/api/cron/dispatch-alert/route.ts` calls a second tick, `runFaultAlertTick()`, and merges its result into the JSON response under a `faults` key; the workflow's `jq` gains one condition. **No new workflow, no new secret, no new Cloud Scheduler job, no second failure-email path.**

**Raise the tick's budget before adding to it.** `app/api/cron/dispatch-alert/route.ts:7` sets `maxDuration = 60` and the workflow curls with `--max-time 90`. Layer 7 adds fault alerts, a digest render, two prunes across four tables, the orphan sweeper and three reconciliation queries to that single request. Raise `maxDuration` to 300 (the Cloud Run `--timeout=300` ceiling already configured at `deploy.yml:155`) and the workflow's `--max-time` to match — **or** split housekeeping into a second tick. A tick that times out takes the alert path down with it, which is the one path that must never fail quietly.

The same tick absorbs the housekeeping the app currently has nowhere to put: `pruneOldEventLogs` (moved out of `app/api/kpis/sync/route.ts:210`), a new `pruneOldAiRuns(90d)` covering `ai_runs` / `ai_action_log` / `tool_runs`, the dispatch orphan sweeper, and the reconciliation sweep.

The cron route itself is wrapped in `withFault` — it currently has **no catch**, so a throw returns an opaque 500 and the alert fires with no diagnosis attached. A cron tick that fails to deliver is itself a `fatal` fault.

**Files:** `hub/app/api/cron/dispatch-alert/route.ts`, `hub/lib/fault-alerts.ts` (new), `hub/lib/dispatch-alerts.ts`, `hub/lib/agent-memory.ts`, `hub/app/api/kpis/sync/route.ts`, `.github/workflows/dispatch-alert.yml`, `hub/tests/fault-alerts.test.ts` (new).

---

### Layer 8 — Process-level: uncaughtException / unhandledRejection / SIGTERM

**NEW `hub/instrumentation.ts` + `experimental: { instrumentationHook: true }` in `next.config.js`.** On 14.2.x the flag is **mandatory** or the file is parsed and never imported — no warning, no error, every handler inside silently no-ops. `next.config.js` currently has no `experimental` key at all. This is the single most expensive silent-failure trap in the plan, so `scripts/assert-instrumentation.mjs` asserts **both** the file and the flag, and runs in CI. The file must live at the project root (`hub/`), never inside `app/`.

Do **not** export `onRequestError` — Next 15.0.0+ only. It would never fire and would read as done.

`register()` is gated on `process.env.NEXT_RUNTIME === 'nodejs'` (pino is Node-only; an unconditional top-level import breaks the Edge build) and installs:

- **`process.on('uncaughtExceptionMonitor', (err, origin) => …)`** — the correct primitive, and almost nobody uses it. It fires *before* `uncaughtException`, gives full observability, and does **not** change crash behavior. A plain `uncaughtException` handler would both keep a corrupted process serving traffic and make it exit with code **0**, so a crash reports as a clean shutdown. `origin === 'unhandledRejection'` labels the class. Write the line with `fs.writeSync(process.stderr.fd, …)` — synchronously — because a buffered async destination is the most likely thing to lose exactly the line explaining why you died. Do **not** add a pino transport here: worker-thread bundling under Next fails at *runtime* with `Cannot find module 'real-require'`, and the failing subsystem would be the one that logs the failure.
- **An `unhandledRejection` listener on the Next server ONLY — REFINED 2026-08-28.** The original guidance here ("install none; Node ≥15 defaults to `throw`, so a log-only listener would silently *downgrade* a crash to a swallow") is **correct for a plain Node process and wrong for the Next server**. The answer is surface-dependent, so the listener must be gated, not global. Verified empirically on node 22:

  | | monitor fires? | process | exit |
  |---|---|---|---|
  | **no** `unhandledRejection` listener | yes, `origin='unhandledRejection'` | dies | 1 |
  | **with** a listener | **no** | survives | 0 |

  Any listener suppresses Node's default throw. So:

  - **`scripts/dispatch-worker.ts` (plain Node): register nothing**, exactly as originally written. A listener there would swallow a programmer error and leave the worker claiming and executing dispatch jobs in the corrupted state Joyent's doctrine is about. It costs no observability: the rejection is promoted to an uncaught exception, so `uncaughtExceptionMonitor` reports it — correctly labelled — *and* the process still dies.
  - **The Next server: register one.** The framework got there first. `next@14.2.35`'s `dist/server/lib/start-server.js` registers, unconditionally and in production (not dev-gated; reached by `next start` via `dist/cli/next-start.js`):
    ```js
    process.on("uncaughtException", exception)
    process.on("unhandledRejection", exception)
    // const exception = (err) => { console.error(err) }  // "we keep the process alive"
    ```
    Node's default-throw is therefore already suppressed *by Next*: the rejection is never promoted, `uncaughtExceptionMonitor` never sees it, and the class would be visible only as Next's unstructured, **unscrubbed** `console.error`. Ours cannot downgrade a crash the framework already prevented — it is purely additive. **Residual, stated rather than hidden:** Next's raw line still prints first, so a rejection embedding a secret is logged unscrubbed by the framework; removing Next's listener would change crash semantics and is out of scope.

- **A `SIGTERM` handler** using Cloud Run's 10-second billed shutdown window to flush the fault buffer. On first-generation execution environments an untrapped SIGTERM means immediate shutdown, so this is not optional there. **It must not call `process.exit()`**: `docker-entrypoint.sh` execs `npm start` → `next start`, which installs its own SIGTERM handler, and ours merely appends to the listener list — exiting preempts Next's own drain. Budget ≤2 s and flush **synchronously to stderr only**. Do not attempt a Postgres flush inside the window: a slow socket eats the whole budget and the SIGKILL lands anyway.

Deliberately no `uncaughtException` recovery of our own. **Note what this does and does not buy on `next@14.2.35`:** Next's own `uncaughtException` handler (quoted above) already keeps a corrupted process serving traffic, so the crash-and-restart this paragraph assumes **does not actually happen** for exceptions that reach it — the container survives in exactly the state Joyent's doctrine warns about. We do not fight that from here (removing a framework listener is worse than the disease); we make it *visible*, which is the whole point of `uncaughtExceptionMonitor`. Joyent's doctrine (leaked connections, an open Postgres transaction bloating a table for weeks, a socket left authenticated and reused for another user's request) makes resuming after a programmer error strictly worse than dying. The design goal is that `uncaughtException` is *unreachable* in normal operation because `withFault` catches at the request boundary. Every crash still costs a queued-request stall bounded by 3.5× average startup time or 10 s, whichever is greater.

**Source maps.** Enable `experimental.serverSourceMaps: true` plus `NODE_OPTIONS='--enable-source-maps'` in the container start command. Highest-value/lowest-risk change available: server maps live in the server bundle and are never served to browsers, and without them production stack traces point uselessly into `.next/server/chunks/*.js`. Do **not** set `productionBrowserSourceMaps: true` — Next auto-serves those `.map` files to anyone who appends the extension.

**Files:** `hub/instrumentation.ts` (new), `hub/next.config.js`, `hub/Dockerfile`, `hub/docker-entrypoint.sh`, `hub/scripts/assert-instrumentation.mjs` (new).

---

### Layer 9 — Silent failures: success returned, wrong thing done

This class is invisible to every error-rate alert, so it gets eight named detectors.

1. **HTTP 200 carrying an error.** Fix the three known offenders, then make it structural via `withFault`'s 2xx-body inspection (`contract_violation`), **and** add `tests/no-200-errors.test.ts` as a build-time guard so the pattern cannot regrow in an unwrapped handler.
2. **Silent data omission.** Route the 18 `.catch(() => [])` / `.catch(() => null)` sites through `emptyOn()`, set `partial: true`, and return an `x-hub-partial: 1` response header so the client can say "some data could not be loaded" instead of "nothing here". This propagates the *truth of a degraded read all the way to the UI*, which is the only fix that reaches the user.
3. **AI degraded outcomes** — four detectors no error-rate alert can see: truncation rate (`finishReason === 'length'` / the existing `ai_truncated` event, which is stdout-only today and never persisted); **empty-but-billed** (`outputTokens > 0 && renderedLength === 0`, the reasoning-model failure); fallback rate by `from → to` (the early warning that a provider is degrading *before* it starts hard-failing); and TTFT p95 tracked separately from total-duration p95, since the two regress independently.
4. **Tool-call failures, split correctly.** `tool_args_invalid_schema` (valid JSON that fails your schema — model quality, worth a bounded repair retry) vs `tool_args_truncated` (the stream died mid `input_json_delta` — transport, and Anthropic documents that tool_use blocks cannot be partially recovered). Distinguish by whether the block-complete signal was seen. Plus `tool_unknown_name` for a hallucinated tool matched against the registry before dispatch.
5. **Dispatch orphans** — the layer-6 sweeper.
6. **Cheap post-condition invariants** on the ten Google write routes: a new `lib/invariants.ts` with `assertInvariant(cond, code, ctx)` asserting the response *shape* and that an expected id came back (Gmail send returned a message id; a calendar event round-trips with the expected start; a dispatch result reached a terminal state). Generalize the idiom already in `app/api/admin/work-probe/route.ts`. **Explicitly not** a read-back round-trip — that doubles API calls on write paths, adds latency, burns quota, and introduces a new failure class (the read-back itself failing) that then needs its own classification.
7. **Reconciliation sweep** in the hourly tick — the highest-value silent failures live here, and this is where an absence becomes a positive signal:
   - `telemetry:ai_request_start` rows with no terminal `ai_complete`/`ai_error` partner within 5 minutes. This directly surfaces the `chat/route.ts:868` blind spot retroactively.
   - `tool_runs` stuck non-terminal past deadline (the `deep-runs` comment proves this happens *and* that it holds the concurrency cap).
   - `dispatch_jobs` past lease.
8. **The zero-signal alarm.** The tick alerts when `sinkFailed > 0`, when a traffic window is unexpectedly empty of telemetry, or when the digest itself failed to render. `persistTelemetryEvent` swallows every failure, so a Postgres outage produces zero faults — which reads as perfect health. **Absence of errors is not evidence of health.**

**Files:** `hub/app/api/companies/route.ts`, `hub/app/api/projects/route.ts`, `hub/app/api/auth/register/route.ts`, `hub/app/api/kpis/sync/route.ts`, `hub/lib/route-fault.ts`, `hub/lib/swallow.ts`, `hub/lib/invariants.ts` (new), `hub/lib/fault-reconcile.ts` (new), `hub/app/api/google/calendar/route.ts`, `hub/lib/observability.ts`, `hub/app/api/healthz/route.ts`, `hub/lib/fault-alerts.ts`, `hub/lib/ai-health.ts`, `hub/tests/no-200-errors.test.ts` (new).

---

### Layer 10 — What the app process structurally cannot see

Three failure classes escape every mechanism above, because in each the reporting code is inside the thing that failed. Each needs an **independent observer**, and naming them is what keeps "we have error reporting" from becoming a false claim.

**1. The cron dead-man's switch — the silence detector must not live inside the thing that goes silent.** Every push path in this design (PAGE, digest, zero-signal, reconciliation, prune) hangs off `.github/workflows/dispatch-alert.yml`. GitHub **disables scheduled workflows after 60 days of repository inactivity**; a rotated `CRON_SECRET`, a renamed file, or an Actions outage has the same effect. In all of those cases nothing fires **and nothing notices** — the most dangerous state this system can reach, because total silence is indistinguishable from perfect health. Mitigation: the tick persists `last_tick_at` on every run (an `event_log` row, `eventType: 'fault.tick'`), and a **second, independent observer** asserts its freshness — either a Cloud Scheduler job hitting the same route, or a GCP log-based-metric alert on "no `cron_tick_ok` line in 3 hours". Staleness is `fatal`. Two independent schedulers is the entire point; one scheduler checking itself is not a check.

**2. Cloud Run platform failures the process never sees.** At `--memory=1Gi --timeout=300` (`deploy.yml:154-155`), an **OOM kill (SIGKILL / exit 137)**, a container start failure, a `startupProbe` failure on a bad revision, a "no available instance" 429, and the 300 s platform timeout all bypass `uncaughtExceptionMonitor` *and* the SIGTERM handler — there is no in-process moment at which to report. This is **the one tier that cannot be first-party**: it needs a single Cloud Monitoring alert policy on Cloud Run `request_count` 5xx plus container exit codes. One policy, configured once, in the console. Accept the dependency; there is no alternative.

**3. The standalone worker process is outside the Next.js runtime entirely.** `hub/scripts/dispatch-worker.ts` is a plain Node process, so `hub/instrumentation.ts` never loads for it: its crash, its unhandled rejections, and its startup failures produce nothing at all. Server-side lease expiry can only ever report that the worker "went quiet", never *why* — which is exactly the diagnosis you need. Extract the process handlers into `hub/lib/fault-process.ts` (imported by both `instrumentation.ts` and the worker entrypoint) and have the worker report through the same HTTP sink it already uses to claim jobs. **IMPLEMENTED 2026-08-28** (#222): the crash path appends to a bounded on-disk spool (`hub/lib/fault-spool.ts`) — synchronously, because an async upload from a dying process loses the race — and `uploadSpooledFaults()` POSTs the batch to the new `POST /api/worker/faults` on the next boot, before any slot claims work. The route uses the same constant-time `x-worker-secret` posture as `/api/worker/claim`, re-scrubs and re-validates every record (the secret authenticates the sender, not the payload), bounds `code` by shape because it is the one metric dimension, dedupes by `faultId`, and re-reports with the ORIGINAL crash timestamp under `serviceContext.service = 'hub-worker'` so worker crashes do not merge into the server's Error Reporting groups. Failure handling is asymmetric on purpose: the batch is DROPPED only on 400/413/422 — the statuses that conclusively mean the payload is invalid and always will be — and RESTORED for the next boot on everything else. A blanket 4xx drop is wrong: a 401 during an `AGY_WORKER_SECRET` rotation, or a 404 from a worker that updated before the Hub deployment landed, are both self-recovering and would otherwise destroy good crash records. Residual: the spool is in the container's writable layer, so `docker rm` discards anything not yet uploaded, and a worker that never restarts never uploads.

**Files:** `hub/lib/fault-process.ts` (new), `hub/scripts/dispatch-worker.ts`, `hub/lib/fault-alerts.ts`, `hub/app/api/cron/dispatch-alert/route.ts`, plus one Cloud Monitoring alert policy documented in `hub/docs/runbooks/fault-reporting.md`.

---

## 4. The canonical error record

### 4.1 Wire shape (Phase 1 — no migration)

A new member of the existing union in `hub/lib/observability.ts`:

```ts
export type TelemetryEvent =
  | { type: 'ai_request_start'; requestId: string; route: string }
  // … 13 existing members unchanged …
  | ({ type: 'fault' } & FaultRecord)
```

`'fault'` is added to `PERSISTED_EVENT_TYPES` (`lib/observability.ts:81-86`), so the existing lazy `persistTelemetryEvent()` copies it into `event_log` as `event_type = 'telemetry:fault'`, `correlation_id = requestId`, `payload = the rest`. **Zero schema change in Phase 1.** The existing `event_log_type_created_idx` already serves both the aggregation read and the prune.

### 4.2 `FaultRecord` — `hub/lib/fault.ts`

```ts
/**
 * The canonical fault record. ONE shape for every layer: client, edge, route,
 * action, lib, stream, job, cron, process. Every field below exists because
 * something in this repo could not be diagnosed without it.
 *
 * PII: this type is the ONLY member of TelemetryEvent carrying free text
 * (`message`, `stack`). Both are scrubbed by scrubFreeText() before assignment
 * — key-based denylists never look inside a string. See §7.
 */
export type FaultRecord = {
  // ── identity ────────────────────────────────────────────────────────────
  /** 'HUB-' + base32(5 random bytes), e.g. HUB-K7QF2M9A. RFC 9457 `instance`.
   *  Returned in the body AND as an `x-hub-fault-id` response header (Stripe's
   *  Request-Id pattern) so it survives a body-less failure. This is the string
   *  Danny quotes and the string a user pastes into a support message. */
  faultId: string

  /** 16-hex grouping key — see §5. Two occurrences of the same bug share it. */
  fingerprint: string

  /** Which rung of the fingerprint cascade fired. Without this, the first month
   *  of hand-tuning is blind: you cannot tell over-splitting caused by unstable
   *  frames from over-splitting caused by an unnormalized message token. */
  fingerprintStrategy: 'explicit' | 'frames' | 'message'

  // ── time ────────────────────────────────────────────────────────────────
  /** ISO-8601 UTC wall clock. Set by emit(), not by the pure mapper, so
   *  toFault() stays Date-free and unit-testable. */
  ts: string

  // ── correlation ─────────────────────────────────────────────────────────
  /** THE correlation spine. Minted once in middleware.ts, passed as
   *  x-hub-request-id, used as pino `correlationId`, telemetry `requestId`,
   *  `ai_runs.request_id`, and `event_log.correlation_id`. This single field
   *  makes the repo's two existing log seams joinable for the first time. */
  requestId: string | null

  /** W3C 32-hex trace id parsed from Cloud Run's injected `traceparent`.
   *  Emitted as logging.googleapis.com/trace so container logs nest under the
   *  request log in Logs Explorer. Prefer traceparent over X-Cloud-Trace-Context:
   *  the latter's span is DECIMAL while LogEntry.spanId must be 16-char hex. */
  traceId: string | null

  /** Chat thread id, when the fault happened inside a conversation. Stitches a
   *  multi-turn failure into one story instead of N unrelated records. */
  conversationId: string | null

  /** ai_runs / tool_runs id. Joins a fault to what it cost us in tokens — the
   *  question stock GenAI metrics structurally cannot answer, because
   *  gen_ai.client.token.usage carries no error dimension. */
  runId: string | null

  /** dispatch_jobs id. Without it a worker-side failure is unattributable. */
  jobId: string | null

  // ── where ───────────────────────────────────────────────────────────────
  /** Which mechanism caught it. Decides what the record can and cannot know
   *  (an edge fault has no DB, a client fault has no stack we can symbolicate). */
  layer: FaultLayer

  /** Route PATTERN only ('/api/orgs/[orgId]/founder-lens'), never a concrete
   *  path. Simultaneously a PII control (HIPAA Safe Harbor enumerates URLs as
   *  identifiers), a cardinality control, and a fingerprint-stability control:
   *  a raw path with ids shatters every group. */
  route: string | null

  /** GET/POST/… Distinguishes 'reads are failing' from 'writes are failing',
   *  which are different incidents with different urgency. */
  method: string | null

  /** The pino `module` binding, so a fault and its surrounding log lines
   *  filter together in Logs Explorer. */
  module: string | null

  // ── what ────────────────────────────────────────────────────────────────
  /** Closed, low-cardinality union (OTel `error.type` semantics). NEVER a free
   *  string. This is the ONLY field allowed as a metric/alert/dashboard
   *  dimension. Exhaustiveness is enforced by a `never` default in the status
   *  mapper, so an unmapped code is a COMPILE error, not a runtime 500. */
  code: FaultCode

  /** `err.constructor.name`, capped at 64 chars. High cardinality by nature —
   *  log-only, a fingerprint input, never a metric label. */
  errName: string | null

  /** OPERATOR-facing. Single-lined, scrubbed, ≤300 chars — copies the exact
   *  contract of flattenError() at lib/runs.ts:101-106. Never leaves the
   *  process; never appears in a response body. */
  message: string

  /** A fixed string per `code`, safe by construction. The ONLY text a client
   *  ever sees. This is VError's WError design: preserve the chain for logging,
   *  hide the lower-level message from the top-level error. */
  userMessage: string

  /** Top 8 frames. node_modules/.next frames dropped, absolute paths reduced to
   *  repo-relative, LINE NUMBERS STRIPPED, query strings removed. Persisted
   *  only — NEVER in a response body. Scrubbed by scrubFreeText(): stack traces
   *  routinely embed request URLs, SQL, and function arguments. */
  stack: string | null

  /** `err.cause` walked explicitly to depth 3 as [{name, message}]. REQUIRED
   *  because `cause` is a NON-ENUMERABLE property: JSON.stringify and naive
   *  pino serializers drop the entire chain silently. Losing it means losing
   *  the Postgres/Google original under a generic wrapper. */
  causeChain: Array<{ name: string; message: string }>

  // ── classification ──────────────────────────────────────────────────────
  /** FOUR-valued, never a boolean. `cancelled` is a user pressing stop and is
   *  NOT an error; `incomplete` is truncation or a partial result. Collapsing
   *  these is the fastest way to an error rate that measures user behavior. */
  outcome: 'error' | 'incomplete' | 'cancelled' | 'degraded'

  /** OTel severity semantics (21/17/13/5). Assigned from expected IMPACT, never
   *  from 'an exception happened'. See §6. */
  severity: FaultSeverity

  /** A 4xx you SERVED is the caller's problem; the identical 4xx RECEIVED as a
   *  client is yours. One field encodes the OTel HTTP asymmetry so a bot
   *  fuzzing the API never burns the error budget. */
  blame: 'client' | 'server' | 'upstream' | 'timeout' | 'cancelled'

  /** True when the code EXPECTED this failure (validation, 404, expired
   *  session). Separates 'the system modeled this' from 'the system was
   *  surprised', which is the operational/programmer-error split. */
  isExpected: boolean

  /** Decided ONCE at the boundary where the failure's meaning is known, so no
   *  caller re-derives it wrongly. breaker_open and content_policy are false
   *  by definition — retrying them reproduces the identical failure at full cost. */
  isRetryable: boolean

  /** Retries recorded on the TERMINAL record, never as N error rows. Per OTel:
   *  a failure a retry swallowed is not an error on the logical operation.
   *  Per-attempt rows inflate the error rate by the retry factor. */
  retryCount: number

  /** True when a fallback substituted an empty or degraded result. THE
   *  silent-failure marker: it is what turns 'you have no events' into
   *  'some data could not be loaded'. Surfaced as `x-hub-partial: 1`. */
  partial: boolean

  /** HTTP status actually returned. 200 IS LEGAL and is the mid-stream
   *  signature — the status was committed at the first byte. */
  httpStatus: number | null

  // ── context ─────────────────────────────────────────────────────────────
  /** hashEmail() 12-hex from lib/observability.ts:183. The ONLY sanctioned user
   *  dimension. Never a raw address; the output contains no '@'. */
  userHash: string | null

  /** getTenantId(). Every event_log row needs it (NOT NULL FK), and the
   *  retention prune is tenant-scoped — a fault written under an unexpected
   *  tenant would be immortal. */
  tenantId: string

  /** process.env.GIT_SHA — already injected at .github/workflows/deploy.yml:111.
   *  Deliberately NOT part of the fingerprint (or every deploy forges brand-new
   *  'issues' and regression detection dies), but stored so 'is this new since
   *  Tuesday's deploy' is answerable. */
  release: string

  /** process.env.K_REVISION — Cloud Run revision. One env read; makes 'which
   *  revision introduced this' answerable without deploy-log archaeology. */
  revision: string | null

  /** 'production' | 'development' | 'test'. Groups are PARTITIONED by env
   *  before comparison so local noise never merges into a production group. */
  env: string

  /** ALLOWLIST-built, ≤10 keys, scalars only, ≤200 chars each. Allowlist-first
   *  is the only posture that survives a library adding a field you did not
   *  anticipate; a denylist fails open on `passwd2` or `X-Api-Secret`. */
  context: Record<string, string | number | boolean> | null

  // ── pipeline self-observation ───────────────────────────────────────────
  /** Set when this record itself was shed. Without drop accounting a throttled
   *  or DB-blind app looks IDENTICAL to a healthy one — the single most
   *  dangerous failure mode in this whole design. */
  droppedReason: 'rate_limit' | 'ring_full' | 'payload_too_large' | null
}
```

### 4.3 `FaultCode` — the closed taxonomy

Lifted from OpenRouter's published, provider-neutral vocabulary rather than invented, plus app-specific classes for the failures providers do not name.

```ts
export type FaultLayer =
  | 'client' | 'edge' | 'route' | 'action' | 'lib'
  | 'stream' | 'job' | 'cron' | 'process' | 'invariant'

export type FaultSeverity = 'fatal' | 'error' | 'degraded' | 'expected'

export type FaultCode =
  // transport / upstream
  | 'upstream_5xx' | 'upstream_4xx' | 'upstream_unavailable' | 'upstream_breaker_open'
  | 'timeout_connect' | 'timeout_idle' | 'rate_limited'
  // AI
  | 'ai_provider_error' | 'ai_context_length' | 'ai_content_filter' | 'ai_truncated'
  | 'ai_empty_billed' | 'tool_args_invalid_schema' | 'tool_args_truncated' | 'tool_unknown_name'
  // data / platform
  | 'db_error' | 'db_table_missing' | 'db_constraint' | 'vector_store_error'
  // auth
  | 'auth_unauthenticated' | 'auth_forbidden' | 'auth_reauth_required'
  | 'google_scope_missing' | 'google_api_not_enabled'
  // request
  | 'validation_failed' | 'not_found' | 'conflict' | 'payload_too_large'
  // streaming
  | 'stream_mid_failure' | 'stream_incomplete' | 'stream_stalled'
  // queue / worker
  | 'queue_full' | 'worker_unreachable' | 'worker_timeout' | 'job_orphaned'
  // client
  | 'client_render' | 'client_hydration' | 'client_chunk_load'
  | 'client_unhandled_rejection' | 'client_resource_load'
  | 'client_csp_violation' | 'client_query_error' | 'client_deprecation'
  // meta
  | 'contract_violation' | 'invariant_violation' | 'sink_write_failed'
  | 'internal' | 'unmapped'
```

**Two rules, stated in the module header of `lib/fault.ts`:**

1. **A shipped code is a public contract.** Support macros, alert rules, runbooks and client branches key on it, so renaming one is a breaking change even when the HTTP status is unchanged. **Add, never repurpose.**
2. **Exhaustiveness is compiler-enforced.** `default: { const _never: never = code; return 500 }` in `statusForCode`, so a new code nobody mapped fails `tsc --noEmit` rather than silently 500-ing in production. This is the entire reason to prefer a closed union over a family of unrelated `Error` subclasses.

### 4.4 Response body

`faultResponse()` returns an RFC 9457-shaped `application/problem+json`:

```jsonc
{
  "type": "https://hub.casatrejo.com/errors/upstream_5xx", // stable URI per problem class
  "title": "Upstream service failed",                       // stable per class, safe to localize
  "status": 502,                                            // MUST equal the real HTTP status
  "detail": "The Gmail service did not respond.",           // == userMessage; per-occurrence, safe
  "instance": "HUB-K7QF2M9A",                               // == faultId
  "code": "upstream_5xx",
  "requestId": "…",
  "issues": [ { "path": ["body","email"], "message": "Invalid email" } ] // validation only, PATHS not values
}
```
plus `details` **only** when `NODE_ENV !== 'production'`. Every response also carries `x-hub-fault-id` and `x-hub-request-id` headers so the identifier survives a body-less failure. This generalizes `lib/chat-error.ts:7-15` — today the only `NODE_ENV`-gated error body in the repo — and retires the ~42 raw-message leak sites in one move.

### 4.5 Deferred DDL (Phase 6 only)

Ship this **only** if the digest proves `event_log` volume or query latency is a real problem. The whole point of the union-member approach is that this may never be needed. If it does land, it is `hub/drizzle/0012_faults.sql` (the next free number — `0011_chats.sql` is current) plus the following in `hub/lib/schema.ts`, matching house conventions (aligned columns, inline `//` comments, index in the `(t) => ({ … })` form):

```ts
/* ── Faults (error groups + a bounded evidence ring) ─────────────────────── */
/**
 * One row per FINGERPRINT in `fault_groups` — this IS the queue. `fault_events`
 * is a BOUNDED ring of redacted evidence (max 20 per group), so a slow-burning
 * fault that passes the token bucket forever cannot accumulate unbounded rows.
 *
 * Same redaction contract as ai_runs / ai_action_log: PROVENANCE, NEVER
 * CONTENT. Every read and write MUST be guarded by isMissingTableError
 * (lib/dispatch-store.ts:51) — docker-entrypoint.sh is deliberately non-fatal
 * on migration failure, so this table can be absent at runtime.
 */
export const faultGroups = pgTable(
  'fault_groups',
  {
    id:             uuid('id').primaryKey().defaultRandom(),
    tenantId:       text('tenant_id').notNull().references(() => tenants.id),
    fingerprint:    text('fingerprint').notNull(),      // 16-hex; unique per tenant
    layer:          text('layer').notNull(),            // FaultLayer
    code:           text('code').notNull(),             // FaultCode — the ONLY metric dimension
    errName:        text('err_name'),                   // constructor name; high cardinality, log-only
    title:          text('title').notNull(),            // normalized message, stable across occurrences
    route:          text('route'),                      // ROUTE PATTERN, never a concrete path
    method:         text('method'),
    httpStatus:     integer('http_status'),
    severity:       text('severity').notNull(),         // DERIVED by classifyFault(), never hand-set
    state:          text('state').notNull().default('new'), // new|ongoing|resolved|regressed|muted
    firstSeenAt:    timestamp('first_seen_at', { withTimezone: true }).notNull(),
    lastSeenAt:     timestamp('last_seen_at', { withTimezone: true }).notNull(),
    firstSeenSha:   text('first_seen_sha'),             // GIT_SHA — already in prod env (deploy.yml:111)
    lastSeenSha:    text('last_seen_sha'),
    resolvedInSha:  text('resolved_in_sha'),            // resolve-in-release: a later event on a NEWER
                                                        // sha ⇒ regressed. A bare 'resolved' manufactures
                                                        // false reopens from stragglers on the old build.
    occurrences:    integer('occurrences').notNull().default(0),
    affectedUsers:  integer('affected_users').notNull().default(0), // distinct hashEmail() count
    hourlyMax:      integer('hourly_max').notNull().default(0),     // feeds the escalation formula
    mutedUntil:     timestamp('muted_until', { withTimezone: true }),
    notes:          text('notes'),                      // operator note; never model-generated
    createdAt:      timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt:      timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantFingerprintIdx: uniqueIndex('fault_groups_tenant_fp_idx').on(t.tenantId, t.fingerprint),
    // Serves the ranked queue read ONLY — not the prune (no created_at leading
    // column). Verify the .desc() form against drizzle-orm@0.45.2 before
    // shipping; ordering inside .on() may require the sql`` helper.
    queueIdx:             index('fault_groups_queue_idx').on(t.tenantId, t.state, t.severity, t.lastSeenAt.desc()),
  }),
)

export const faultEvents = pgTable(
  'fault_events',
  {
    id:              uuid('id').primaryKey().defaultRandom(),
    groupId:         uuid('group_id').notNull().references(() => faultGroups.id, { onDelete: 'cascade' }),
    occurredAt:      timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
    faultId:         text('fault_id').notNull(),        // HUB-XXXXXXXX; UPSERT key (stream hooks fire twice)
    requestId:       text('request_id'),                // joins telemetry, pino, AND ai_runs.request_id
    traceId:         text('trace_id'),
    gitSha:          text('git_sha'),
    revision:        text('revision'),                  // K_REVISION
    layer:           text('layer').notNull(),           // denormalized so the queue read needs no join
    code:            text('code').notNull(),
    route:           text('route'),
    method:          text('method'),
    httpStatus:      integer('http_status'),
    outcome:         text('outcome').notNull(),         // error|incomplete|cancelled|degraded
    retryCount:      integer('retry_count').notNull().default(0),
    partial:         boolean('partial').notNull().default(false),
    messageRedacted: text('message_redacted'),          // flattenError(msg, 300) + scrubFreeText
    stackRedacted:   text('stack_redacted'),            // ≤8 in-app frames, no line numbers, scrubbed
    causeChain:      jsonb('cause_chain'),              // [{name,message}] depth ≤3 — walked EXPLICITLY
    context:         jsonb('context'),                  // ALLOWLIST-ONLY, scalars only
    userHash:        text('user_hash'),                 // hashEmail() 12-hex. Never a raw address.
    clientMeta:      jsonb('client_meta'),              // {uaFamily, viewportBucket, digest} — no appSha (see §12.4)
  },
  (t) => ({
    ringIdx:    index('fault_events_ring_idx').on(t.groupId, t.occurredAt.desc()),
    faultIdIdx: uniqueIndex('fault_events_fault_id_idx').on(t.faultId),
  }),
)
```

---

## 5. The fingerprinting / grouping algorithm

Pure, I/O-free, `Date`-free, unit-tested in isolation — the same shape as `toRunRow` (`lib/runs.ts:113`) and `toAuditRow` (`lib/ai-audit.ts:81`), which is why it raises the coverage ratchet rather than dragging it down.

```ts
// hub/lib/fault-fingerprint.ts
import crypto from 'crypto'

export type FingerprintStrategy = 'explicit' | 'frames' | 'message'

/**
 * Frames are `${fn}@${repoRelativeFile}` — NO LINE NUMBERS. Rollbar's
 * documented reason: line numbers churn on unrelated edits above the fault, so
 * a pre-existing bug that shifts from line 47 to 52 becomes a brand-new group
 * and the old one looks fixed. Both halves of that are wrong.
 */
const FRAME_RE = /^\s*at\s+(?:(.+?)\s+\()?(.+?):\d+:\d+\)?\s*$/
// The `.next` exemption is load-bearing. In the container (Dockerfile WORKDIR
// /app) EVERY server frame is /app/.next/server/..., so a blanket `.next` filter
// makes inAppFrames() return [] and drops every server fault to the WEAKEST
// rung. Exempt compiled app code explicitly.
const VENDOR_RE = /node_modules|[\\/]\.next[\\/](?!server[\\/]app[\\/])|[\\/]next[\\/]dist[\\/]|^node:|^internal[\\/]/
// Also strips the webpack prefixes `--enable-source-maps` actually produces
// under `next start`, which otherwise survive into the frame and churn per build.
const DEPLOY_ROOT_RE = /^(?:file:\/\/)?(?:webpack:\/\/_N_E\/\.\/|webpack-internal:\/\/\/\(rsc\)\/\.\/)?(?:\/app|\/workspace|[A-Za-z]:)?[\\/]+(?:home[\\/][^\\/]+[\\/])?(?:hub-overlay[\\/])?(?:hub[\\/])?/

/**
 * Tokens that ARE the grouping signal and must survive normalization:
 * HTTP status codes, Postgres SQLSTATEs, and known errno strings. A blanket
 * digit rule would shred exactly the discriminators you need.
 */
const PRESERVE_NUMERIC = /^(?:[1-5]\d{2}|23505|23503|23502|40001|57014|53300)$/

/**
 * ORDERED, most-specific-first. Order is load-bearing: a greedy `\d{3,}` rule
 * run first shreds the digits inside a UUID / IP / ISO timestamp and yields a
 * skeleton that never matches another occurrence of the same error again.
 */
const NORMALIZERS: Array<[RegExp, string]> = [
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>'],
  [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>'],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>'],
  [/\bhttps?:\/\/[^\s"'<>)]+/gi, '<url>'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>'],
  [/\b[0-9a-f]{8,}\b/gi, '<hex>'],
  [/'[^']{1,120}'|"[^"]{1,120}"/g, '<str>'],
]

/** Normalize an operator message into a stable grouping skeleton. */
export function normalizeMessage(raw: string): string {
  let out = raw.replace(/\s+/g, ' ').trim()
  for (const [re, token] of NORMALIZERS) out = out.replace(re, token)
  // Bare digits LAST, and only when they are not a meaningful code.
  out = out.replace(/\b\d{3,}\b/g, (m) => (PRESERVE_NUMERIC.test(m) ? m : '<n>'))
  return out.slice(0, 240)
}

/** Reduce a raw V8 stack to at most `max` normalized IN-APP frames. */
export function inAppFrames(stack: string | null | undefined, max = 3): string[] {
  if (!stack) return []
  const frames: string[] = []
  for (const line of stack.split('\n')) {
    const m = FRAME_RE.exec(line)
    if (!m) continue
    const fn = (m[1] ?? '<anon>').replace(/\s+/g, '')
    const file = m[2]
    if (VENDOR_RE.test(file)) continue
    // Strip the deploy root and any cache-busting query string. Both differ
    // per container and per build; neither identifies the bug.
    const rel = file.replace(DEPLOY_ROOT_RE, '').split('?')[0]
    frames.push(`${fn}@${rel}`)
    if (frames.length >= max) break
  }
  return frames
}

export type FingerprintInput = {
  code: string
  layer: string
  route?: string | null
  errName?: string | null
  message: string
  stack?: string | null
  /** Escape hatch for over-grouping: a call site that knows better wins. */
  explicit?: string | null
}

export type FingerprintResult = {
  fingerprint: string
  strategy: FingerprintStrategy
}

/**
 * Cascade mirroring Sentry's documented precedence: explicit > in-app frames >
 * normalized message. `route` is ALWAYS in the key so one generic
 * `timeout_idle` does not swallow every downstream dependency. `release` is
 * deliberately NOT in the key — otherwise every deploy forges brand-new issues
 * and regression detection dies.
 */
export function fingerprintFault(input: FingerprintInput): FingerprintResult {
  const base = [input.layer, input.code, input.route ?? '-', input.errName ?? '-']

  if (input.explicit) {
    return { fingerprint: hash([...base, `explicit:${input.explicit}`]), strategy: 'explicit' }
  }

  const frames = inAppFrames(input.stack, 3)
  if (frames.length > 0) {
    return { fingerprint: hash([...base, ...frames]), strategy: 'frames' }
  }

  return { fingerprint: hash([...base, normalizeMessage(input.message)]), strategy: 'message' }
}

function hash(parts: string[]): string {
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16)
}
```

**Two escape hatches ship in Phase 1, because you will need both within a month.** (1) The call-site `explicit` override above, for over-grouping. (2) A server-side rule table, `hub/lib/fault-fingerprint-rules.ts`, mapping `code + route glob → fingerprint`, for over-splitting — editable *while the noisy fault is firing*. This must actually ship in Phase 1: if it slips, "one hour a month of tuning" silently becomes "nobody tunes it", and by month eighteen the fingerprint space has fragmented far enough that new-fault alerting means nothing.

**Server source maps are a Phase 1 precondition, not a Phase 5 nicety.** Without `experimental.serverSourceMaps: true` + `NODE_OPTIONS='--enable-source-maps'`, compiled server frames carry no useful file identity and the `frames` rung degrades toward `message` grouping on day one — materially worse than the cascade implies. Ship the two flags in Phase 1 alongside the `VENDOR_RE` exemption above, and assert the improvement with the canary route in §13.4.

**Precondition, not an optional extra.** Client-layer fingerprints are worthless without symbolication — minified frames hash differently every deploy, so one chunk-load bug fragments across every release, manufacturing "new" fingerprints on every deploy (false pages) while the previous release's real bug looks resolved (false quiet). Until server-side symbolication of client stacks exists, **client-layer faults group on `code + route + errName + normalizedMessage` only, start at `digest` severity, and never page.**

---

## 6. Severity and actionability taxonomy

Severity is assigned from **expected impact** (OTel's own mapping), never from "an exception happened". Both `severity` and `blame` are inputs; `actionability` is **derived at read time** in `lib/fault-alerts.ts`, never stored — a fault written before a threshold change and one written after must not disagree about their own urgency.

| severity | OTel | Meaning | Examples in this repo | Default routing |
|---|---|---|---|---|
| `fatal` | 21 | Process-ending or app-wide unavailable | `uncaughtExceptionMonitor`, `db_table_missing`, `/api/healthz` failing, cron tick undeliverable | **PAGE** immediately |
| `error` | 17 | Unhandled on a server path; the user's action failed | route 500, `stream_mid_failure`, `worker_timeout`, `client_render` | **DIGEST**; escalates to PAGE when NEW/REGRESSED **and** the escalation formula trips |
| `degraded` | 13 | Handled, retried, or partial — the operation still returned | retry-exhausted-then-succeeded, `partial:true`, `queue_full`, `upstream_breaker_open`, `ai_truncated` | **DIGEST** only |
| `expected` | 5 | A modeled outcome, not a defect | `validation_failed`, `not_found`, `auth_unauthenticated`, `outcome:'cancelled'`, `redirect()`/`notFound()` | **RECORD** only — never digested, never paged |

| blame | Assigned when | Burns the budget? |
|---|---|---|
| `client` | A 4xx you **served** | No |
| `server` | A 5xx you served, or an unhandled throw | Yes |
| `upstream` | A 4xx/5xx you **received** as a client | Yes |
| `timeout` | A deadline tripped (`timeout_connect`, `timeout_idle`, `stream_stalled`) | Yes |
| `cancelled` | Caller-initiated abort | No — not an error at all |

| actionability | Derived when | Destination |
|---|---|---|
| `page` | `severity === 'fatal'` **OR** (`severity === 'error'` **AND** `blame ∈ {server, upstream, timeout}` **AND** the fingerprint is NEW-in-24h / REGRESSED-in-a-newer-release / ESCALATING) | Google Chat **on the next hourly tick — worst-case detection latency ~70 minutes** (GitHub cron slop included). There is no sub-hour path, by design |
| `ticket` | New but slow-burning, or a regression without a rate spike, or `severity === 'error'` below the escalation threshold | Named in the daily digest under "needs a look" |
| `digest` | Everything ongoing. **This is the default and where most records live** | Daily Chat digest + `/admin/ai-health` |
| `record` | `expected`, `cancelled`, `notFound`, `redirect`, expired-session 401s (suppressed via the existing `shouldTriggerReauth` predicate at `useHubData.ts:62`) | `event_log` only — **plus a rate-of-change detector**, see below |

**The escalation formula** (extend the existing threshold block at `lib/ai-health.ts:19-27`):

```ts
export const FAULT_NEW_PAGE_MIN = 3          // never page on a single occurrence
export const FAULT_YOUNG_MULTIPLIER = 10     // groups < 7 days old: max_hourly × 10
export const FAULT_STDDEV_K = 5              // groups ≥ 7 days old
export const FAULT_ABSOLUTE_FLOOR = 2

// groups ≥ 7 days old:
//   escalating ⟺ hourly > max(FAULT_ABSOLUTE_FLOOR, mean_hourly + FAULT_STDDEV_K * stddev)
// groups < 7 days old (no history):
//   escalating ⟺ hourly > max_hourly * FAULT_YOUNG_MULTIPLIER
```

The stddev form (simplified from Sentry's published bursty-limit) is specifically what stops **cron/queue burstiness from false-positiving** — this repo runs hourly jobs at `:07` and `:17`, and a flat multiplier would page on its own cron spikes.

**Two rules that decide whether any of these numbers mean anything:**

- **Record once, at the layer that gave up.** A failure a retry swallowed is `degraded` with `retryCount:n`, not n × `error`.
- **A 4xx you served is the caller's problem; the same 4xx you received is yours.** Encoded in `code` (`auth_forbidden` vs `upstream_4xx`) and in `blame`.

**A spike in `expected` outcomes must not be unalertable by construction.** `auth_unauthenticated` is `expected` → `record`-only, and reauth churn is further suppressed by `shouldTriggerReauth`. So a rotated `NEXTAUTH_SECRET`, a mass `invalid_grant`, or a middleware `getToken` failure logs out **every user** and pages **nobody** — an outage that is invisible precisely because each individual event is correctly classified as normal. The `record` tier therefore carries one detector: **hourly volume above N× the trailing 7-day hourly baseline for that fingerprint promotes it to `error`**, regardless of its own severity. Volume is the signal; the individual event never is.

**Override valve.** A derived classifier that mis-mutes a real defect has no self-correcting path. So: any fingerprint whose group has been in `state: 'new'` or `'regressed'` for **more than 7 days with ≥ 3 unacknowledged escalation attempts** promotes to `page` regardless of computed severity, and appears at the top of the digest.

---

## 7. PII and redaction rules

**Allowlist-first, deny-by-default.** It is the only posture that survives a library adding a field nobody anticipated. The redactor is the **third instance of a pattern this repo already proved twice** — `toRunRow` (`lib/runs.ts:89-154`) and `toAuditRow` (`lib/ai-audit.ts:81-126`), both pure functions unit-tested in isolation. Copy that shape exactly.

1. **`context` is built by allowlist**, not scrubbed by denylist. `ALLOWED_CONTEXT_KEYS = { route, method, status, provider, model, jobId, runId, kind, attempt, bytesSent, finishReason, retryCount }`. Anything else is **dropped, not redacted**. Scalars only; ≤10 keys; ≤200 chars each.
2. **Denylist as defense in depth**, reusing what already exists verbatim: `SENSITIVE_META_KEYS` (`lib/runs.ts:89` — `prompt, text, response, output, message, body, content, raw, envelope, token, accesstoken, password`) and `SENSITIVE_TARGET_KEYS` (`lib/ai-audit.ts:81`), plus Sentry's proven list (`password, secret, passwd, api_key, apikey, auth, credentials, mysql_pwd, privatekey, private_key, token, bearer`) and value regexes for card numbers, `eyJ…` JWTs, `sk-…`, `AIza…`, and `Bearer …`.
3. **`message` and `stack` get their own free-text pass — `scrubFreeText()`.** Key-based denylists never look inside a string, which is exactly why Sentry needs separate `$error.value` and `$message` selectors. Stack traces routinely embed request URLs, SQL, and function arguments. `scrubFreeText` runs the same ordered regex set as `normalizeMessage`, applied for *redaction* rather than grouping: emails → `<email>`, URLs stripped of query strings, bearer/JWT/`sk-`/`AIza` token shapes → `<token>`, IPs → `<ip>`.
4. **Never stored, ever:** a raw email (`hashEmail()` 12-hex only, no `@`), a raw URL path with ids (route pattern only), request or response bodies, message content, model output text, tool-call arguments (store a 16-hex sha256 fingerprint instead, matching `promptSha256` at `lib/schema.ts:437`), any token or secret. Zod `issues[].path` only, never `issues[].input`. (`reportInput` is a Zod **4** option and does not exist on the `zod` root at 3.25.76; the v3 concern is `issues[].received` / `.input`, which `toFault` strips.)
5. **RxFit is a health/fitness context.** Treat HIPAA Safe Harbor (45 CFR §164.514(b)(2)) as the spec: URLs, IP addresses, device identifiers and date elements finer than year are *enumerated identifiers*, not incidental metadata. That is what makes route patterns and hashed users mandatory rather than nice-to-have, and it makes `message`/`stack` the highest-risk fields in the entire schema.
6. **Untrusted keys are an injection vector.** Never spread request data at the top level of a log call or a child binding: Cloud Logging *promotes* a `severity` or `message` key from `jsonPayload` onto the `LogEntry`, so a caller could forge the severity of our own logs. Nest untrusted data under an app-controlled key.
7. **CSP report content is attacker-controlled.** Treat every field of a violation report — especially `script-sample` — as hostile input. Escape before storage and before any admin render. This is a stored-XSS vector fed by anyone who can trigger a violation on the site.

### 7.1 The one honest downgrade, stated out loud

`lib/observability.ts:40-42` currently states verbatim: *"NOTE: no event ever carries message content, an email, or a token."* That is a **safe-by-schema** guarantee. Adding `FaultRecord` with free-text `message` and `stack` converts it to **safe-by-scrubbing** for the entire union. This design accepts that downgrade and compensates in three ways:

1. `scrubFreeText()` runs **inside `toFault()`**, the pure mapper, so no code path can construct a `FaultRecord` with unscrubbed text.
2. The module note is **amended, not left stale**, so no future agent trusts a guarantee that no longer holds.
3. The guard test is strengthened rather than merely extended. `lib/observability.test.ts:70-99` currently iterates hand-written `SAMPLE_EVENTS` fixtures — a fixture-based test passes while production leaks. The new test adds a **property-based case over real thrown errors**: a `google-session` error whose message contains `Delegation denied for danny@rxfitatx.com`, a Postgres error embedding a connection string, and a stack containing `Authorization: Bearer eyJ…` must all come out with no `@`, no `eyJ`, and no `Bearer`.

---

## 8. Volume control: what stops the error pipeline from becoming the outage

| Control | Mechanism | Why this and not the obvious alternative |
|---|---|---|
| **Per-fingerprint token bucket** | In-process, both server (`lib/fault-report.ts`) and browser (`app/lib/fault-client.ts`). First **5 occurrences per fingerprint per 10-minute window** emit a full record; beyond that only a rollup counter increments. **Never drop an unseen fingerprint.** | Uniform sampling is the wrong tool: it drops rare-and-important errors at the *same* rate as the noisy loop. Sentry's own `sampleRate` is applied *before* `beforeSend`, so nothing can be exempted — a documented dead end. |
| **Bounded evidence ring** | At most **20 stored occurrences per fingerprint**; the 21st increments a counter and overwrites the oldest. | The bucket limits write **rate**; the ring limits total stored **volume** per group. A slow-burning fault at 4 occurrences per 10-minute window passes the bucket forever and accumulates unbounded rows. |
| **Global hourly ceiling** | **500 fault-event writes per hour per instance.** Overflow increments `droppedReason: 'ring_full'`. **Precedence is explicit: the global ceiling wins over "never drop an unseen fingerprint."** On overflow, one record per *new* fingerprint is still written until the ceiling is reached; past it, further new fingerprints only increment the counter **and raise the zero-signal alarm** — a ceiling hit during a deploy is itself the incident. | Per-fingerprint buckets alone do not bound total volume when a bad deploy produces many *distinct* new fingerprints at once — which is exactly the shape of a bad release. |
| **Client sink guard** | `checkActionLimit` (`lib/rate-limit.ts:100`) under a new `client_fault` key, plus a module-scope bucket in the browser before the fetch fires. 16 KB payload cap, truncating stack → causeChain → context in that order. | The 64 KiB keepalive budget is *shared* across all in-flight keepalive requests, so an oversized report silently drops itself and anything else queued. |
| **Drop accounting** | Module-scope `{ suppressed, ringFull, sinkFailed }` counters, exported and surfaced in `/api/healthz` **and every digest**. | Without it, a throttled or DB-blind app looks **identical to a healthy one**. This is the single most dangerous failure mode in the design, and the counters are non-negotiable. |
| **`sinkFailed` must actually be wireable** | **`recordEvent` cannot report its own failure today.** It catches its own insert failure and `log.error`s it (`lib/event-logger.ts:41-44`), returning a **resolved** promise — so `persistTelemetryEvent`'s `.catch()` never fires and the reporter can never count a dropped write. Add `recordEventStrict()` (or have `recordEvent` return `{ ok: boolean }`) and increment `sinkFailed` on rejection. | Without this one change the design's central trust claim — bet 3, the drop counters, the `sinkFailed > 0` page, the zero-signal alarm — has **no wiring at all**. It is the first thing to build, not the last. |
| **Reporter reentrancy** | A module-scope latch: while `reportFault` is executing, a fault raised *by the reporter* increments `selfFaults` and returns immediately. **The reporter never reports itself.** Also cap `recordEvent`'s failure log, which today logs `{err, opts}` — the whole payload — on *every* request during a DB outage. | §8's last row proves a single report cannot break a request; it says nothing about a fault raised while reporting one. Without a latch, a DB outage turns every request into two reports and the failure log into the outage amplifier. |
| **Idempotency** | Fault writes UPSERT on `faultId`, never INSERT. | Streaming error hooks are documented to fire twice per upstream error (vercel/ai#14726). A duplicate call must update, not double-count the error rate. |
| **Retention** | Move `pruneOldEventLogs` out of `app/api/kpis/sync/route.ts:210` into the hourly tick (already the recorded open item at `HARDENING_REVIEW_2026-08-20.md:119`) and add `pruneOldAiRuns(90d)` covering `ai_runs`, `ai_action_log`, `tool_runs` — all three have **zero** retention today. Fault rows in `event_log`: 30 days. **Make the prune all-tenants when it moves** (or assert tenant coverage): it is tenant-scoped today, so a fault written under an unexpected `tenant_id` would be immortal. |
| **Indexes the reads actually need** | `event_log_type_created_idx` is on `(event_type, created_at)`. It serves the `event_type LIKE 'telemetry:%' AND created_at >= …` aggregation read. It does **not** serve `pruneOldEventLogs`' `WHERE tenant_id = ? AND created_at < ?` (wrong leading column), and **nothing** indexes `payload->>'fingerprint'`, which every hourly fault aggregation in §9 needs over 30 days of rows. Phase 4 adds `CREATE INDEX CONCURRENTLY IF NOT EXISTS … ON event_log (created_at)` plus a partial expression index on the fingerprint for `event_type = 'telemetry:fault'`. | Shortening Cloud Logging retention below 30 days saves **literally nothing** — 30 days is included in the $0.50/GiB ingest price. The Postgres prune is what actually matters. |
| **Cloud Logging ceiling** | ~600 B per fault line. 5,000/day ≈ 90 MB/month vs a **50 GiB/project/month free tier**. The real ceiling is the **4.8 GB/min regional ingestion quota** in `us-central1` — exceeding it rejects writes with `resource exhausted`, which means a hot error loop can get your own *legitimate* logs rejected. | This is precisely what the token bucket and the global hourly ceiling exist to prevent. It is a billing event *and* an availability event. |
| **Entry size** | `LogEntry` hard-caps at ~256 KiB. Stack truncated to 8 frames, `causeChain` capped at depth 3, `context` at 10 scalar keys. | A deep cause chain or a giant serialized argument silently exceeds the cap and the whole entry is rejected. |
| **The reporter can never break a request** | Every fault write is best-effort by construction: `reportFault` never throws, never awaits on the request path, and is wrapped in its own try/catch. `withFault`'s catch is itself wrapped: if `toFault` or `reportFault` throws, the wrapper still returns a valid 500 problem+json. Enforced by test (§13). | This is the property that lets the wrapper ship to 112 routes at once without being an availability risk. |

**Known residual: two kill switches the rest of this document treats as always-on.** `emit()` returns early when `OBSERVABILITY_ENABLED=false` (`lib/observability.ts:70-72`), and the DB sink is off unless `TELEMETRY_DB_SINK` allows it (`:87-92`). A fault pipeline inheriting both silently disappears if either is ever flipped. **`reportFault`'s stdout line must be unconditional** — never gated by the AI-telemetry flag — and the tick alerts if `OBSERVABILITY_ENABLED=false` in production.

**Known residual: no cross-instance state.** Cloud Run runs 1–3 instances, so the token bucket, the circuit-breaker map (`lib/circuit-breaker.ts:30`) and the rate limiter (`lib/rate-limit.ts:33`) are all per-process. Suppression is therefore up to 3× looser than configured and derived rates are systematically under-counted. Accepted: **durable dedup where it matters** (alert posting, via `event_log`, exactly as `lib/dispatch-alerts.ts` already does) and in-memory where a 3× error is harmless. Say so in the module header rather than pretending the number is exact.

---

## 9. The surfacing path: what an operator or agent sees, where, and when

Five tiers. Three of them already exist.

### Tier 1 — Cloud Logging (synchronous, always)

`emit()`'s `console.log` line. Survives a Postgres outage, which is precisely when the DB sink cannot help. **This is the source of truth.**

Shape the line so **GCP Error Reporting picks it up for free** — this is Phase 1 "Step 0", roughly 30 lines in the pino/emit serializer, and it is the cheapest possible hedge against Sentinel's weakest point (hand-rolled grouping), because it buys a second, independently-tuned grouping engine plus new-group and reopened-group notifications at **$0**:

```jsonc
{
  "severity": "ERROR",                                  // promoted onto LogEntry; NOT `level`
  "message": "<scrubFreeText(err.stack)>",              // for JS, Error Reporting requires a V8-shaped stack here
  "serviceContext": { "service": "hub", "version": "<GIT_SHA>" },
  "logging.googleapis.com/trace": "projects/rxfit-automation/traces/<traceId>",
  "logging.googleapis.com/spanId": "<16-hex>",
  "logging.googleapis.com/trace_sampled": true,
  "context": { "httpRequest": { "method": "POST", "url": "/api/…", "responseStatusCode": 500 } },
  "fault": { /* the FaultRecord */ }
}
```

**On the stack in `message`.** Error Reporting's grouper needs a V8-shaped stack, so this is the one place frame line numbers survive — but the string is `scrubFreeText()`'d exactly like every other free-text field, so §7's guarantee ("no code path can construct a `FaultRecord` with unscrubbed text") is not violated. Error Reporting is a separate product with its own 30-day retention and its own UI; an unscrubbed stack there is precisely the leak §7 item 3 forbids. The fingerprinting copy (§5) is the line-number-*stripped* derivation — two different derivations of the same stack, for two different purposes.

**Emit exactly one of `message`, `exception`, or `stack_trace`.** Google's documented evaluation order is `stack_trace`, then `exception`, then `message` — the earlier key wins. We use `message`. The failure mode to avoid is emitting an *empty* or non-V8-format `stack_trace`, which would take precedence and yield nothing.

Already enabled on Cloud Run; the default SA already holds `roles/errorreporting.writer`. Limits to know and accept: **30-day retention (hard)**, sampling at 1,000 errors/hour falling back to 100/hour with extrapolated counts under load (so incident-time counts there are estimates), and no browser support at all. Treat it as a free backstop, never as the plan.

### Tier 2 — `event_log` (best-effort)

The queryable aggregation source, via the existing lazy sink. Failure is **counted** (`sinkFailed`), never thrown.

### Tier 3 — `/admin/ai-health` (pull only)

A Faults panel on the page that already exists, fed by a pure `computeFaultHealth()` sibling of `computeAiHealth()`. **Explicitly not the alerting mechanism** — it is for forensics after a push. Danny should never learn about an incident by opening it.

### Tier 4 — the agent queue (read-only)

`GET /api/agent/faults` — a **ranked, machine-readable** JSON queue, capped at 10, ordered by actionability → `occurrences × log(affectedUsers + 1)` → recency. Each item carries: fingerprint, state, code, layer, title, route, method, status, occurrences, affectedUsers, first/last seen, first/last SHA, `suspectFiles[]` (in-app frames, repo-relative), the redacted stack, the cause chain, recent occurrences, and `ai_runs` rows joined on `request_id`. Gated by admin session **or** `x-cron-secret`.

This repo's readers are AI agents, not a human opening a dashboard. A JSON endpoint is worth more here than a panel, and it is nearly free — `listAiRuns` (`lib/runs.ts:217-239`) is already written, already redacted, already typed, already has an index to serve it, and has **zero callers** today.

**Read-only as to code changes. There is no write-back endpoint that edits the repo and no agentic triage workflow.** See §14.

**But the group state machine needs storage before Phase 6, or nothing can ever be closed.** `state`, `mutedUntil`, `notes`, `resolvedInSha` and the "≥3 unacknowledged escalation attempts" valve all live in the indefinitely-deferred `fault_groups` table. In shipped Phases 1–5 there would be no ack, no mute, no resolve — only a 6-hour re-alert loop, so a noisy fingerprint could be silenced **only by a deploy**. That is not acceptable for eighteen months of unattended operation. **Phase 4 therefore ships `fault:ack` / `fault:mute` / `fault:resolve` rows in `event_log`, keyed by fingerprint**, plus one authenticated admin action to write them. The state machine reads the latest such row per fingerprint. Phase 6's table, if it ever lands, is an optimization of storage — never the thing that first makes triage possible.

### Tier 5 — Push (the only thing that reaches Danny)

The hourly `POST /api/cron/dispatch-alert` tick gains a second call to `runFaultAlertTick()`. Reuses `decidePosting`, `REALERT_MS = 6h`, durable `event_log`-backed dedup (safe across 1–3 instances), affirmative-clear-only recovery, and `sendChatMessage` + `tagHubChatPost` to Google Chat via the operator token and `ALERT_CHAT_SPACE`. Non-200 or undelivered → the workflow's `jq` exits 1 → **GitHub's failure email is the last-resort channel for a dark Hub**, exactly as `.github/workflows/dispatch-alert.yml:9-14` already designs it. One extra `faults` key in the JSON response; no new workflow, no new secret, no new cron.

Plus a **once-daily digest post** in the same tick, which **reports even when it finds nothing** so silence is never mistaken for health:

- Top 10 fingerprints by count, with delta vs yesterday
- New since yesterday · Regressed · Escalating
- The `ticket` tier: real-but-slow-burning faults that need a look but not a page
- The degraded panel: truncation rate, empty-but-billed, fallback rate, TTFT p95
- `suppressed` / `ringFull` / `sinkFailed` drop counters
- Reconciliation findings: orphaned `ai_request_start`, stuck `tool_runs`, expired-lease `dispatch_jobs`

### 9.1 The alerting policy, and why

| Tier | Fires on | Destination | Volume target |
|---|---|---|---|
| **PAGE** | `actionability === 'page'` only — a fatal, or a NEW/REGRESSED/ESCALATING `error` with server/upstream/timeout blame. Plus `sinkFailed > 0`, plus the zero-signal condition. | Google Chat on the next hourly tick (**~70 min worst case**), GitHub failure email as fallback | **Median 0/day. Hard ceiling 2 per 12 hours.** |
| **TICKET** | New but slow-burning; a regression without a rate spike | Named section in the daily digest | Whatever it is; nobody is woken |
| **DIGEST** | Everything ongoing | One Chat post per day | Always posts, even when empty |
| **RECORD** | `expected`, `cancelled`, benign session churn | `event_log` only | Silent by design |

**Justification, drawn from the SRE research:**

- *"Every page should be actionable… Pages should be about a novel problem or an event that hasn't been seen before."* NEW / REGRESSED / ESCALATING **is** the operational definition of novel. ONGOING is not, and belongs on a dashboard.
- *"Email alerts are of very limited value and tend to easily become overrun with noise; instead, you should favor a dashboard that monitors all ongoing subcritical problems."* Google's own footnote calls per-error email "alert spam, as they are rarely read or acted on." This is why the DIGEST tier exists and why per-occurrence notification is banned outright.
- *"The maximum number of incidents per day is 2 per 12-hour on-call shift… the distribution of paging events should be very flat over time, with a likely median value of 0."* Datadog's 2025 on-call guidance independently lands on the same ceiling. For a solo founder that ceiling is the design target, not an aspiration.
- **No burn-rate SLO math, deliberately.** The SRE Workbook is emphatic: *"if a system receives 10 requests per hour, then a single failed request results in an hourly error rate of 10%. For a 99.9% SLO, this request constitutes a 1,000x burn rate and would page immediately."* Copying the 99.9%/14.4× recipe onto this app pages on one flaky request. The Workbook's own first remedy is synthetic traffic — so **if** real traffic ever arrives, add a black-box prober against `/` and `/api/healthz` at a 1–5 minute interval and compute burn rate from *prober* results, and derive the SLO from four weeks of measured data rounded down to two significant figures (Google's worked example lands on **97%**, not 99.9%). Do not retrofit ratio-based SLOs onto ten requests an hour.
- **No duration/`for:` clause as the noise filter.** *"We do not recommend using durations as part of your SLO-based alerting criteria."* A service failing 100% for 5 minutes every 10 minutes never trips a 10-minute duration gate despite burning 35% of the budget.
- **Alertmanager's four dials, adopted conceptually:** batch related faults into one post (`group_by` fingerprint), delay ~30 s before the first notification so a self-resolving blip produces **no notification at all**, only re-notify when membership changes (the existing `REALERT_MS = 6h`), and inhibit lower-severity posts while a higher-severity one is firing. That last one is not optional — without it, one severe incident fires every tier at once.
- **Redundant delivery paths.** Google documents that Cloud Mobile App, PagerDuty, Webhooks, and Slack are *"all powered by the same Google Cloud internal service and therefore share a single point of failure."* Chat + the GitHub failure email are two independent paths, which is exactly why the existing `dispatch-alert.yml` design is worth preserving verbatim.

---

## 10. Vendor decision

**Recommendation: build first-party. Do not buy an error tracker now. Write down the trigger that would change that.**

### 10.1 Why

**The CSP is not merely an obstacle; it is a constraint that points the same way as the right answer.** The production directive is literally `connect-src 'self';` (`middleware.ts:55`). Every hosted vendor's browser transport is blocked by construction. Sentry's documented workaround (`tunnelRoute: '/monitoring'`) does work — the SDK POSTs same-origin — but it requires the tunnel route, a middleware matcher exclusion at `middleware.ts:113`, and the whole `withSentryConfig` build integration. And a same-origin first-party sink is the *correct* answer anyway for an app holding health-client data under a HIPAA-shaped threat model: the error record never leaves the perimeter, no CSP header changes, no PII crosses a vendor boundary, and ad-blockers cannot silence reporting.

**The Next 14.2.35 pin removes the hook the vendor integration is built around.** `onRequestError` requires Next 15 and `@sentry/nextjs >= 8.28.0`. Adopting Sentry properly means budgeting a Next 15 upgrade — and *that* upgrade is deliberately not on this critical path, because pinning error reporting to a framework bump is how error reporting stays unshipped for a quarter.

**Phase 1 is nearly identical whether or not you buy.** Every proposal converged on the same first PR: the pure fault module, the wrapper, the `googleApiErrorResponse` edit, the client sink. The vendor is additive on top of that spine, which means the decision is genuinely deferrable at near-zero cost.

### 10.2 The honest tradeoff

Buying Sentry purchases three things that are genuinely hard to build and that this design gives up:

1. **A decade-tuned grouping engine**, with hand-written built-in fingerprint rules for exactly the two noisiest Next.js classes — **chunk-load and hydration errors** — plus AI-enhanced embedding-based merging that Sentry reports cut issue noise ~40%.
2. **Source-map symbolication** with the generate → upload → **delete** pattern (`deleteSourcemapsAfterUpload` defaults `true` for client maps, deliberately keeps server maps). This is the only way to get readable *and groupable* browser stacks without publishing your source. Sentinel does not have this, which is the single biggest quality gap in the design.
3. **Automatic Regressed / Escalating state**, tied to release, with published algorithms that do not false-positive on cron burstiness.

What we lose, concretely: browser-side grouping is meaningfully worse; there is no merge/unmerge UI, no embedding similarity, no ten years of tuning; the escape hatches are a call-site override and a small rule table, and that is the whole toolkit. Expect hand-tuning during the first month. There is also no session replay, no breadcrumbs, no user-feedback widget, no release health, no issue-assignment workflow — if Danny ever needs "show me what the user clicked before it broke," this design has no answer.

And the primary durable store is the same Postgres the app depends on: it is **inside the failure domain**. That is why the synchronous `console.log` line is the source of truth, why the DB is explicitly labeled best-effort, and why the `sinkFailed` counter and zero-signal alarm exist. A total container loss before the log line flushes still loses the record.

### 10.3 The numbers

| Option | Cost | Verdict |
|---|---|---|
| **Sentinel (this design)** | **$0/mo.** Cloud Logging ~90 MB/mo vs 50 GiB free. Error Reporting free. Postgres noise. | **Recommended.** |
| **Sentry Developer** | **$0.** 5,000 errors/mo, **1 user**, 5 GB logs, 5M spans, 50 replays, 1 uptime + 1 cron monitor. | Volume is not the wall; the **1-user limit** is. |
| **Sentry Team** | **$26/mo billed annually** ($29 monthly). 50k errors, 5 GB logs, 5M spans. | The upgrade target. |
| **Sentry Business** | **$80/mo.** *Identical* included volume; overage is 2–3× Team's per-error rate. | Rejected — an overage-dominated bill is **more** expensive on Business, not less. |
| **Self-hosted Sentry** | Minimums 4 vCPU / 16 GB RAM + 16 GB swap / 20 GB disk (2 CPU / ~7 GB under the `errors-only` compose profile). A VM costing multiples of $26/mo before the ClickHouse upgrade treadmill. FSL-1.1-Apache-2.0 (not OSI open source for two years). | Rejected. Self-hosting is a data-residency answer, never a cost answer. |
| **PostHog** | 100k free exceptions/mo, no per-seat charge, per-issue token-bucket rate limiting. | Strong alternative if product analytics is ever wanted. Younger grouping/symbolication. |
| **Better Stack** | 100k free exceptions/mo; **ingests Sentry SDK payloads natively** (`https://$TOKEN@$HOST/$APP_ID`). | The reason a Sentry decision stays reversible. |
| **Grafana Faro / Axiom / Dash0** | Faro is frontend-only RUM; Axiom and Dash0 ship **no** error grouping, symbolication, or issue state. | Not error trackers. Picking them for errors is build-your-own with a rented database and a monthly bill. |
| **Highlight.io** | **Dead.** Acquired by LaunchDarkly; services deprecated **2026-02-28** — six months ago. | Any comparison still listing it is stale. |

### 10.4 The written trigger (put this in the runbook, with a date)

> **Adopt Sentry Team ($26/mo annual) when either is true: (a) a second human needs a login, or (b) fingerprint tuning exceeds 4 hours in a quarter.** At that point, budget the Next 15 upgrade first (`onRequestError` needs it), set `tunnelRoute: '/monitoring'` **and add `monitoring` to the matcher's negative lookahead alongside `login`** — `/monitoring` is a *page* path, so without that exclusion an unauthenticated tab gets the redirect to `/login`, not a 401, and the tunnel silently swallows every report from a signed-out session (zero CSP edits either way), `release: GIT_SHA` + `dist: K_REVISION`, `tracesSampleRate: 0.05`, Replay off, `sendDefaultPii: false`, and `beforeSend` calling the **existing Phase-1 redactor** so there is exactly one PII implementation. Keep the PAGE tier first-party on Chat regardless, so a vendor outage cannot make the Hub go dark unnoticed. Better Stack and self-hosted Sentry accept the same wire format, so this stays a DSN env var, not a re-instrumentation project.

A tradeoff with no exit condition rots into folklore. A dated trigger does not.

---

## 11. The phased plan

### Phase 0 — Export-form spike (gate, ~20 lines, half an hour)

**Nobody validated this and it is load-bearing.** Verified: `grep -c '^export const \(GET\|POST\|PUT\|PATCH\|DELETE\)' app/api --include=route.ts` returns **0** — not one of the 112 handlers uses the `export const VERB =` form today. Meanwhile `npm run build` is `next build && node scripts/assert-dynamic-rendering.mjs`, which **fails hard** if any route outside `/_not-found`, `/404`, `/500` appears in `.next/prerender-manifest.json`.

**Deliverable:** convert **two** routes to `export const GET = withFault(name, handler)` with an identity-function stub wrapper — one static (`app/api/admin/agy-health/route.ts`) and one with **dynamic params** (`app/api/deep-runs/[id]/route.ts`) — and prove `npx tsc --noEmit && npm run lint && npm run build && npx vitest run` is green on both. The dynamic one is the one that actually exercises the risk: `tsconfig.json` includes `.next/types/**/*.ts`, so Next 14 type-checks the handler's *second* argument (`{ params }`) against the export, and the generic `...args: A` form is exactly what could fail there. The likely outcome is benign (an opaque HOF pushes Next toward dynamic, which is what this repo wants) but "likely benign" is not a verified build gate, and CI auto-merges.

**Effort:** 30 minutes. May ride as the first commit of Phase 1's PR **if it passes**; if it fails, Phase 1 is blocked and the mechanism needs rethinking before 112 handlers are touched.

---

### Phase 1 — The spine (ONE PR, server-only, no migration, no client, no new env var)

**New files**
- `hub/lib/errors.ts` — the `AppError` base (one constructor with `setPrototypeOf(this, new.target.prototype)`, `captureStackTrace?.(this, new.target)`, and `super(message, { cause })`), the closed `FaultCode` union, and `statusForCode` with the `never` default.
- `hub/lib/fault.ts` — `FaultRecord`, `toFault(err, ctx)`, `newFaultId()`, `flattenError()`, `causeChain()`, `scrubContext()`, `scrubFreeText()`, `faultResponse()`. **All pure**: zero I/O, no `Date.now()`, mirroring `toRunRow` / `toAuditRow`.
- `hub/lib/fault-fingerprint.ts` + `hub/lib/fault-fingerprint-rules.ts` — §5, including the deploy-free rule table.
- `hub/lib/fault-report.ts` — `reportFault()` = pino `log.error` in GCP `ReportedErrorEvent` shape + `emit({ type: 'fault', … })` + the per-fingerprint token bucket + the `suppressed`/`sinkFailed` counters.
- `hub/lib/route-fault.ts` — `withFault()` with control-flow re-throw, the 2xx-body contract check, and the brand symbol.

**Modified**
- `hub/lib/observability.ts` — add the union member, add `'fault'` to `PERSISTED_EVENT_TYPES`, **amend the module PII note** to describe the safe-by-scrubbing contract.
- `hub/lib/logger.ts` — refactor to a module-scope root instance + `child()` (see Layer 0), and configure the GCP `ReportedErrorEvent` shape. Pino emits `"level": 50` and `"msg"` by default, **not** `"severity"` and `"message"`, so this needs explicit config: `formatters: { level: (label) => ({ severity: label.toUpperCase() }) }`, `messageKey: 'message'`, `timestamp: pino.stdTimeFunctions.isoTime`, and a `base` carrying `serviceContext`. Verify the option names against `pino@10` before shipping. This is "Step 0" and it is what gives Phase 1 a push channel on day one, for free.
- `hub/middleware.ts` — mint + propagate `x-hub-request-id`, parse `traceparent`, try/catch the body.
- `hub/lib/google-session.ts` — `googleApiErrorResponse` gains a required `ctx: { requestId, route, method }` argument, logs, reports, and stops leaking the raw upstream message. **44 call sites updated mechanically.**
- Wrap the 5 genuinely unguarded write handlers: `worker/jobs/[id]/result`, `worker/jobs/[id]/heartbeat`, `orgs/[orgId]/founder-lens` (GET+POST), `cron/dispatch-alert`.
- Fix the three HTTP-200-with-error routes (`companies:63`, `projects:72`, `auth/register:60`).
- Doc-drift fixes in the same PR: the stale CSP comment at `next.config.js:4-6` and the stale index comment at `app/api/admin/ai-health/route.ts:29-31`.

**Tests** — `lib/fault.test.ts` (cause-chain depth; `flattenError` contract; the PII property case), `lib/fault-fingerprint.test.ts` (stability across line-number churn and across releases; ordered-normalization correctness; status codes and SQLSTATEs preserved), `lib/route-fault.test.ts` (redirect/notFound re-throw; 500 shape; prod vs dev body; **the reporter-cannot-break-a-request test**), extend `lib/observability.test.ts` to hold `fault` events to the no-`@` assertion, `tests/route-fault-coverage.test.ts` (brand check with an explicit allowlist covering the not-yet-wrapped 106).

**Effort:** ~1,000–1,200 LOC across ~22 files. **2 agent sessions, 2 PRs** — split at the pure modules + their tests (PR 1) / the wiring, middleware, `logger.ts` refactor, the 44-site `google-session` signature change and the route fixes (PR 2). The earlier "~450 LOC" estimate did not cover the test bodies §13.1 specifies, the logger refactor, or the 44 call sites. Runtime risk stays near zero: the fault path is additive and every write is best-effort. The only behavior users can observe is that error bodies stop leaking internals and three routes start returning correct status codes.

**What you get on day one:** every Google integration failure becomes visible; the five most dangerous unguarded write paths get a catch-all; the two log seams become joinable; and GCP Error Reporting starts grouping server faults and emailing on new/reopened groups — a real push channel, at zero additional code.

---

### Phase 2 — Coverage sweep, process-level, retention (4–5 PRs)

- `withFault` on all 112 handlers; the coverage-test allowlist goes to **zero**.
- `hub/lib/fault-process.ts` + `hub/instrumentation.ts` + `experimental.instrumentationHook: true` + `scripts/assert-instrumentation.mjs` asserting **both** (either alone is a silent no-op) + `uncaughtExceptionMonitor` + an `unhandledRejection` listener **gated to the Next server only** (see the refined Layer 8: on the plain-Node worker a listener would suppress the crash, and the monitor already covers it there) + a SIGTERM handler that never calls `process.exit()`. Import `fault-process.ts` from `scripts/dispatch-worker.ts` too — the worker is a plain Node process that `instrumentation.ts` never reaches.
- Instrument `authOptions.callbacks` / `events` in `lib/auth.ts` (the NextAuth route can never be wrapped) and seed `PERMANENT_EXEMPTIONS` with its reason string.
- `lib/swallow.ts` + codemod the 121 zero-arg `.catch(() => …)` sites to `swallow()` / `emptyOn()`, prioritizing the 18 lossy data-omission sites over the ~100 benign guards. Pure mechanical change, zero semantics, CI-safe.
- Instrument `lib/retry.ts` with `onAttempt`; map `CircuitOpenError` → `upstream_breaker_open`.
- Retention: move `pruneOldEventLogs` into the hourly tick; add `pruneOldAiRuns(90d)` for `ai_runs` / `ai_action_log` / `tool_runs`.
- Typed ESLint: `parserOptions.project`, `no-floating-promises`, `only-throw-error` with **`allowThrowingAny: false, allowThrowingUnknown: false, allowRethrowing: true`** (the first two default to `true` and neuter the rule), `use-unknown-in-catch-callback-variable` (Promise `.catch()` callbacks are `any` even under `strict` — a real hole 121 sites wide that the codemod closes by discipline alone and the lint rule keeps closed).
- `tests/no-200-errors.test.ts` as a build-time guard.

**Effort:** ~700 LOC + a codemod script, spread across many files. 2 sessions, safely splittable into 4–5 small PRs since the coverage test names each remaining gap.

---

### Phase 3 — Client capture and the same-origin sink (2 PRs)

- `hub/app/api/client-fault/route.ts` — zod-validated, `checkActionLimit`-throttled, Origin-checked, accepting **both** `application/csp-report` (kebab-case, wrapped) and `application/reports+json` (camelCase, batched); added to the middleware matcher exclusion so a dead session can still report.
- `hub/middleware.ts` — `Reporting-Endpoints` on every response with an endpoint named exactly `default`; `report-uri` **and** `report-to` on the CSP.
- `hub/app/lib/fault-client.ts`, `hub/app/components/FaultListeners.tsx`, `hub/app/global-error.tsx` (verified against `next build && next start`).
- Modify `app/error.tsx`, `LeftPanelShared.tsx`, `app/page.tsx` (generalize the boundary), `app/providers.tsx` (QueryCache/MutationCache), `useWriteFetch.ts` + `readFetch`.

**Effort:** ~500 LOC, 12 files. 1 session. Needs an e2e fixture: `playwright.config.ts` mocks every `/api/*` at the browser layer, so the client-fault POST needs a `page.route` mock rather than a live endpoint.

---

### Phase 4 — Push, digest, zero-signal, surfacing (2 PRs)

- `hub/lib/fault-alerts.ts` — a sibling of `lib/dispatch-alerts.ts` reusing `decidePosting`, `REALERT_MS`, durable `event_log` dedup, affirmative-clear recovery, `sendChatMessage` + `tagHubChatPost`. Pure `decideFaultAlerts(snapshot)` unit-tested with fixtures.
- Modify `app/api/cron/dispatch-alert/route.ts` to call both ticks; modify `.github/workflows/dispatch-alert.yml`'s `jq` to fail on undelivered fault alerts.
- `recordEventStrict()` in `lib/event-logger.ts` so `sinkFailed` is actually observable, plus the reporter reentrancy latch — **without these the alarms below have no wiring**.
- The zero-signal alarm and drop counters in `/api/healthz`.
- The cron **dead-man's switch**: persist `last_tick_at`, plus the second independent observer (Cloud Scheduler or a GCP log-based-metric alert) and the one Cloud Monitoring policy for platform-level failures (Layer 10).
- `fault:ack` / `fault:mute` / `fault:resolve` rows in `event_log` and one authenticated admin action, so a noisy fingerprint can be silenced **without a deploy**.
- `GET /api/agent/faults` (read-only ranked queue) and a Faults panel on `/admin/ai-health` fed by pure `computeFaultHealth()`.
- `hub/docs/runbooks/fault-reporting.md` with the house YAML frontmatter, a fault query pack appended to `hub/docs/observability-queries.md`, and a **pointer** (not a restatement) in `AGENTS.md`, per CLAUDE.md's doc-precedence rule.

**Effort:** ~550 LOC, 9 files. 1 session. This is what closes the "must not babysit dashboards" requirement with first-party control.

---

### Phase 5 — Streaming, silent failures, reconciliation, source maps (3 PRs)

- `lib/stream-outcome.ts` + the terminal-frame contract in `app/api/chat/route.ts` + `sawTerminal` and the idle-stall watchdog in `useChatEngine.ts`.
- The four degraded detectors; either persist `ai_first_token` or delete the permanently-null `firstTokenMs` field.
- `lib/invariants.ts` (cheap shape assertions on the ten Google write routes).
- `lib/fault-reconcile.ts` in the hourly tick — orphaned `ai_request_start`, stuck `tool_runs`, expired-lease `dispatch_jobs`.
- A canary route that throws a known error so CI can assert the resolved server frame points at its own source file after every deploy. (The `experimental.serverSourceMaps: true` + `NODE_OPTIONS='--enable-source-maps'` flags themselves moved **into Phase 1** — see §5: without them the `frames` fingerprint rung is effectively dead code.)
- Google webhook receiver hardening: always-ack-200, `webhook_delivery_failed` / `watch_channel_expired`, and the expired-channel reconciliation check.
- Map `lib/vector-store.ts` / `lib/ingest-client.ts` failures onto `vector_store_error`, plus the stale-embedding-model `degraded` invariant.

**Effort:** ~500 LOC. 1–2 sessions.

---

### Phase 6 — Dedicated tables (evidence-gated; may never ship)

`drizzle/0012_faults.sql` plus the `faultGroups` / `faultEvents` schema from §4.5, with resolve-in-release semantics. **Only build this if the digest proves `event_log` volume or query latency is a real problem.** Every read and write must be `isMissingTableError`-guarded and `tables_missing` must be its own alert kind — `docker-entrypoint.sh` is non-fatal on migration failure, so an unguarded new table makes the error system *silently absent*, which is the worst possible way for an error system to fail.

**Effort:** ~300 LOC + one migration. Deferred indefinitely by design.

---

## 12. Code sketches

House style: 2-space indent, no semicolons, single quotes, trailing commas, `@/` alias across directories.

### 12.1 The error class hierarchy — `hub/lib/errors.ts`

```ts
import type { FaultCode } from '@/lib/fault-codes'

export type AppErrorOptions = {
  code: FaultCode
  /** Fixed per code; the ONLY text a client ever sees. */
  userMessage?: string
  /** ES2022 cause. MUST be forwarded to super() or it is silently dropped. */
  cause?: unknown
  /** Allowlist-filtered by scrubContext() before it reaches a record. */
  context?: Record<string, unknown>
  /** Decided once, here, where the failure's meaning is known. */
  retryable?: boolean
  /** Fingerprint override for a call site that knows better than the cascade. */
  fingerprint?: string
}

/**
 * ONE base class for every application error. A closed `code` union — not a
 * class per case — is what gives exhaustiveness in statusForCode()'s switch.
 *
 * The three rituals below live HERE and nowhere else:
 *   - setPrototypeOf with new.target (never a hardcoded class, or instanceof
 *     breaks for every subclass),
 *   - captureStackTrace with new.target so the trace starts at the throw site
 *     rather than inside this constructor,
 *   - super(message, { cause }) — forwarding the OPTIONS OBJECT is the only way
 *     ES2022 installs `cause`. `super(message)` drops the whole chain silently.
 */
export class AppError extends Error {
  readonly code: FaultCode
  readonly userMessage: string
  readonly context?: Record<string, unknown>
  readonly retryable: boolean
  readonly fingerprint?: string

  constructor(message: string, opts: AppErrorOptions) {
    super(message, { cause: opts.cause })
    Object.setPrototypeOf(this, new.target.prototype)
    Error.captureStackTrace?.(this, new.target)
    this.name = new.target.name
    this.code = opts.code
    this.userMessage = opts.userMessage ?? USER_MESSAGES[opts.code]
    this.context = opts.context
    this.retryable = opts.retryable ?? DEFAULT_RETRYABLE.has(opts.code)
    this.fingerprint = opts.fingerprint
  }
}

/** The five existing ad-hoc classes are retrofitted, not merely recognized. */
export class CircuitOpenError extends AppError {
  constructor(key: string, cause?: unknown) {
    super(`Circuit open for ${key}`, {
      code: 'upstream_breaker_open',
      cause,
      context: { key },
      retryable: false, // we did not try, by policy — retrying is meaningless
    })
  }
}

/**
 * Exhaustive by construction: adding a FaultCode without mapping it here is a
 * COMPILE error, not a runtime 500. This is the whole reason the union is
 * closed rather than a family of unrelated Error subclasses.
 */
export function statusForCode(code: FaultCode): number {
  switch (code) {
    case 'validation_failed':      return 422
    case 'auth_unauthenticated':
    case 'auth_reauth_required':   return 401
    case 'auth_forbidden':
    case 'google_scope_missing':
    case 'google_api_not_enabled': return 403
    case 'not_found':              return 404
    case 'conflict':               return 409
    case 'payload_too_large':      return 413
    case 'rate_limited':           return 429
    case 'upstream_4xx':
    case 'upstream_5xx':
    case 'upstream_unavailable':
    case 'upstream_breaker_open':  return 502
    case 'timeout_connect':
    case 'timeout_idle':
    case 'stream_stalled':         return 504
    // … every remaining member mapped explicitly …
    default: {
      const _never: never = code
      return 500
    }
  }
}
```

### 12.2 The route wrapper — `hub/lib/route-fault.ts`

This is the `withErrorHandling` wrapper the brief asks for; it is named `withFault` to match the record type.

```ts
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { createLogger } from '@/lib/logger'
import { toFault, faultResponse, newFaultId } from '@/lib/fault'
import { reportFault } from '@/lib/fault-report'

/** Non-enumerable brand. tests/route-fault-coverage.test.ts asserts on it —
 *  a brand survives re-exports; grepping for `withFault` does not, and passes
 *  on a commented-out import. */
export const FAULT_WRAPPED = Symbol.for('hub.faultWrapped')

type Handler<A extends unknown[]> = (
  req: NextRequest,
  ...args: A
) => Promise<Response> | Response

/**
 * Duty order is FIXED and each step exists for a reason:
 *   1. requestId  — the correlation spine (layer 0)
 *   2. pino child — so every line in this request shares module+correlationId
 *   3. run
 *   4. RE-THROW Next control flow FIRST — redirect() and notFound() are
 *      implemented as throws; a naive catch turns every intended navigation
 *      into a fake 500 and floods the tracker. Detect via the digest string,
 *      never instanceof (the class does not survive RSC serialization).
 *   5. 2xx contract check — a 2xx body carrying `error` is a silent failure
 *      and is caught STRUCTURALLY here so nobody has to remember.
 *   6. normalize -> report -> respond
 *
 * WHAT THIS CANNOT COVER, stated so 'we centralized error handling' never
 * becomes a false claim: it cannot change a streamed response after the shell
 * is flushed (hence the terminal-frame contract); it cannot inspect a streamed
 * 2xx body at all (the content-type/content-length gate skips them); it
 * cannot see Server
 * Component render errors (that is error.tsx / global-error.tsx); it cannot
 * catch React event-handler throws; and it MUST NOT make retry or compensation
 * decisions — a top-level handler cannot know which parts of an operation
 * already succeeded.
 */
export function withFault<A extends unknown[]>(
  name: string,
  handler: Handler<A>,
): Handler<A> {
  const wrapped = async (req: NextRequest, ...args: A): Promise<Response> => {
    // Trust the header ONLY where middleware set it. The matcher excludes
    // api/chat, api/worker, api/cron/, api/healthz, api/embeddings and
    // api/webhooks, so on those paths an external caller supplies this value
    // unvalidated — correlation poisoning, and unbounded cardinality in every
    // log field it lands in. Validate the shape, or mint fresh. (Same posture
    // as middleware deleting a client-supplied x-tenant-id.)
    const requestId = safeRequestId(req.headers.get('x-hub-request-id'))
    const log = createLogger(name, requestId)
    const faultId = newFaultId()

    try {
      const res = await handler(req, ...args)
      await assertNoErrorIn2xx(res, { name, requestId, route: name, log })
      res.headers.set('x-hub-request-id', requestId)
      return res
    } catch (err) {
      if (isNextControlFlow(err)) throw err

      // The reporter must never be able to break a request: if normalization
      // or reporting throws, we still owe the caller a well-formed response.
      try {
        const fault = toFault(err, {
          faultId,
          requestId,
          layer: 'route',
          route: name,
          method: req.method,
          module: name,
        })
        log.error({ err, faultId, code: fault.code }, `${name} failed`)
        reportFault(fault)
        return faultResponse(fault, process.env.NODE_ENV === 'production')
      } catch (reporterErr) {
        log.error({ err: reporterErr, faultId }, 'fault reporter failed')
        return NextResponse.json(
          { type: 'about:blank', title: 'Request failed', status: 500, instance: faultId, code: 'internal' },
          { status: 500, headers: { 'x-hub-fault-id': faultId, 'content-type': 'application/problem+json' } },
        )
      }
    }
  }

  Object.defineProperty(wrapped, FAULT_WRAPPED, { value: true, enumerable: false })
  Object.defineProperty(wrapped, 'name', { value: `withFault(${name})` })
  return wrapped
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A header-supplied id is accepted only if it is EXACTLY a UUID; else mint. */
function safeRequestId(header: string | null): string {
  return header && UUID_RE.test(header) ? header.toLowerCase() : crypto.randomUUID()
}

/** redirect() and notFound() throw an Error carrying a NEXT_* digest. */
function isNextControlFlow(err: unknown): boolean {
  const digest = (err as { digest?: unknown })?.digest
  return typeof digest === 'string' && (digest.startsWith('NEXT_REDIRECT') || digest === 'NEXT_NOT_FOUND')
}
```

### 12.3 The client capture bootstrap — `hub/app/components/FaultListeners.tsx`

```tsx
'use client'

import { useEffect } from 'react'
import { reportClientFault } from '@/app/lib/fault-client'

/**
 * Mounted inside <Providers> in app/layout.tsx. On next@14.2 there is no
 * instrumentation-client.ts (15.3+), so a root-layout client component is the
 * earliest available hook. Accepted blind spot: crashes during hydration
 * itself — which is exactly why the Reporting-Endpoints header (middleware.ts)
 * is shipped alongside this, since crash/CSP reports are delivered by the
 * browser out-of-band and need no listener at all.
 */
export default function FaultListeners() {
  useEffect(() => {
    // V8's default of 10 frames is often entirely React internals.
    Error.stackTraceLimit = 50

    // CAPTURE PHASE (true) is the only way to see resource-load failures:
    // a 404'd chunk, image, or stylesheet dispatches AT the element and does
    // not bubble, so a default-phase window listener never sees it.
    const onError = (e: Event) => {
      const target = e.target
      if (!target || target === window) {
        const ee = e as ErrorEvent
        reportClientFault({
          code: 'client_render',
          message: ee.message,
          stack: ee.error instanceof Error ? ee.error.stack : null,
        })
        return
      }
      const el = target as HTMLElement & { src?: string; href?: string; complete?: boolean; naturalWidth?: number }
      // React aborts in-flight <img> requests during re-render and fires
      // `error` for images that are fine. Re-check before reporting, or this
      // listener floods proportionally to render churn.
      window.setTimeout(() => {
        if (!el.isConnected) return
        if (el.complete && (el.naturalWidth ?? 0) > 0) return
        reportClientFault({
          code: 'client_resource_load',
          message: `${el.tagName} failed to load`,
          context: { tag: el.tagName, url: stripQuery(el.src ?? el.href ?? '') },
        })
      }, 500)
    }

    const onRejection = (e: PromiseRejectionEvent) => {
      reportClientFault({
        code: 'client_unhandled_rejection',
        message: describe(e.reason),
        stack: e.reason instanceof Error ? e.reason.stack : null,
        retractKey: keyFor(e.promise),
      })
    }

    // Retracts a report when a handler attaches late — TanStack Query and
    // Suspense resources legitimately do this, and without it they are a
    // permanent source of false positives.
    const onRejectionHandled = (e: PromiseRejectionEvent) => {
      reportClientFault.retract(keyFor(e.promise))
    }

    const onCsp = (e: SecurityPolicyViolationEvent) => {
      reportClientFault({
        code: 'client_csp_violation',
        message: `${e.effectiveDirective} blocked ${stripQuery(e.blockedURI)}`,
        // NOTE: e.sample is attacker-controlled. It is deliberately NOT sent.
        context: { directive: e.effectiveDirective, disposition: e.disposition },
      })
    }

    // buffered:true delivers reports generated BEFORE this observer existed —
    // on 14.2 that is the only way to see anything fired during hydration.
    const observer =
      typeof ReportingObserver !== 'undefined'
        ? new ReportingObserver(
            (reports) => {
              for (const r of reports) {
                reportClientFault({ code: 'client_deprecation', message: `${r.type}: ${r.body?.id ?? ''}` })
              }
            },
            { types: ['deprecation', 'intervention'], buffered: true },
          )
        : null
    observer?.observe()

    window.addEventListener('error', onError, true)
    window.addEventListener('unhandledrejection', onRejection)
    window.addEventListener('rejectionhandled', onRejectionHandled)
    document.addEventListener('securitypolicyviolation', onCsp)

    // NEVER 'unload': unreliable on mobile AND it evicts the page from bfcache.
    const onHide = () => {
      if (document.visibilityState === 'hidden') reportClientFault.flush()
    }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', reportClientFault.flush)

    return () => {
      window.removeEventListener('error', onError, true)
      window.removeEventListener('unhandledrejection', onRejection)
      window.removeEventListener('rejectionhandled', onRejectionHandled)
      document.removeEventListener('securitypolicyviolation', onCsp)
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', reportClientFault.flush)
      observer?.disconnect()
    }
  }, [])

  return null
}
```

### 12.4 The report ingest route — `hub/app/api/client-fault/route.ts`

```ts
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { checkActionLimit } from '@/lib/rate-limit'
import { toFault, newFaultId } from '@/lib/fault'
import { reportFault } from '@/lib/fault-report'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Same-origin sink for browser faults. Same-origin is MANDATORY, not a
 * preference: middleware.ts emits `connect-src 'self'` in production, so every
 * third-party beacon is CSP-blocked by construction.
 *
 * This path is EXCLUDED from the auth middleware matcher on purpose — the
 * unauthenticated 401 at middleware.ts:22 would otherwise eat every report
 * during dead-session failures, which is this app's known recurring failure
 * mode and the reports most worth having. The guards below replace that.
 */
const ClientFault = z.object({
  code: z.enum([
    'client_render', 'client_hydration', 'client_chunk_load',
    'client_unhandled_rejection', 'client_resource_load',
    'client_csp_violation', 'client_query_error', 'client_deprecation',
  ]),
  message: z.string().max(500),
  stack: z.string().max(4000).optional(),
  digest: z.string().max(64).optional(),
  route: z.string().max(200).optional(),      // pattern, not a concrete path
  // NOTE: no appSha. GIT_SHA is a Cloud Run RUNTIME env var (deploy.yml:111),
  // set after `gcloud run deploy --source` builds the image; nothing injects it
  // into the browser bundle and there is no NEXT_PUBLIC_* SHA. Client release
  // attribution is therefore server-stamped below, and per-client build
  // attribution is DEFERRED until a --build-arg path exists.
  context: z.record(z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
  suppressed: z.number().int().min(0).max(10_000).optional(),
})

/** Explicit allowlist — never Host-derived. */
const ALLOWED_ORIGINS = new Set([
  'https://hub.casatrejo.com',
  'https://hub-11747747730.us-central1.run.app',
])

/**
 * Exact, parsed origin match. `new URL()` normalizes scheme/host/port and
 * discards path, so a Referer of https://hub.casatrejo.com/settings reduces to
 * the origin — while https://hub.casatrejo.com.attacker.example reduces to
 * itself and fails the Set lookup. A missing header is a rejection, not a pass.
 */
function isAllowedOrigin(header: string | null): boolean {
  if (!header) return false
  try {
    return ALLOWED_ORIGINS.has(new URL(header).origin)
  } catch {
    return false // unparseable header — treat as hostile
  }
}

export async function POST(req: NextRequest) {
  // Cheap, non-spoofable-from-another-origin guard. Not auth — a defense
  // against a random host POSTing junk into our own error store.
  // NEVER derive the expected origin from the inbound Host: req.nextUrl.origin
  // is Host-derived, so it is the .run.app URL on the direct URL and
  // hub.casatrejo.com behind Cloudflare — legitimate reports would fail on one
  // of the two. And a bare `origin && …` check passes every request with NO
  // Origin/Referer at all (i.e. every curl). Allowlist, and require one.
  //
  // PARSE, then compare EXACTLY. A startsWith() test against the allowlist
  // also accepts https://hub.casatrejo.com.attacker.example — a prefix match on
  // an origin string is a classic bypass, and here it would let any such page
  // inject fault records from every one of its visitors, polluting fingerprints
  // and firing false alerts.
  if (!isAllowedOrigin(req.headers.get('origin') ?? req.headers.get('referer'))) {
    return new NextResponse(null, { status: 204 })
  }

  // hashIp() reuses the hashEmail() construction: §7 enumerates IP addresses as
  // identifiers, so the limiter key must not be a raw IP. checkActionLimit
  // returns an OBJECT, not a boolean, and needs a `client_fault` entry in
  // ACTION_LIMITS.
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  if (!checkActionLimit(hashIp(ip), 'client_fault').allowed) {
    return new NextResponse(null, { status: 204 }) // silent shed; never 429 a reporter
  }

  const kind = req.nextUrl.searchParams.get('kind')
  const raw = await req.text().catch(() => '')
  if (raw.length > 16_384) return new NextResponse(null, { status: 204 })

  // Browsers supporting report-to ignore report-uri and vice versa, so BOTH
  // wire formats must be accepted or a whole cohort reports nothing:
  //   application/csp-report      -> kebab-case, wrapped in { "csp-report": … }
  //   application/reports+json    -> camelCase, a batched array
  const payloads = kind === 'csp' ? normalizeCspReports(raw) : [safeJson(raw)]

  for (const payload of payloads) {
    const parsed = ClientFault.safeParse(payload)
    if (!parsed.success) continue
    const fault = toFault(new Error(parsed.data.message), {
      faultId: newFaultId(),
      requestId: req.headers.get('x-hub-request-id'),
      layer: 'client',
      code: parsed.data.code,
      route: parsed.data.route ?? null,
      stack: parsed.data.stack ?? null,
      release: process.env.GIT_SHA ?? 'unknown', // server-stamped; see the appSha note
      context: parsed.data.context,
    })
    reportFault(fault)
  }

  // 204 always. A reporter that can fail a request is worse than no reporter.
  return new NextResponse(null, { status: 204 })
}
```

**These sketches are illustrative, and the helpers they call are required exports, not hand-waving.** `stripQuery`, `describe`, `keyFor`, `safeJson`, `normalizeCspReports`, `hashIp`, and `assertNoErrorIn2xx` must be implemented and exported — `stripQuery` / `describe` / `keyFor` / `reportClientFault.retract` / `reportClientFault.flush` from `hub/app/lib/fault-client.ts`; `safeJson` / `normalizeCspReports` / `hashIp` from the ingest route's module; `assertNoErrorIn2xx` from `hub/lib/route-fault.ts` (gated exactly as Layer 3 step 5 specifies). Name them in the PR checklist or an agent will implement around them.

### 12.5 The fingerprint function

See §5 — `fingerprintFault()` in `hub/lib/fault-fingerprint.ts` is written out in full there.

---

## 13. Testing plan

The coverage ratchet in `hub/vitest.config.ts:46-51` (lines 45 / functions 67 / branches 79 / statements 45, over `lib/**/*.ts` and `app/api/**/*.ts`, with a "never lower them" comment) is a real gate, and CI auto-merges green PRs — **the tests are the only reviewer.** Every module in this design is pure, I/O-free and `Date`-free precisely so it tests densely and **raises** the ratchet.

### 13.1 Vitest — unit

| File | Proves |
|---|---|
| `lib/fault.test.ts` | `toFault` recognizes ZodError / AppError / postgres codes / Google errors / unknown; `flattenError` single-lines and truncates at 300 with `…`; `causeChain` walks a 3-deep `cause` and stops; `faultResponse` returns `details` outside prod and never inside it; `statusForCode` is exhaustive |
| `lib/fault-fingerprint.test.ts` | **Line-number churn:** the same stack with every line number shifted by +5 produces an **identical** fingerprint. **Release stability:** two records differing only in `release` group together. **Ordered normalization:** a message containing a UUID, an IP, an ISO timestamp and `pool exhausted after 30000ms` normalizes correctly and does **not** shred the UUID's digits. **Preservation:** `503` and `23505` survive; `1699882342` does not. **Route splitting:** two `timeout_idle` faults on different routes do **not** group. **Strategy:** each rung of the cascade is exercised and reports the right `fingerprintStrategy` |
| `lib/fault-redact.test.ts` | An `Error` whose `message` contains `danny@rxfitatx.com`, a `Bearer eyJ…`, `sk-…`, and a Postgres connection string produces a record with **no** `@`, no `eyJ`, no `Bearer`, no `sk-`. A stack containing `?token=…` comes out with the query string stripped. A `context` containing `{ password, body, ok: true }` retains only `ok` |
| `lib/observability.test.ts` (extended) | The existing hard assertions (no `'@'` in the emitted line; no `content`/`body`/`email`/`text`/`token` keys) now also run over **real thrown errors**, not only hand-written `SAMPLE_EVENTS` fixtures |
| `lib/route-fault.test.ts` | `redirect()` and `notFound()` digests **re-throw** unchanged; a thrown `AppError` yields the mapped status and problem+json; a 2xx body containing `error` emits `contract_violation`; the `x-hub-fault-id` header is set even on a body-less path |
| `lib/fault-classify.test.ts` | Severity/blame/actionability derivation; a served 4xx is `blame: 'client'` and never pages; a received 4xx is `upstream`; a retried-then-succeeded operation is one `degraded` with `retryCount`, not N errors |
| `lib/fault-alerts.test.ts` | `decideFaultAlerts(snapshot)` against fixtures: new / regressed-in-a-newer-release / escalating via the stddev branch / **a cron-shaped hourly burst that must NOT escalate** / `sinkFailed > 0` fires / an empty traffic window fires |
| `lib/stream-outcome.test.ts` | `classifyStreamEnd`: sentinel present + `success`; sentinel absent → `stream_incomplete`; abort → `cancelled` with **no** fault; idle-stall → `stream_stalled` |
| `tests/route-fault-coverage.test.ts` | Globs `app/api/**/route.ts`, dynamic-imports each module, asserts every exported GET/POST/PUT/PATCH/DELETE carries `FAULT_WRAPPED`. Allowlist shrinks PR by PR; failure message names the offending file path |
| `tests/no-200-errors.test.ts` | No handler returns a body containing an `error` key at status 200 (asserted against the three known offenders' fixtures plus the wrapper's runtime check) |
| `tests/client-fault-route.test.ts` | 204 on junk, 204 on oversize, 204 when rate-limited, a request with **no** Origin/Referer rejected, an off-allowlist Origin rejected, both CSP content types parsed, `script-sample` never stored |
| `lib/route-fault-streaming.test.ts` | **A streaming `Response` passes through `withFault` byte-identical** and its `ReadableStream` is never locked or consumed — the test that licenses wrapping the chat route |
| `lib/fault-report-sink.test.ts` | A **forced `event_log` insert failure increments `sinkFailed`** (proves `recordEventStrict` is actually wired, not merely specified); the reentrancy latch means a fault raised inside `reportFault` increments `selfFaults` and does not recurse |
| `lib/fault-storm.test.ts` | **The 500/hour global ceiling holds** under a synthetic storm of many distinct new fingerprints, and overflow raises the zero-signal alarm rather than failing silently |
| `lib/fault-alerts-tick.test.ts` | **Tick staleness fires** — a `last_tick_at` older than the threshold produces a `fatal` alert |
| `tests/instrumentation.test.ts` | `register()` actually installs `uncaughtExceptionMonitor` under `NEXT_RUNTIME=nodejs` and installs **nothing** under `edge` |
| `tests/reporting-headers.test.ts` | `Reporting-Endpoints` and **both** CSP report directives appear on a non-HTML response, and on a response from a middleware-**excluded** path (via `next.config.js` headers) |

### 13.2 The test that proves the reporter can never break a request

This is the single most important test in the plan, because it is what licenses shipping one wrapper to 112 handlers at once.

```ts
// hub/lib/route-fault.test.ts
describe('withFault — the reporter can never break a request', () => {
  it('returns the handler response unchanged when every sink throws', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => { throw new Error('stdout is gone') })
    vi.mocked(reportFault).mockImplementation(() => { throw new Error('sink exploded') })

    const handler = withFault('probe', async () => NextResponse.json({ ok: true }))
    const res = await handler(makeRequest('GET', '/api/probe'))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('still returns a well-formed 500 when toFault ITSELF throws', async () => {
    vi.mocked(toFault).mockImplementation(() => { throw new Error('normalizer exploded') })

    const handler = withFault('probe', async () => { throw new Error('boom') })
    const res = await handler(makeRequest('POST', '/api/probe'))

    expect(res.status).toBe(500)
    expect(res.headers.get('x-hub-fault-id')).toMatch(/^HUB-/)
    expect(await res.json()).toMatchObject({ status: 500, code: 'internal' })
    // And crucially: no unhandled rejection escaped.
  })

  it('never awaits the DB sink on the request path', async () => {
    const never = new Promise(() => {}) // a hung Postgres
    vi.mocked(recordEvent).mockReturnValue(never as never)

    const handler = withFault('probe', async () => NextResponse.json({ ok: true }))
    await expect(withTimeout(handler(makeRequest('GET', '/api/probe')), 50)).resolves.toBeDefined()
  })
})
```

Plus a sibling in `lib/fault-report.test.ts`: with `emit`, `recordEvent`, and `console.log` all throwing, `reportFault()` **returns normally** and increments `sinkFailed`.

### 13.3 Playwright e2e (`hub/tests/e2e/`)

`playwright.config.ts` today has a single `testDir: './tests/e2e'` and one `webServer` (`npx next dev -p 3100`, `NODE_ENV: 'development'`), and mocks every `/api/*` at the browser layer with no DB and no model keys — so these use `page.route` rather than a live endpoint.

**Two of these specs cannot run under that config.** `global-error.tsx` does not render in `next dev` on 14.2, and "no raw stack in the DOM" is only meaningful in a production build. Add a **second Playwright project** with its own `webServer` (`npm run build && npm run start -- -p 3101`, `NODE_ENV: 'production'`) and put those two specs there. Note this adds a full `next build` to the e2e job — budget the CI minutes deliberately.

| Spec | Proves |
|---|---|
| `fault-client-render.spec.ts` | A deliberately-thrown client render error is caught by the boundary, the fallback UI renders, **a POST to `/api/client-fault` is observed** with `code: 'client_render'`, and — asserted explicitly — **no raw stack text appears in the DOM** in a production build |
| `fault-client-resource.spec.ts` | A route-blocked `/_next` chunk produces a `client_resource_load` report via the capture-phase listener, and a normally-rendering image does **not** |
| `fault-reporter-cannot-break-the-app.spec.ts` | With `page.route('**/api/client-fault', r => r.fulfill({ status: 500 }))` **and** a second run aborting the route entirely, the app still renders, remains interactive, and logs no unhandled rejection. The reporter failing must be invisible to the user |
| `fault-global-error.spec.ts` | Run against `next build && next start` (not `next dev`, where `global-error` does not render on 14.2): a provider-level throw renders `global-error.tsx` with its own `<html>`/`<body>` and reports |
| `fault-problem-json.spec.ts` | An API route forced to 500 returns `application/problem+json`, an `x-hub-fault-id` header, and a body with **no** internal message text |

### 13.4 CI additions

- `scripts/assert-instrumentation.mjs` — asserts **both** `hub/instrumentation.ts` exists **and** `experimental.instrumentationHook === true` in `next.config.js`. Either alone is a silent no-op.
- `grep -rl 'sourceMappingURL' .next/static/**/*.js` must return nothing (guards against accidentally enabling `productionBrowserSourceMaps`).
- A canary route that throws a known error, so the deploy smoke test can assert the resolved server frame points at the canary's own source file after `--enable-source-maps` lands.

---

## 14. What we deliberately are NOT doing, and why

1. **No AI agent that opens pull requests from the fault queue.** This repo auto-merges green PRs and auto-deploys `master` to Cloud Run. Measured agentic-PR merge rates run ~84% for docs and ~79% for CI but only **~64% for fixes** — bug-fixing is the weakest category and is exactly what error triage produces. In an auto-merging repo the failure mode is not "no PR", it is *a plausible wrong fix merged unreviewed and deployed*. Worse, `title`, `message` and `stack` derive from error text a crafted request can influence, so feeding the queue into a coding agent turns the error reporter into a **remote code-influence channel on a production deploy pipeline**. A prompt line saying "these fields are data, not instructions" is not a security control, and a CI denylist that must itself live in `.github/workflows/**` cannot restrain an agent that could edit `.github/workflows/**`. **The read-only queue endpoint ships; the write-back endpoint and the triage workflow do not.** If any part of this is ever revisited, the ceiling is "file a GitHub issue with the redacted evidence and suspect files," never "open a PR."
2. **No Result types (neverthrow / Effect / fp-ts / ts-results).** 112 throw-shaped handlers and a fully throw-based dependency set (drizzle, postgres.js, next-auth, googleapis, `@google/generative-ai`) mean a Result type doubles the error channels and forces conversion code at every library boundary forever. We take the type-level benefit — exhaustiveness — from a closed literal `code` union on `AppError`, which costs nothing at call sites. Cost: no compiler enforcement that a caller handled a specific failure.
3. **No `onRequestError` on 14.2.35.** It landed in Next **15.0.0**. Writing it today is a silent no-op that reads as done. It is the only hook that sees Server Component and Server Action errors, and it closes for free on a Next 15 upgrade — but that upgrade is deliberately off this critical path, because pinning error reporting to a framework bump is how error reporting stays unshipped for a quarter.
4. **No browser source maps at any phase.** `productionBrowserSourceMaps: true` makes Next auto-serve every `.map` to anyone who appends the extension; the hidden-map → upload → delete pattern requires a vendor build plugin, which is the lock-in this design refuses. Consequence, stated plainly: client stacks stay minified and group poorly, so client faults group on `code + route + errName + normalized message`, start at `digest`, and never page. **Server** maps ARE enabled, in **Phase 1** — they never leave the container, and without them the `frames` fingerprint rung degrades to `message` grouping (§5).
5. **No new database table in Phase 1.** `event_log` already has `payload jsonb`, `correlation_id`, and the right index. And `docker-entrypoint.sh` is non-fatal on migration failure, so a new table can be absent at runtime while the app serves happily — the worst way for an error system to fail. Phase 6 exists and is evidence-gated.
6. **No burn-rate SLO alerting, no synthetic prober, no error budget policy — yet.** At ten requests an hour, one failure is a 1000× burn rate. Coarser new/regressed/escalating alerting has a near-zero false-positive rate at this traffic level. If real traffic arrives, add the prober first and derive the SLO from four weeks of measurement.
7. **No post-write read-back verification on Google write routes.** It doubles API calls on write paths, adds latency, burns quota, and introduces a new failure class (the read-back itself failing) that then needs its own classification and suppression rules. `assertInvariant` on the response shape gets ~80% of the value for ~5% of the cost.
8. **No session replay, breadcrumbs, user-feedback widget, release health, or issue-assignment workflow.** If "show me what the user clicked before it broke" ever becomes a requirement, that is the moment the vendor trigger fires.
9. **No cross-instance suppression state.** Per-process buckets across 1–3 Cloud Run instances mean suppression is up to 3× looser than configured. A durable counter would cost a DB round-trip on the error path — the worst possible place to add one. Mitigated by the global hourly ceiling and by reporting the dropped count in every digest.
10. **No `unhandledRejection` listener.** Node ≥15 defaults to `throw`. A log-only listener silently downgrades a crash to a swallow, which is strictly worse than nothing.
11. **No blanket instrumentation of all 121 `.catch(() => …)` sites.** Many are deliberate (date-formatting fallbacks in `LeftPanelUtils.ts:5,24`, JSON-parse skips in `useChatEngine.ts:439`, localStorage guards). The `lossy` flag encodes the judgment once, permanently, so nobody re-derives it — and only the ~18 lossy sites report.
12. **No second cron workflow, no second secret, no second failure-email path.** The hourly `dispatch-alert` tick absorbs everything.

---

## 15. References

**Next.js / React**
- https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
- https://nextjs.org/docs/14/app/building-your-application/optimizing/instrumentation
- https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation-client
- https://nextjs.org/docs/app/api-reference/file-conventions/error
- https://nextjs.org/docs/14/app/building-your-application/routing/error-handling
- https://nextjs.org/docs/app/getting-started/error-handling
- https://nextjs.org/docs/app/api-reference/file-conventions/not-found
- https://nextjs.org/docs/app/api-reference/file-conventions/loading
- https://nextjs.org/docs/app/api-reference/config/next-config-js/productionBrowserSourceMaps
- https://nextjs.org/docs/app/guides/memory-usage
- https://nextjs.org/docs/app/guides/open-telemetry
- https://nextjs.org/blog/next-15 · https://nextjs.org/blog/next-15-2 · https://nextjs.org/blog/next-15-3 · https://nextjs.org/blog/next-16
- https://github.com/vercel/next.js/discussions/59868 (middleware cannot catch route-handler exceptions; the HOF pattern)
- https://github.com/vercel/next.js/discussions/84412 (onRequestError fires only on truly uncaught exceptions)
- https://github.com/vercel/next.js/issues/94499 · https://github.com/vercel/next.js/issues/68004 · https://github.com/vercel/next.js/pull/72253 · https://github.com/vercel/next.js/issues/58883
- https://github.com/vercel/next.js/issues/51727 · https://github.com/vercel/next.js/pull/52281 (client-disconnect abort)
- https://github.com/vercel/next.js/issues/86099 · https://github.com/pinojs/thread-stream/issues/184 (pino worker-thread bundling under Next)
- https://legacy.reactjs.org/docs/error-boundaries.html · https://react.dev/reference/react/Component#static-getderivedstatefromerror · https://react.dev/reference/react-dom/client/createRoot · https://github.com/facebook/react/pull/28736

**Web platform**
- https://developer.mozilla.org/en-US/docs/Web/API/Window/error_event
- https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/error_event
- https://developer.mozilla.org/en-US/docs/Web/API/Window/unhandledrejection_event · https://developer.mozilla.org/en-US/docs/Web/API/Window/rejectionhandled_event
- https://developer.mozilla.org/en-US/docs/Web/API/Navigator/sendBeacon · https://developer.mozilla.org/en-US/docs/Web/API/Request/keepalive
- https://blog.huli.tw/2025/01/06/en/navigator-sendbeacon-64kib-and-source-code/
- https://developer.mozilla.org/en-US/docs/Web/API/Reporting_API · https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Reporting-Endpoints · https://developer.chrome.com/blog/reporting-api-migration · https://developer.chrome.com/docs/capabilities/web-apis/reporting-api · https://www.w3.org/TR/reporting-1/
- https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/report-to · https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/report-uri
- https://developer.mozilla.org/en-US/docs/Web/API/ReportingObserver
- https://html.spec.whatwg.org/multipage/server-sent-events.html
- https://www.rfc-editor.org/rfc/rfc9110.html · https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Trailer · https://github.com/whatwg/fetch/issues/772 · https://issues.chromium.org/issues/41301503 · https://kreya.app/blog/grpc-web-deep-dive/
- https://www.w3.org/TR/2016/REC-html51-20161101/webappapis.html (the muted-errors flag / "Script error.")
- https://github.com/whatwg/fetch/issues/526 · https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS/Errors
- https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error/cause · https://tc39.es/proposal-error-cause/ · https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/AggregateError · https://v8.dev/docs/stack-trace-api

**Standards: error records, correlation, problem details**
- https://opentelemetry.io/docs/specs/semconv/exceptions/exceptions-logs/ · https://opentelemetry.io/docs/specs/semconv/general/recording-errors/ · https://opentelemetry.io/docs/specs/semconv/registry/attributes/error/ · https://opentelemetry.io/docs/specs/otel/logs/data-model/ · https://opentelemetry.io/docs/specs/semconv/http/http-spans/
- https://opentelemetry.io/docs/security/handling-sensitive-data/ · https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/processor/redactionprocessor/README.md
- https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md · https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-metrics.md
- https://www.rfc-editor.org/rfc/rfc9457.html · https://www.w3.org/TR/trace-context/ · https://www.w3.org/TR/trace-context-2/ · https://www.rfc-editor.org/rfc/rfc5424.html
- https://www.elastic.co/docs/reference/ecs/ecs-error · https://www.elastic.co/docs/reference/ecs/ecs-otel-alignment-details
- https://www.hhs.gov/hipaa/for-professionals/special-topics/de-identification/index.html · https://www.law.cornell.edu/cfr/text/45/164.514

**Google Cloud**
- https://cloud.google.com/run/docs/logging · https://cloud.google.com/logging/docs/structured-logging · https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry · https://cloud.google.com/trace/docs/trace-log-integration
- https://cloud.google.com/error-reporting/docs/formatting-error-messages · https://cloud.google.com/error-reporting/docs/grouping-errors · https://cloud.google.com/error-reporting/docs/notifications · https://cloud.google.com/error-reporting/quotas · https://cloud.google.com/error-reporting/docs/setup/cloud-run · https://cloud.google.com/error-reporting/docs/release-notes
- https://cloud.google.com/logging/quotas · https://cloud.google.com/logging/docs/logs-based-metrics · https://cloud.google.com/logging/docs/logs-based-metrics/counter-metrics · https://cloud.google.com/logging/docs/alerting/monitoring-logs · https://cloud.google.com/monitoring/alerts/policies-in-api · https://cloud.google.com/monitoring/support/notification-options
- https://cloud.google.com/run/docs/container-contract · https://cloud.google.com/run/docs/tips/general · https://cloud.google.com/run/docs/configuring/billing-settings
- https://cloud.google.com/stackdriver/pricing · https://cloud.google.com/products/observability/pricing

**Vendors and grouping**
- https://docs.sentry.io/concepts/data-management/event-grouping/ · https://docs.sentry.io/concepts/data-management/event-grouping/fingerprint-rules/ · https://docs.sentry.io/concepts/data-management/event-grouping/stack-trace-rules/
- https://docs.sentry.io/product/issues/states-triage/ · https://docs.sentry.io/product/issues/states-triage/escalating-issues/ · https://docs.sentry.io/pricing/quotas/spike-protection/ · https://docs.sentry.io/pricing/quotas/manage-event-stream-guide/
- https://docs.sentry.io/security-legal-pii/scrubbing/server-side-scrubbing/ · https://docs.sentry.io/security-legal-pii/scrubbing/advanced-datascrubbing/
- https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/ · https://docs.sentry.io/platforms/javascript/guides/nextjs/sourcemaps/ · https://docs.sentry.io/platforms/javascript/configuration/integrations/breadcrumbs/ · https://docs.sentry.io/platforms/javascript/configuration/integrations/captureconsole/
- https://sentry.io/pricing/ · https://docs.sentry.io/pricing/ · https://develop.sentry.dev/self-hosted/ · https://open.sentry.io/licensing/ · https://blog.sentry.io/how-sentry-decreased-issue-noise-with-ai/ · https://develop.sentry.dev/sdk/telemetry/client-reports/
- https://docs.rollbar.com/docs/grouping-algorithm
- https://posthog.com/error-tracking/pricing · https://posthog.com/docs/error-tracking/rate-limiting · https://betterstack.com/pricing · https://betterstack.com/docs/errors/collecting-errors/sentry-sdk/
- https://launchdarkly.com/blog/welcome-highlight-to-launchdarkly/ · https://www.highlight.io/blog/launchdarkly-migration (Highlight.io deprecated 2026-02-28)
- https://grafana.com/products/cloud/frontend-observability/ · https://www.dash0.com/pricing · https://axiom.co/pricing

**SRE / alerting**
- https://sre.google/sre-book/monitoring-distributed-systems/ · https://sre.google/sre-book/being-on-call/
- https://sre.google/workbook/alerting-on-slos/ · https://sre.google/workbook/implementing-slos/
- https://sre.google/resources/practices-and-processes/incident-management-guide/
- https://www.datadoghq.com/blog/on-call-paging/
- https://prometheus.io/docs/alerting/latest/configuration/

**LLM streaming and provider error taxonomies**
- https://openrouter.ai/docs/api_reference/errors-and-debugging
- https://platform.claude.com/docs/en/api/errors · https://platform.claude.com/docs/en/build-with-claude/streaming
- https://github.com/anthropics/anthropic-sdk-python/issues/1258 (mid-stream error surfaced as `status_code: 200`)
- https://developers.openai.com/api/reference/resources/responses/streaming-events
- https://ai-sdk.dev/docs/ai-sdk-core/error-handling · https://ai-sdk.dev/docs/advanced/stopping-streams · https://github.com/vercel/ai/issues/14726
- https://docs.langchain.com/langsmith/run-data-format
- https://github.com/vllm-project/guidellm/issues/743

**TypeScript / Node / tooling**
- https://nodejs.org/api/process.html · https://nodejs.org/api/async_context.html
- https://www.davepacheco.net/blog/2014/error-handling-nodejs/ · https://github.com/goldbergyoni/nodebestpractices/blob/master/sections/errorhandling/useonlythebuiltinerror.md · https://github.com/joyent/node-verror/
- https://typescript-eslint.io/rules/no-floating-promises/ · https://typescript-eslint.io/rules/only-throw-error/ · https://typescript-eslint.io/rules/use-unknown-in-catch-callback-variable/
- https://www.typescriptlang.org/tsconfig/#useUnknownInCatchVariables · https://www.typescriptlang.org/docs/handbook/release-notes/typescript-2-2.html
- https://zod.dev/error-formatting · https://zod.dev/error-customization · https://zod.dev/v4/changelog · https://github.com/colinhacks/zod/releases/tag/v4.0.1
- https://github.com/pinojs/pino/blob/main/docs/help.md · https://github.com/pinojs/pino/blob/main/docs/redaction.md · https://github.com/pinojs/pino/blob/main/docs/asynchronous.md · https://www.npmjs.com/package/@google-cloud/pino-logging-gcp-config
- https://github.com/supermacro/neverthrow · https://effect.website/docs/error-management/expected-errors/ · https://medium.com/@ethanresnick/fixing-error-handling-in-typescript-340873a31ecd · https://event-driven.io/en/throw-result-or-neither/
- https://docs.stripe.com/api/errors · https://docs.stripe.com/api/request_ids

**Agentic-PR risk evidence**
- https://arxiv.org/abs/2601.15195v1 (33,596 agentic PRs; fix-type merge rate ~64%; reviewer abandonment as the top rejection cause)
- https://arxiv.org/html/2607.04003 ("AI-DDoS": 18.18% merge-rate decline for one-time contributors)
- https://docs.github.com/en/code-security/responsible-use/security-and-quality-ai-features (fabricated-dependency suggestions; semantic and location errors)

---

## Appendix A — Repo facts this document depends on (re-verified 2026-08-25 against `master` @ `b2eade0`)

| Fact | Evidence |
|---|---|
| `next: ^14.2.35`, `pino: ^10.3.1`, `zod: ^3.25.76`, `node >= 22` | `hub/package.json` |
| `next.config.js` has **no** `experimental` key | verified by `cat` |
| Zero `export const VERB =` forms in `app/api` | `grep -c '^export const \(GET\|POST\|PUT\|PATCH\|DELETE\)' app/api --include=route.ts` → `0` |
| One `'use server'` file | `app/admin/knowledge/actions.ts` |
| Next free migration number | `0011_chats.sql` is current → `0012_faults.sql` |
| `event_log` has `payload jsonb`, `correlation_id`, and `event_log_type_created_idx` on `(event_type, created_at)` | `lib/schema.ts:70-89` |
| `PERSISTED_EVENT_TYPES` is a plain `ReadonlySet` of 4 of 14 union members | `lib/observability.ts:81-86` |
| `persistTelemetryEvent` swallows every failure | `lib/observability.ts:128-146` |
| `emit()` is one `console.log(JSON.stringify(...))` + a fire-and-forget sink | `lib/observability.ts:151-160` |
| `withCorrelationId` exists and has zero callers | `lib/logger.ts:20-22` |
| Production CSP is literally `connect-src 'self';` | `middleware.ts:55` (the `isDev` ternary is empty in prod) |
| Unauthenticated `/api/*` returns JSON 401; matcher excludes `api/cron/`, `api/worker`, `api/healthz`, … | `middleware.ts:22-24`, `middleware.ts:113` |
| `googleApiErrorResponse` returns `{ error: message }` with the raw upstream message and logs nothing | `lib/google-session.ts:106-121` |
| `flattenError` truncates to 300 chars with `…`; `SENSITIVE_META_KEYS` is a `ReadonlySet` | `lib/runs.ts:89-106` |
| `recordAiRun` self-reports its own write failure via `emit({type:'ai_error', code:'ai_run_write_failed'})` | `lib/runs.ts:160-169` |
| `chatErrorBody` is the only `NODE_ENV`-gated error body | `lib/chat-error.ts:7-15` |
| `GIT_SHA=$GITHUB_SHA` is already in the deploy env-var string | `.github/workflows/deploy.yml:111` |
| Build gate is `next build && node scripts/assert-dynamic-rendering.mjs` | `hub/package.json:10` |
| `checkActionLimit(email, actionType, now?)` returns `{ allowed, retryAfterSec? }` — an object, not a boolean | `lib/rate-limit.ts:100-107` |
| `ACTION_LIMITS` has no `client_fault` entry (only `gmail_send`, `chat_post`, `task_create`, `file_share`) | `lib/rate-limit.ts:82-90` |
| `googleApiErrorResponse(err: unknown)` takes **only** `err` — no requestId, route, or method | `lib/google-session.ts:106` |
| `SectionErrorBoundary.componentDidCatch` does a bare `console.error` | `app/components/LeftPanelShared.tsx:195, 205-206` |
| `recordEvent` catches its own insert failure and returns a **resolved** promise | `lib/event-logger.ts:41-44` |
| The `QueryClient` has no `queryCache`/`mutationCache` `onError` | `app/providers.tsx:17-27` |
| `app/error.tsx` renders `error.stack` unconditionally, production included | `app/error.tsx:49-51` |
| No `app/global-error.tsx`, no `instrumentation.ts`, no `instrumentation-client.ts` | verified absent |
| `pruneOldEventLogs` (30 d, tenant-scoped) has exactly one caller, a user-triggerable route | `lib/agent-memory.ts:108`, `app/api/kpis/sync/route.ts:210` |
| `ai_runs` has **no** prune job anywhere | verified by grep |
| `playwright.config.ts` has one `testDir` and one dev-mode `webServer` on port 3100 | `hub/playwright.config.ts:32, 48-58` |
| Coverage ratchet: lines 45 / functions 67 / branches 79 / statements 45 over `lib/**`, `app/api/**`, `app/hooks/**` | `hub/vitest.config.ts` |
| `scripts/dispatch-worker.ts` is a plain Node process, outside the Next runtime | `hub/scripts/dispatch-worker.ts` |
| `app/api/webhooks/google/` and `lib/google/watch-channels.ts` exist and are uninstrumented | verified present |
| `onRequestError` introduced in **Next v15.0.0**; `register()` on 14.2.x requires `experimental.instrumentationHook = true` | nextjs.org version-history table + the 14.2.35 instrumentation doc |
| Coverage ratchet: lines 45 / functions 67 / branches 79 / statements 45 | `hub/vitest.config.ts:46-51` |