# Wave-1 Verification — Remaining Audit P0/P1 Claims vs `master` (2026-07-05)

Read-only verification of the five 2026-06-17 audit claims that had not yet been
spot-checked, performed against `origin/master` (post fix PRs #41–#48). Companion
to `DESIGN_CONTEXT_2026-07-05.md` (which records the three earlier verifications:
webhook auth, embeddings auth, reduced-motion — all already fixed/secure).

**Net result: the audit is substantially stale. Three of five claims are already
fixed. Remaining genuine security work for Wave 1 is listed at the bottom.**

---

## 1. P0-1 — Paperclip proxy role gating — **ALREADY FIXED**

- Server-side role tiering exists: `hub/lib/proxyAuthz.ts:31 requiredWriteRank()`
  maps method+path → rank, enforced in the catch-all route (`route.ts:135-141`,
  `403` when `ROLE_RANK[role] < requiredRank`) for every mutation.
- Tiers: PATCH issue/agent, POST create-agent, POST/DELETE company, DELETE issue
  → `admin`; DELETE agent → `superadmin` (`proxyAuthz.ts:43-59`); POST /api/issues
  → `staff` **plus HMAC gate-token verification** (`route.ts:157-170`).
- A `staff` user can only create issues; PATCH/reassign/restart/create-agent 403.
- Direct `:id` routes do **not** bypass checks: GET-then-verify company-scope
  precheck on PATCH/DELETE (`route.ts:191-231`) + GET post-check (`route.ts:329-350`).
- Covered by `proxyAuthz.test.ts`.

## 2. P1-2 — Auth resilience — **PARTIALLY FIXED** (remainder is real work)

- Fixed core: `hub/lib/auth.ts:70` drops the dead token on refresh failure
  (`accessToken: undefined`, `error: 'RefreshAccessTokenError'`);
  `resolveGoogleAuth()` (`google-session.ts:80`) checks both missing token and
  `token.error`, returning `401 {reauth:true}`; `googleApiErrorResponse` maps
  upstream 401/403 → reauth.
- Routes already on the fixed path: **tasks, calendar, gmail, drive**.
- **Still open:** `google/chat/messages|members|readstate|spaces|unread`,
  `app/api/chat/route.ts:195`, and `kpis/sync/route.ts:77` use `getToken`
  directly, never check `token.error`, and surface upstream Google 401s as
  opaque 500s. **Minimal fix:** route them through `resolveGoogleAuth` +
  `googleApiErrorResponse`.

## 3. P1-3 — Paperclip data model — **ALREADY FIXED**

- `assigneeUserId` is threaded: `paperclip.ts:118-131 normalizeIssue()` sets
  `assigneeUserId`, `assigneeType`, and `assigneeId = assigneeAgentId ?? assigneeUserId`.
- Runs aggregation is correct (per-issue `/api/issues/:id/runs`, per-issue
  try/catch, no company-level 404 risk); comments at `paperclip.ts:29-31` accurate.
- The stale "child workspace" framing in `paperclipConfig.ts` is gone.

## 4. P1-4 — Zod strictness — **STILL OPEN**

- On schema mismatch `paperclipFetch` logs a warning and returns the **raw
  unvalidated payload** (`paperclip.ts:~223 → return json as T`).
- Schemas are `.passthrough()` + `z.union([bare, wrapped])` — unknown shapes
  silently accepted.
- List endpoints swallow failures to `[]` (`pickArray()` at `paperclip.ts:49-56`;
  `getRuns` per-issue catch) — callers cannot distinguish empty-from-error.
- **Minimal fix:** list helpers throw (or return a discriminated result) on parse
  failure; alert on schema drift instead of degrading silently.

## 5. P1-6 — delete_agent tier + assigneeId — **(a) FIXED / (b) STILL OPEN**

- (a) Aligned: `interview.ts:41 delete_agent: 'superadmin'` matches
  `proxyAuthz.ts:45` (test-asserted: admin → false, superadmin → true).
- (b) **Open:** `executeAction.ts:157-176` resolves the COO agent client-side and
  posts `assigneeId`; the server (`issues/route.ts:66,104-105,130`) passes
  `bodyAssigneeId` into `createIssue` **without validating it belongs to the
  target company** — a caller can assign an issue to any arbitrary agent id.
- **Minimal fix:** after resolving `companyId`, verify
  `bodyAssigneeId ∈ getAgents(companyId)` (or reject) before use.

---

## Remaining Wave-1 security work (post-verification)

| Item | Scope | Size |
|---|---|---|
| **#1 send gate (Option B — decided)** | Google send routes verify the existing signed `gateToken` (intent-bound) for AI-originated sends; `executeAction` threads `X-Gate-Token`. Manual composer sends unchanged. | S–M |
| **P1-2 remainder** | Migrate google `chat/*` routes + `kpis/sync` (+ chat route's context fetch) to `resolveGoogleAuth`/`googleApiErrorResponse`. | S |
| **P1-4** | Strict list validation in `paperclipFetch`; distinguish empty-from-error. | M |
| **P1-6b** | Server-side `assigneeId ∈ company agents` validation on issue create. | S |
| **#16 limiter** | In flight (recovery of the June-16 spec). | S |

Do **not** schedule work against P0-1, P1-3, P1-6a, webhook auth, embeddings
auth, or reduced-motion — all verified fixed/secure on current `master`.
