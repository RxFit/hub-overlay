# HUB Overlay — IDE Task Backlog

Hand-off backlog for an AI coding agent (Cursor / Copilot / Windsurf). Each task is
self-contained: **why**, **files**, **steps**, **acceptance**. Work top-down; the
verification task (V1) is the gate before any deploy.

**Status (reviewed against disk):** the 3-PR remediation pass AND most of the deferred
hardening have landed. Multi-tenancy Phase 1 is live (host-derived `x-tenant-id` in
`middleware.ts`, `getTenantId()` adopted across ~11 sites). The proxy now verifies issue
ownership (M3 core), the loop-detector is per-scope and the proxy passes a scope (M2 core),
and the leaked credential + `debug-auth` are gone from HEAD. Remaining items are marked
**OPEN**; finished ones are marked **DONE** for context.

Repo root for the app: `hub/`. Test: `npm test` (vitest). Typecheck: `npx tsc --noEmit`.
Run on your synced local checkout (ignore the cloud-mount truncation note from earlier sessions).

---

## A — Verify & ship (do first)

### V1. Full-repo green gate — **OPEN (authoritative gate)**
**Why:** Multi-tenancy changes were merged on top of remediation; confirm the whole tree
compiles and tests pass. This is the check that could not be run from the cloud mount.
**Steps:**
1. `cd hub && npm ci`
2. `npx tsc --noEmit` — must exit 0.
3. `npm test` — all vitest suites green (≥30 tests, incl. `lib/loop-detector.test.ts`
   per-scope isolation and `lib/content-fetch.test.ts` SSRF).
4. `npm run build` — Next build succeeds.
**Acceptance:** all four pass. Any errors now are real (not mount artifacts) — fix them.

### V2. Smoke-test the landed fixes — **OPEN (needs running app)**
**Why:** Everything was verified statically; nothing clicked through a browser.
**Steps:** Follow `DEPLOY_AND_VERIFY_RUNBOOK.md` Part 5: API 401 (not redirect), security
headers, chat streams with no 2s stall, KPI tenant scoping, Gmail header-injection rejected,
SSRF blocked, founder-lens persists, safety gate blocks + fails closed, artifact role scoping,
workspace-creation gate.
**Acceptance:** every Part-5 row behaves as its ✅ note describes.

---

## B — Hardening (mostly landed; finish the edges)

### M2. Per-scope loop-detector & breaker — **MOSTLY DONE**
- DONE: `lib/loop-detector.ts` takes a `scope`; `app/api/paperclip/[...path]/route.ts`
  passes one (`loopScope`); per-scope isolation test passes.
- **OPEN (low):** `lib/paperclip.ts` (~line 172) server-side path still calls
  `detectAndRecord(method, path, body)` with no scope (shares `__global__`). Decide if that
  server path needs per-caller scoping or is intentionally global, and add a one-line comment
  recording the decision.
- **OPEN (low):** `lib/circuit-breaker.ts` `breaker` is still one global instance. Decide
  global (protects upstream — defensible) vs per-tenant (`${tenantId}:${key}`); document it.
**Acceptance:** decision documented in-code; tests green.

### M3. Paperclip proxy scope-escape — **MOSTLY DONE, finish the sweep**
- DONE: proxy rejects unscoped endpoints and verifies issue ownership against
  `assignedProjects` (`app/api/paperclip/[...path]/route.ts`).
- **OPEN (medium):** confirm the remaining allowlisted prefixes are scoped the same way:
  `/api/agents/<id>`, `/api/runs`, `/api/projects/<id>`. For each, a staff user assigned to
  company A must get 403 reaching company B's resource by id.
**Acceptance:** no allowlisted path lets a scoped user reach another tenant's data; add a
test or a documented manual check.

### C2 / L4. Tenant threading — **MOSTLY DONE, close background paths**
- DONE: `getTenantId()` from `lib/tenant-context` is used across route handlers;
  `userRoles.ts` reads tenant from request context; residual `'rxfit'` strings are legit
  (host-map default, white-label config, a search keyword, doc comments).
- **OPEN (medium):** `getTenantId()` falls back to `'rxfit'` when there is no request header.
  Background/cron/webhook paths (e.g. `app/api/kpis/sync`, `app/api/webhooks/google`,
  `app/api/embeddings/upsert`, the prune jobs in `lib/agent-memory.ts`) have no header and
  will silently default. Make these require an explicit `tenantId` argument instead of
  defaulting — a no-header context should be a hard error or an explicit per-tenant loop,
  never a silent `'rxfit'`.
**Acceptance:** `grep -rn "|| 'rxfit'" hub/app hub/lib` shows only the host-map/config defaults;
no data query resolves tenant from a silent fallback in a background job.

---

## C — Security hygiene

### S1. Purge the leaked DB credential from git history — **OPEN (high)**
**Why:** Removed from HEAD but still in history.
**Steps:** Rotate first (Ops O1) → `git filter-repo --replace-text` or BFG to scrub the
connection string from all commits → force-push → collaborators re-clone.
**Acceptance:** `git log -p | grep "metro.proxy.rlwy.net"` returns nothing.

### S2. Repo-wide secret sweep — **OPEN (medium)**
**Steps:** `gitleaks detect` (+ history) / `trufflehog`. Manually confirm
`GOOGLE_SERVICE_ACCOUNT_KEY`, `PAPERCLIP_AUTH_PASSWORD`, `STRIPE_SECRET_KEY`,
`NEXTAUTH_SECRET` are never logged or returned in responses.
**Acceptance:** scanner clean; no secret in logs/responses.

---

## D — Refactors & follow-ups (lowest urgency)

### L6. Decompose `app/page.tsx` (2,300+ lines) — **OPEN (optional)**
Extract incrementally, verifying after each: (1) action `switch` →
`lib/actions/executeAction.ts`; (2) swipe logic → `app/hooks/useSwipePanels.ts`;
(3) `MessageContent`/`parseInlineMarkdown` → `app/components/MessageContent.tsx`.
**Acceptance:** behavior unchanged (re-run V2 chat/interview/swipe); tsc + tests green.

### L1-follow. Content-Security-Policy — **OPEN (optional)**
Nonce-based CSP via `middleware.ts`, start `Content-Security-Policy-Report-Only`, exercise,
then enforce. **Acceptance:** report-only with no violations, then enforced.

---

## E — Manual / operational (a human must do these — NOT the IDE agent)

### O1. Rotate the exposed Railway Postgres credential — **OPEN (blocking)**
Regenerate the DB password in Railway; update `DATABASE_URL` on the hub service. Blocks S1
and any safe deploy.

### O2. Run the founder-lens migration on deploy — **OPEN**
`node hub/drizzle/migrate.mjs` with the rotated `DATABASE_URL` (idempotent). Verify
`SELECT to_regclass('public.founder_lens_sections')` is non-null.

### O3. Verify env vars — **OPEN**
Cross-check `DEPLOY_AND_VERIFY_RUNBOOK.md` Part 2 against Railway. `NEXT_PUBLIC_TENANT_ID`
is build-time; for true multi-tenant, the host-derived `x-tenant-id` path must fully
supersede it.

---

## Priority order
1. **O1** (rotate) → **V1** (green gate) → **O2** (migrate) — unblock a safe deploy.
2. **S1** (purge history) — once rotated.
3. **M3** sweep + **C2/L4** background-path fix — finish hardening alongside MT work.
4. **V2** smoke tests, then ship.
5. **S2** secret sweep.
6. **M2** edges, **L6**, **CSP** — lowest urgency.
