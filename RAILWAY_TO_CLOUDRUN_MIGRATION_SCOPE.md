# Railway → Google Cloud Run Migration — Scope of Work

Prepared 2026-06-12. Based on evidence in this repo + the live Cloud Run health check.

---

## 1. What runs where TODAY (the direct answer)

**The Hub itself is NOT on Cloud Run — it is 100% Railway.** The Cloud Run piece is
its Paperclip backend. Full topology:

| Component | Platform | Evidence |
|---|---|---|
| **Hub web app** (Next.js chat interface) | **Railway** — `hub-production-a923.up.railway.app`, domain `hub.casatrejo.com` | `NEXTAUTH_URL`, `BETTER_AUTH_TRUSTED_ORIGINS` |
| **Hub Postgres** (pgvector: embeddings, events, KPIs) | **Railway** Postgres | `DATABASE_URL`/`DATABASE_PUBLIC_URL` pattern in `drizzle.config.ts` |
| **Paperclip — production** | **Google Cloud Run** — `rxfit-paperclip-11747747730.us-central1.run.app` (live, verified) | `PAPERCLIP_BASE_URL`; the Hub's issues land here |
| **Paperclip — second deployment** | **Railway** — `paperclip-production-4394` + its own Railway Postgres | `railway/paperclip/` |
| **Paperclip — local** | Your PC (`127.0.0.1:3100`, watchdog scripts) | `scripts/paperclip/`, AGENTS.md |
| Vertex AI Search, Gemini, Google OAuth/Workspace | **Already GCP** (`semantic-brain-desktop` project) | env vars |

So the migration is: move the **Hub app + Hub Postgres** off Railway, and decide the
fate of the **redundant Railway Paperclip**. Most of your stack's gravity (Vertex,
Gemini, OAuth, Paperclip prod) is already on Google — consolidation is sensible.

---

## 2. Scope of work

### WS1 — Hub web app → Cloud Run (~half a day)
The Dockerfile is already portable (node:20-slim, `npm start`, port 3000). Steps:

1. Create an Artifact Registry repo; build & push via Cloud Build
   (`gcloud builds submit --tag us-central1-docker.pkg.dev/<project>/hub/hub:v1` from `hub/`).
2. Move secrets (`NEXTAUTH_SECRET`, `GOOGLE_CLIENT_SECRET`, `GEMINI_API_KEY`,
   `EXA_API_KEY`, `PAPERCLIP_AUTH_*`, `GOOGLE_SERVICE_ACCOUNT_KEY`, `DATABASE_URL`)
   into **Secret Manager**; reference them in the service definition.
3. Deploy Cloud Run service: port 3000, 1 GiB RAM, min-instances 1 (avoids cold-start
   on the SSE chat route), **request timeout ≥ 300 s** — the chat route streams SSE
   with `maxDuration 120`; Cloud Run streams fine but the default 300 s timeout must
   not be lowered.
4. Keep `NEXTAUTH_URL=https://hub.casatrejo.com` — Google OAuth redirect URIs don't
   change because the domain doesn't change.

### WS2 — Hub Postgres → Cloud SQL (~half a day)
1. Create Cloud SQL for PostgreSQL (16), smallest tier; run
   `CREATE EXTENSION vector;` — pgvector is supported and required
   (`lib/vector-store.ts` uses `<=>` similarity).
2. Migrate: `pg_dump` from Railway via `DATABASE_PUBLIC_URL` → `pg_restore` into
   Cloud SQL. The schema is small (chunks/embeddings, event log, KPI cache) — minutes.
3. Point the Hub's `DATABASE_URL` at Cloud SQL (use the Cloud SQL connector or
   private IP + VPC connector).
4. **Cost note:** Cloud SQL's floor (~$10–30/mo) is likely higher than Railway
   Postgres. Acceptable trade for one-platform ops; flagging it.

### WS3 — Retire the redundant Railway Paperclip (~1–2 h)
You said it "should work," and I've fixed its `publicBaseUrl` (was pointing at the
Cloud Run URL — broken sign-in/CORS) and stripped the committed DB credential. But
post-migration it's a third copy of Paperclip with its own Postgres and **no data
sync** to production. Recommendation: once everything else is on GCP, export anything
historical from its Railway Postgres, then delete the service + DB and archive
`railway/`. Keeping it as a "warm standby" is illusory — its database diverges from
production from day one.

### WS4 — Harden the existing Cloud Run Paperclip (~half a day, mostly discovery)
It's already on GCP but two things need verification before it's trusted as the
single production instance:

1. **Storage:** if its config uses `local_disk` like the Railway copy, uploaded
   files/attachments **vanish on every revision restart** (Cloud Run filesystems are
   ephemeral). Paperclip supports S3-compatible storage — use GCS with HMAC interop
   keys.
2. **Database:** confirm it runs on Cloud SQL (or at least external Postgres), not
   embedded Postgres — embedded on Cloud Run would mean total data loss on restart.
   If it's been stable since 2026-05-29, it's probably external; verify anyway.
3. Map the pending custom domain `api.paperclip.casatrejo.com` (env comment says
   it's planned), then update `PAPERCLIP_BASE_URL`, `NEXT_PUBLIC_PAPERCLIP_URL`,
   and trusted-origins lists in one commit.
4. Pin the version: deploy `paperclipai@2026.609.0` explicitly so the API contract
   (which the Hub fixes now depend on) can't drift silently.

### WS5 — Cutover & rollback (~2 h + DNS propagation)
1. Migrate DB (WS2) during a quiet window; deploy Hub to Cloud Run pointed at it.
2. Smoke-test on the `*.run.app` URL (login, chat, issue creation, feed).
3. Flip `hub.casatrejo.com` DNS from Railway to the Cloud Run domain mapping.
4. Pause (don't delete) the Railway Hub service for one week as instant rollback,
   then delete it and the Railway Postgres.

---

## 3. Totals

| Item | Estimate |
|---|---|
| WS1 Hub service | 0.5 day |
| WS2 Hub database | 0.5 day |
| WS3 Railway Paperclip retirement | 1–2 h |
| WS4 Cloud Run Paperclip hardening | 0.5 day (incl. discovery) |
| WS5 Cutover | 2 h + DNS |
| **Total** | **~2–2.5 focused days** |

**Prerequisites:** GCP project with billing (you have `semantic-brain-desktop`;
decide whether the Hub lives there or in a dedicated project), `gcloud` CLI,
a quiet window for the DB cutover.

**Main risks:** pgvector data fidelity on restore (verify row counts + one search
query), SSE timeout config, Cloud SQL cost floor, and the WS4 unknowns about the
existing Cloud Run Paperclip's storage/database — those should be checked **first**
since they affect whether it can even be the consolidation target.

---

## 4. Already done in this session
- Stripped the live Postgres credential from `railway/paperclip/config.json`
  (verified safe: server code prefers `DATABASE_URL` env, and `connectionString`
  is optional in Paperclip's config schema). **You still must rotate that password
  in Railway — it's been exposed in the repo.**
- Fixed `auth.publicBaseUrl` in the same file to the Railway URL so that deployment
  actually works until it's retired.
