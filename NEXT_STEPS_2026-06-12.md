# HUB Overlay — Next Steps (what YOU need to do)

**Date:** 2026-06-12 · Owner actions called out explicitly. This is the human-run
counterpart to `IDE_TASK_BACKLOG.md` (which is for your IDE agent). Do the phases in order —
each one gates the next.

---

## Where the project stands

Three remediation PRs plus most of the deferred hardening have landed and are present on
disk. Verified this session:

- **Security fixes shipped:** DB credential removed from `migrate.mjs`, `debug-auth`
  deleted, cross-tenant KPI leak fixed, Gmail header-injection closed, SSRF guard hardened,
  founder-lens moved to Postgres, API routes return 401 (not redirect), security headers
  added, invalid Gemini model id fixed, search-routing false positives removed.
- **Hardening largely done:** loop-detector is now per-scope and the proxy passes a scope;
  the Paperclip proxy verifies issue ownership; multi-tenancy Phase 1 is live (host-derived
  `x-tenant-id`, `getTenantId()` threaded through the data layer).
- **Tests:** 30 unit tests green; the remediation PR tree typechecks clean in isolation.

What's left is mostly **operational** (yours) plus a few **edge-case** code tasks for the IDE.
The one thing that could NOT be verified from here is a full-repo `tsc`/`test`/`build` —
because the cloud mount truncates files — so that's your first real gate.

---

## PHASE 1 — Unblock a safe deploy (do today, in this order)

### 1.1  Rotate the database credential  🔴 CRITICAL
The old `migrate.mjs` shipped a live Railway Postgres password. It is out of HEAD but is
**still in git history**, so treat it as compromised.
- Railway → Postgres → regenerate the password (or rotate the instance).
- Update `DATABASE_URL` on the **hub** service with the new connection string.
- Anything else that ever used that DB/password: rotate too.

### 1.2  Run the green gate locally  🔴 CRITICAL
On your synced machine (not the cloud mount):
```bash
cd hub
npm ci
npx tsc --noEmit      # must exit 0
npm test              # all vitest suites green (≥30 tests)
npm run build         # Next build succeeds
```
This is the authoritative check. With the multi-tenancy work merged, any error here is
**real**. Fix before deploying. If you want, hand failures to your IDE agent with task V1
from the backlog.

### 1.3  Run the database migration
With the rotated `DATABASE_URL` set:
```bash
node hub/drizzle/migrate.mjs        # idempotent; safe to re-run
```
Confirm the founder-lens table exists:
```sql
SELECT to_regclass('public.founder_lens_sections');   -- must be non-null
```

### 1.4  Verify environment variables
Cross-check the full env table in `DEPLOY_AND_VERIFY_RUNBOOK.md` (Part 2) against the
Railway hub service. Critical ones: `DATABASE_URL` (rotated), `NEXTAUTH_SECRET`,
`NEXTAUTH_URL`, `GOOGLE_CLIENT_ID/SECRET`, a Gemini key, and `NEXT_PUBLIC_TENANT_ID`
(**build-time** — must be set before `next build`).

---

## PHASE 2 — Deploy & confirm

### 2.1  Deploy
Merge the PRs and deploy the hub service. Watch logs for a clean boot — no
"DATABASE_URL is not set", no Gemini key errors.

### 2.2  Smoke-test (runbook Part 5)
Walk every check against the live app. The highest-value ones to actually try:
- `curl -I https://<host>/` → HSTS / X-Frame-Options / nosniff present, no `x-powered-by`.
- `curl -s -o /dev/null -w "%{http_code}" https://<host>/api/companies` while logged out → **401**.
- Send a chat message → streams with no ~2s stall.
- Try a Gmail send with `a@x.com\r\nBcc: b@x.com` in the recipient → **rejected**.
- Attach `http://169.254.169.254/` in chat → **blocked**.
- Save the Founder Lens wizard, reload → values persist.
- Start a high-stakes interview with thin answers → blocks with a real follow-up (not "null").

### 2.3  Purge the credential from git history  🔴 (after rotation)
```bash
# rotate FIRST (1.1), then:
git filter-repo --replace-text <(echo "postgresql://postgres:OLDPASS@metro.proxy.rlwy.net:39263/railway==>REDACTED")
git push --force            # coordinate with collaborators; they must re-clone
```
Verify: `git log -p | grep "metro.proxy.rlwy.net"` returns nothing.

---

## PHASE 3 — Finish the hardening (hand to IDE agent, then review)

These intersect your multi-tenancy work — coordinate so you're not editing the same files
in two places. Full specs are in `IDE_TASK_BACKLOG.md`.

1. **Background-path tenant safety (C2/L4).** `getTenantId()` silently falls back to
   `'rxfit'` when there's no request header. Cron/webhook/prune jobs
   (`api/kpis/sync`, `api/webhooks/google`, `api/embeddings/upsert`,
   `lib/agent-memory` prune fns) must take an explicit `tenantId` — a no-header context
   should never default. *This is the last real multi-tenancy correctness gap.*
2. **Finish the proxy scope sweep (M3).** Issue ownership is checked; confirm
   `/api/agents/<id>`, `/api/runs`, `/api/projects/<id>` reject cross-tenant access too.
3. **Secret sweep (S2).** Run `gitleaks`/`trufflehog` on repo + history; confirm no secret
   is logged or returned in a response.
4. **Document the M2 decisions.** Note in-code whether the `lib/paperclip.ts` server path
   and the circuit breaker are intentionally global vs per-tenant.

---

## PHASE 4 — Optional polish (no urgency)

- **Decompose `app/page.tsx`** (2,300+ lines) into smaller components/hooks — do it with the
  app running so you can click through chat/interview/swipe after each extraction.
- **Add a Content-Security-Policy** (nonce-based, report-only first). The only security
  header deliberately deferred.

---

## Quick reference — open items by owner

| Item | Owner | Urgency |
|------|-------|---------|
| Rotate DB credential (1.1) | You | 🔴 now |
| Green gate tsc/test/build (1.2) | You (or IDE) | 🔴 now |
| Run migration (1.3) | You | 🔴 now |
| Env var check (1.4) | You | 🔴 now |
| Deploy + smoke test (2.1–2.2) | You | high |
| Purge git history (2.3) | You | high (after rotate) |
| Background-path tenant safety | IDE agent | medium |
| Proxy scope sweep (M3 finish) | IDE agent | medium |
| Secret sweep | IDE agent | medium |
| page.tsx / CSP | IDE agent | low |

**Bottom line:** the code is in good shape — security-critical work and multi-tenancy
Phase 1 are done and verified to the extent possible from here. The gating work now is
operational: rotate the credential, run `tsc`/`test`/`build` locally, migrate, deploy,
smoke-test, then purge history. The remaining code tasks are edge-case hardening, not
blockers.
