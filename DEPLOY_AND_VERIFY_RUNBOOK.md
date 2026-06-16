# HUB Overlay — Deploy & Verification Runbook

Use this to ship the three remediation PRs safely and confirm each fix in the live app.
Work top to bottom. Don't skip Part 1.

---

## Part 1 — Rotate the exposed DB credential (do this FIRST)

The old `migrate.mjs` shipped a live Railway Postgres password as a fallback. It was in
the repo and its git history, so it must be treated as compromised.

1. In Railway → Postgres service → **Connect / Variables**, regenerate the database
   password (or rotate the service). Copy the new connection string.
2. Update `DATABASE_URL` in the **hub** service variables to the new string.
3. Confirm the secret is gone from code and that the script now refuses to run blind:
   ```bash
   git log -p -- hub/drizzle/migrate.mjs | grep -i "postgresql://" || echo "clean"
   # Locally, with no DATABASE_URL set:
   node hub/drizzle/migrate.mjs   # must print "DATABASE_URL is not set" and exit 1
   ```
4. (Recommended) Purge the secret from history with `git filter-repo`/BFG, or rotate
   anything else that ever shared that database.

---

## Part 2 — Environment variables

Set these in the Railway **hub** service. Grouped by what breaks if missing.

### Required — app will not function without these
| Var | Purpose |
|-----|---------|
| `DATABASE_URL` | Postgres connection (rotated in Part 1) |
| `NEXTAUTH_SECRET` | NextAuth JWT signing — also used by middleware `getToken` |
| `NEXTAUTH_URL` | Canonical app URL for OAuth callbacks |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth (login + Workspace APIs) |
| `NEXT_PUBLIC_TENANT_ID` | Active tenant (currently `rxfit`). **Build-time** — must be set before `next build` |

### Roles
| Var | Purpose |
|-----|---------|
| `SUPERADMIN_EMAILS` | Comma-separated env-level superadmins (bypass DB) |
| `ADMIN_EMAILS` | Comma-separated env-level admins |

### AI / chat
| Var | Purpose |
|-----|---------|
| `GEMINI_API_KEY` *(or `GOOGLE_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY`)* | Gemini for chat, intent detection, context cards, scoring. Fallback chain now honored everywhere |
| `EXA_API_KEY` | Exa web search |

### Paperclip orchestration
| Var | Purpose |
|-----|---------|
| `PAPERCLIP_BASE_URL` | Paperclip API base |
| `PAPERCLIP_AUTH_EMAIL` / `PAPERCLIP_AUTH_PASSWORD` | Session auth (primary) |
| `PAPERCLIP_API_KEY` | Bearer fallback if session auth fails; also gates `/api/embeddings` |
| `DEFAULT_PAPERCLIP_COMPANY_ID` | Default company for issues / secrets |
| `NEXT_PUBLIC_PAPERCLIP_URL` | Deep-link base shown in the UI |

### Semantic brain (Vertex AI Search)
| Var | Purpose |
|-----|---------|
| `GOOGLE_SERVICE_ACCOUNT_KEY` | GCP service-account JSON (string) |
| `VERTEX_GCP_PROJECT` / `VERTEX_ENGINE_ID` | Vertex Search engine target |

### KPI sources (optional — sync degrades gracefully if absent)
`GA4_PROPERTY_ID`, `STRIPE_SECRET_KEY`, `GSC_SITE_URL`

### Webhooks & cron
| Var | Purpose |
|-----|---------|
| `GOOGLE_WEBHOOK_CHANNEL_TOKEN` | Verifies inbound Google push notifications |
| `CRON_SECRET` | Constant-time auth for the KPI sync cron |

### Tuning (optional)
`SIMILARITY_THRESHOLD` (default 0.65), `SKILLS_BASE_PATH`, `LOG_LEVEL`, `NODE_ENV`

> Note: every server path still resolves the tenant from `NEXT_PUBLIC_TENANT_ID`, a
> build-time public var — so one deployment serves exactly one tenant. That's the
> multi-tenancy rework (C2) tracked separately; nothing in this runbook changes it.

---

## Part 3 — Run the migration

The new Founder Lens feature needs its table. `migrate.mjs` is idempotent (safe to re-run).

```bash
# from the hub/ directory, with DATABASE_URL set to the rotated value
node drizzle/migrate.mjs
# expect: "✓ founder_lens_sections table" and "✅ Done"
```

Verify the table exists:
```sql
SELECT to_regclass('public.founder_lens_sections');  -- should not be null
```

---

## Part 4 — Deploy

1. Merge the three PRs (security fixes, H-tier, hardening+tests).
2. Confirm CI is green: `npm run build`, `npx tsc --noEmit`, `npm test` (29 tests).
3. Deploy the hub service. Watch logs for a clean boot (no "DATABASE_URL is not set",
   no Gemini key errors).

---

## Part 5 — Smoke tests (verify each fix in the live app)

Run as a normal staff user unless noted. ✅ = expected result.

**C1 — credential** · `node drizzle/migrate.mjs` with no `DATABASE_URL` ✅ exits 1, no connection string in output.

**M6 — API returns 401, not a redirect** ·
```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<host>/api/companies   # ✅ 401 (not 302)
```

**L1 — security headers** ·
```bash
curl -sI https://<host>/ | grep -iE "strict-transport|x-frame-options|x-content-type|referrer-policy"
# ✅ all present; ✅ no "x-powered-by"
```

**M1 — chat model** · Send a chat message. ✅ Streams a reply with no ~2s stall and no
"Primary model unavailable" banner (the old invalid `gemini-3.5-flash` is gone).

**L3 — search routing** · Ask "I have an hour to spare" then "what are our KPIs". ✅ The
first does **not** trigger internal search; the second does (check server logs / latency).

**C3 — KPI tenant scoping** · As a non-admin, open the KPI settings. ✅ Only this tenant's
staff-visible KPIs appear (no cross-tenant rows once a 2nd tenant exists).

**C4 — Gmail header injection** · In a send, put `victim@x.com%0aBcc: evil@x.com` style
text in the recipient. ✅ Rejected with "Invalid recipient address"; no hidden Bcc.

**H5 — SSRF** · Attach a URL like `http://169.254.169.254/` or `http://localhost/` in chat.
✅ "Blocked: requests to internal or private network addresses are not allowed".

**H1 — Founder Lens persistence** · Open the C-Suite wizard, save custom sections, reload.
✅ Values persist (now in Postgres, not the missing filesystem path).

**H3 — Safety gate** · Start a high-stakes interview (e.g. send_communication) and give
thin answers. ✅ Below 80% it blocks with a real follow-up question (no literal "null").
Temporarily break the Gemini key and retry a destructive intent ✅ it fails **closed**
(blocks), not open.

**H4 — Artifact scoping** · As onboarding ✅ no tool artifacts returned. As staff ✅ only
your own artifacts; as admin ✅ all.

**H6 — Workspace creation** · As staff, attempt create-workspace ✅ 403. As admin ✅ allowed.

---

## Part 6 — Rollback

Each PR is independent. If a smoke test fails:
- Revert that PR's commit and redeploy. The migration is additive and idempotent —
  no rollback needed for the `founder_lens_sections` table.
- The middleware change (M6) is the only one that affects every route; if auth behaves
  oddly, that's the first suspect — revert `middleware.ts` alone.
